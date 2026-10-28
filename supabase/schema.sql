-- ════════════════════════════════════════════════════════════════════════════
-- One Word Story: full database schema (Supabase / Postgres 17)
--
-- A snapshot of the live database, generated from the system catalogs on
-- 2026-10-28. It is the single place to read how the backend works:
--   1. Tables and constraints
--   2. Row Level Security: the browser may READ only the games it belongs to,
--      and may not write to any game table directly
--   3. Game rules as SECURITY DEFINER functions (the only way to change a game)
--   4. Triggers (new-user profiles, push notifications)
--   5. Scheduled jobs (pg_cron), realtime, avatar storage
--
-- The numbered files in supabase/migrations/ are the later incremental changes
-- as they were applied; everything they create is included here.
--
-- To build a fresh copy: run this file in the SQL editor of a new Supabase
-- project (extensions pg_cron, pg_net and supabase_vault enabled), then replace
-- the project URL and publishable key in section 5 and in _push_notify().
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ─── 1. TABLES ──────────────────────────────────────────────────────────────

-- One row per user, created automatically on sign-up (see handle_new_user)
create table public.profiles (
  id          uuid primary key references auth.users (id),
  username    varchar not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  avatar_url  text,
  created_at  timestamptz default now()
);
create unique index profiles_username_lower_idx on public.profiles (lower(username));

create table public.games (
  id                       uuid primary key default gen_random_uuid(),
  name                     varchar not null,
  created_by               uuid references public.profiles (id),
  status                   varchar default 'active',          -- 'active' | 'completed'
  current_turn_user_id     uuid references public.profiles (id),
  turn_deadline            timestamptz,
  turn_time_limit_seconds  integer not null default 86400
                           check (turn_time_limit_seconds between 10 and 604800),
  turn_time_limit_hours    integer not null default 24,       -- legacy, kept in sync by trigger
  word_count               integer not null default 0,
  consecutive_skips        integer not null default 0,        -- story ends after 2 quiet cycles
  completed_at             timestamptz,
  created_at               timestamptz default now()
);

create table public.game_players (
  game_id       uuid not null references public.games (id),
  user_id       uuid not null references public.profiles (id),
  player_order  integer not null,
  joined_at     timestamptz default now(),
  left_at       timestamptz,       -- left the story (can rejoin while it is active)
  archived_at   timestamptz,       -- per-player: moved to "Archive"
  deleted_at    timestamptz,       -- per-player: hidden from "my stories"
  primary key (game_id, user_id),
  constraint game_players_game_order_unique unique (game_id, player_order)
);
create index idx_game_players_user on public.game_players (user_id);

create table public.story_words (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid references public.games (id),
  user_id       uuid references public.profiles (id),
  word_text     varchar not null,
  word_order    integer not null,
  bold          boolean not null default false,
  italic        boolean not null default false,
  break_before  text not null default 'none' check (break_before in ('none', 'line', 'para')),
  created_at    timestamptz default now(),
  unique (game_id, word_order)
);

-- Web Push subscriptions, one per device. No policies: only server functions touch it.
create table public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);


-- ─── 2. ROW LEVEL SECURITY ──────────────────────────────────────────────────
-- Signed-in users can SELECT; nobody can INSERT/UPDATE/DELETE game data directly.
-- The only column a user may write is their own profiles.avatar_url.

alter table public.profiles           enable row level security;
alter table public.games              enable row level security;
alter table public.game_players       enable row level security;
alter table public.story_words        enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.profiles, public.games, public.game_players, public.story_words,
              public.push_subscriptions from anon, authenticated;
grant select on public.profiles, public.games, public.game_players, public.story_words to authenticated;
grant update (avatar_url) on public.profiles to authenticated;

-- Membership checks run as definer so policies don't recurse into game_players' own policy
create or replace function public.is_game_member(gid uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from game_players where game_id = gid and user_id = auth.uid());
$$;

create or replace function public.is_game_player(gid uuid)   -- older alias, kept for compatibility
 returns boolean language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from game_players where game_id = gid and user_id = auth.uid());
$$;

create policy "Signed-in users can view profiles" on public.profiles
  for select to authenticated using (true);
create policy "Users update own profile" on public.profiles
  for update using (auth.uid() = id);
create policy "Members or creator can view games" on public.games
  for select using (is_game_member(id) or created_by = auth.uid());
create policy "View players in your games" on public.game_players
  for select using (is_game_member(game_id));
create policy "View words in your games" on public.story_words
  for select using (is_game_member(game_id));


-- ─── 3. GAME RULES (server functions) ───────────────────────────────────────
-- Every function checks who is calling (auth.uid()) and locks the game row
-- (SELECT ... FOR UPDATE) so two players acting at once can't corrupt turn order.

-- Next active player after `after_uid`, wrapping around to the first
create or replace function public._next_player(gid uuid, after_uid uuid)
 returns uuid language sql stable set search_path to 'public'
as $$
  select coalesce(
    (select user_id from game_players
       where game_id = gid and left_at is null
         and player_order > coalesce((select player_order from game_players
                                       where game_id = gid and user_id = after_uid), -1)
       order by player_order limit 1),
    (select user_id from game_players
       where game_id = gid and left_at is null order by player_order limit 1));
$$;

-- Skip an expired turn. After two full cycles with no word, the story ends itself.
create or replace function public._advance_game(p_game uuid)
 returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare g public.games%rowtype; nxt uuid; n int; skips int;
begin
  select * into g from games
   where id = p_game and status = 'active' and turn_deadline < now()
   for update skip locked;
  if not found then return false; end if;
  nxt := _next_player(p_game, g.current_turn_user_id);
  if nxt is null then return false; end if;
  select count(*) into n from game_players where game_id = p_game and left_at is null;
  skips := g.consecutive_skips + 1;
  if skips >= 2 * n then
    update games set status = 'completed', completed_at = now(), consecutive_skips = skips
     where id = p_game;
  else
    update games
       set current_turn_user_id = nxt,
           turn_deadline = now() + make_interval(secs => turn_time_limit_seconds),
           consecutive_skips = skips
     where id = p_game;
  end if;
  return true;
end $$;

-- Run every minute by pg_cron
create or replace function public.advance_expired_turns()
 returns integer language plpgsql security definer set search_path to 'public'
as $$
declare gid uuid; cnt int := 0;
begin
  for gid in select id from games where status = 'active' and turn_deadline < now() loop
    if _advance_game(gid) then cnt := cnt + 1; end if;
  end loop;
  return cnt;
end $$;

-- Called by the app when a player's countdown hits zero, so they don't wait for cron
create or replace function public.advance_game_if_expired(p_game uuid)
 returns boolean language plpgsql security definer set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not is_game_member(p_game) then raise exception 'You are not in this game'; end if;
  return _advance_game(p_game);
end $$;

create or replace function public.create_game(p_name text, p_seconds integer, p_player_ids uuid[])
 returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare gid uuid; pid uuid; i int := 1; nm text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if nm = '' then raise exception 'Enter a game name'; end if;
  if char_length(nm) > 80 then raise exception 'Game name must be 80 characters or fewer'; end if;
  if p_seconds is null or p_seconds < 10 or p_seconds > 604800 then
    raise exception 'Turn time must be between 10 seconds and 7 days.';
  end if;

  insert into games (name, created_by, turn_time_limit_seconds, current_turn_user_id, turn_deadline, status)
    values (nm, auth.uid(), p_seconds, auth.uid(), now() + make_interval(secs => p_seconds), 'active')
    returning id into gid;
  insert into game_players (game_id, user_id, player_order) values (gid, auth.uid(), 0);

  -- the creator goes first; everyone else follows in the order given, duplicates ignored
  for pid in
    select t.u from unnest(coalesce(p_player_ids, '{}'::uuid[])) with ordinality as t(u, n)
     group by t.u order by min(t.n)
  loop
    if pid <> auth.uid() and exists (select 1 from profiles where id = pid) then
      insert into game_players (game_id, user_id, player_order) values (gid, pid, i);
      i := i + 1;
    end if;
  end loop;
  return gid;
end $$;

-- Validates the entry with the same grammar as the app (one word, up to 2 punctuation
-- marks either side, optional ". " tail that attaches to the previous word).
create or replace function public.submit_word(p_game uuid, p_text text, p_bold boolean default false,
                                              p_italic boolean default false, p_break text default 'none')
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  g public.games%rowtype;
  n int;
  prev_uid uuid;
  skipped boolean;
  brk text := coalesce(p_break, 'none');
  txt text;
  punct constant text := '.,!?;:"''()…—–';
  entry_re constant text := '^([' || punct || ']{1,2} )?[' || punct || ']{0,2}[[:alnum:]_][[:alnum:]_''-]*[' || punct || ']{0,2}$';
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  -- same normalisation as the app: curly quotes -> straight, trim, collapse spaces
  txt := translate(coalesce(p_text, ''), '“”„‟‘’‚‛', '""""' || repeat(chr(39), 4));
  txt := regexp_replace(regexp_replace(txt, '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g');
  if txt = '' or char_length(txt) > 50 or txt !~ entry_re then
    raise exception 'Use one word, with up to 2 punctuation marks before and 2 after (e.g. "Heavens!"). To end the previous sentence, start with punctuation and a space (e.g. ". Then,").';
  end if;
  if brk not in ('none', 'line', 'para') then raise exception 'Invalid break'; end if;

  select current_turn_user_id into prev_uid from games where id = p_game;
  skipped := _advance_game(p_game);       -- catch an expired turn before deciding whose turn it is
  select * into g from games where id = p_game for update;
  if not found or g.status <> 'active' then raise exception 'Game is not active'; end if;
  if g.current_turn_user_id is distinct from auth.uid() then
    -- Raising rolls this transaction back, including the skip. That's fine: the app's
    -- advance_game_if_expired call (and the cron job) commit it separately.
    if skipped and prev_uid = auth.uid() then
      raise exception 'Your time ran out and the turn has passed to the next player.';
    end if;
    raise exception 'Not your turn.';
  end if;

  select count(*) into n from story_words where game_id = p_game;
  if n = 0 then                            -- first word: nothing to break from or attach to
    brk := 'none';
    if txt ~ ('^[' || punct || ']{1,2} ') then
      raise exception 'There''s no previous word to attach that punctuation to yet.';
    end if;
  end if;

  insert into story_words (game_id, user_id, word_text, word_order, bold, italic, break_before)
    values (p_game, auth.uid(), txt, n, coalesce(p_bold, false), coalesce(p_italic, false), brk);

  update games
     set word_count = n + 1, consecutive_skips = 0,
         current_turn_user_id = coalesce(_next_player(p_game, auth.uid()), auth.uid()),
         turn_deadline = now() + make_interval(secs => turn_time_limit_seconds)
   where id = p_game;
end $$;

-- The author can take back their last word for 30 seconds (35 s server-side for latency)
create or replace function public.undo_last_word(p_game uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare g public.games%rowtype; w public.story_words%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select * into g from games where id = p_game for update;
  if not found or g.status <> 'active' then raise exception 'You can only undo in an active game.'; end if;

  if not exists (
    select 1 from game_players where game_id = p_game and user_id = auth.uid() and left_at is null
  ) then
    raise exception 'You are not an active player in this game';
  end if;

  select * into w from story_words where game_id = p_game order by word_order desc limit 1;
  if not found or w.user_id <> auth.uid() then
    raise exception 'Only the most recent word can be undone, and only by its author.';
  end if;
  if w.created_at < now() - interval '35 seconds' then
    raise exception 'The 30-second undo window has passed.';
  end if;

  delete from story_words where id = w.id;

  update games
     set word_count = (select count(*) from story_words where game_id = p_game),
         consecutive_skips = 0,
         current_turn_user_id = auth.uid(),
         turn_deadline = now() + make_interval(secs => g.turn_time_limit_seconds)
   where id = p_game;

  return jsonb_build_object(
    'word_text', w.word_text, 'bold', w.bold, 'italic', w.italic, 'break_before', w.break_before);
end $$;

create or replace function public.add_player(p_game uuid, p_user uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare existing public.game_players%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from game_players
                  where game_id = p_game and user_id = auth.uid() and left_at is null) then
    raise exception 'You are not in this game';
  end if;
  perform 1 from games where id = p_game and status = 'active' for update;   -- also serialises player_order
  if not found then raise exception 'This story is no longer active'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'User not found'; end if;

  select * into existing from game_players where game_id = p_game and user_id = p_user;
  if found then
    if existing.left_at is null then raise exception 'Already in this game'; end if;
    perform rejoin_game(p_game, p_user);
  else
    insert into game_players (game_id, user_id, player_order)
      values (p_game, p_user,
              (select coalesce(max(player_order), -1) + 1 from game_players where game_id = p_game));
  end if;
end $$;

create or replace function public.leave_game(p_game uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare
  g            public.games%rowtype;
  my_order     int;
  active_count int;
  nxt          uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select * into g from games where id = p_game for update;
  if not found then raise exception 'Game not found'; end if;
  if g.status <> 'active' then raise exception 'This story is already finished'; end if;

  select player_order into my_order from game_players
   where game_id = p_game and user_id = auth.uid() and left_at is null;
  if not found then raise exception 'You are not an active player in this game'; end if;

  select count(*) into active_count from game_players
   where game_id = p_game and left_at is null;
  if active_count <= 1 then
    raise exception 'You are the last player. End the story instead of leaving.';
  end if;

  update game_players set left_at = now()
   where game_id = p_game and user_id = auth.uid();

  if g.current_turn_user_id = auth.uid() then
    -- next active player after me in order, wrapping to the first
    select user_id into nxt from game_players
     where game_id = p_game and left_at is null
     order by (player_order > my_order) desc, player_order
     limit 1;

    update games
       set current_turn_user_id = nxt,
           turn_deadline = now() + make_interval(hours => g.turn_time_limit_hours)
     where id = p_game;
  end if;
end $$;

-- Rejoin yourself, or (from add_player) bring back someone who left. Rejoiners go to the end.
create or replace function public.rejoin_game(p_game uuid, p_user uuid default null)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare target uuid := coalesce(p_user, auth.uid());
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  if target <> auth.uid() and not exists (
    select 1 from game_players
     where game_id = p_game and user_id = auth.uid() and left_at is null
  ) then
    raise exception 'You are not in this game';
  end if;

  perform 1 from games where id = p_game and status = 'active' for update;
  if not found then raise exception 'This story is no longer active'; end if;

  update game_players
     set left_at = null,
         archived_at = null,
         player_order = (select coalesce(max(player_order), -1) + 1
                           from game_players where game_id = p_game)
   where game_id = p_game and user_id = target and left_at is not null;
  if not found then raise exception 'That player has not left this game'; end if;
end $$;

create or replace function public.end_game(p_game uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from game_players
                  where game_id = p_game and user_id = auth.uid() and left_at is null) then
    raise exception 'You are not an active player in this game';
  end if;
  update games set status = 'completed', completed_at = now()
   where id = p_game and status = 'active';
  if not found then raise exception 'This story is already finished'; end if;
end $$;

-- Any remaining player can reopen a finished story within 24 hours
create or replace function public.reopen_story(p_game uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare g public.games%rowtype; last_author uuid; nxt uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from game_players
                  where game_id = p_game and user_id = auth.uid() and left_at is null) then
    raise exception 'You are not an active player in this game';
  end if;

  select * into g from games where id = p_game for update;
  if not found or g.status <> 'completed' then
    raise exception 'Only a finished story can be reopened';
  end if;
  if g.completed_at is null or g.completed_at < now() - interval '24 hours' then
    raise exception 'This story finished more than 24 hours ago, so it can no longer be reopened';
  end if;

  select user_id into last_author from story_words where game_id = p_game order by word_order desc limit 1;
  nxt := coalesce(_next_player(p_game, last_author), auth.uid());

  update games
     set status = 'active', completed_at = null, consecutive_skips = 0,
         current_turn_user_id = nxt,
         turn_deadline = now() + make_interval(secs => turn_time_limit_seconds)
   where id = p_game;

  update game_players set archived_at = null, deleted_at = null where game_id = p_game;
end $$;

create or replace function public.set_game_archived(p_game uuid, p_archived boolean)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  update game_players
     set archived_at = case when p_archived then now() else null end
   where game_id = p_game
     and user_id = auth.uid()
     and exists (select 1 from games where id = p_game and status = 'completed');
  if not found then raise exception 'Only completed stories you played in can be archived'; end if;
end $$;

-- Hides a finished story from your own list only; other players' copies are untouched
create or replace function public.delete_story_for_me(p_game uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  update game_players
     set deleted_at = coalesce(deleted_at, now())
   where game_id = p_game
     and user_id = auth.uid()
     and archived_at is null
     and exists (select 1 from games where id = p_game and status = 'completed');
  if not found then
    raise exception 'Only completed stories you played in, and have not archived, can be deleted';
  end if;
end $$;

create or replace function public.set_turn_time_limit(p_game uuid, p_seconds integer)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare g public.games%rowtype; turn_start timestamptz; new_deadline timestamptz; guard interval;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_seconds is null or p_seconds < 10 or p_seconds > 604800 then
    raise exception 'Turn time must be between 10 seconds and 7 days.';
  end if;
  if not exists (
    select 1 from game_players where game_id = p_game and user_id = auth.uid() and left_at is null
  ) then
    raise exception 'You are not an active player in this game';
  end if;

  select * into g from games where id = p_game for update;
  if not found or g.status <> 'active' then raise exception 'Game is not active'; end if;
  if g.turn_time_limit_seconds = p_seconds then return; end if;

  -- The current turn keeps the time already used, but is never left with less than
  -- min(1 hour, new limit), so shortening the limit can't instantly skip someone.
  if g.turn_deadline is not null then
    guard        := least(make_interval(secs => p_seconds), interval '1 hour');
    turn_start   := g.turn_deadline - make_interval(secs => g.turn_time_limit_seconds);
    new_deadline := greatest(turn_start + make_interval(secs => p_seconds), now() + guard);
  end if;

  update games
     set turn_time_limit_seconds = p_seconds,
         turn_deadline = coalesce(new_deadline, turn_deadline)
   where id = p_game;
end $$;

create or replace function public.change_username(p_username text)
 returns text language plpgsql security definer set search_path to 'public'
as $$
declare un text := lower(trim(p_username));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if un !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'Username: 3–20 characters, lowercase letters, numbers, underscores.';
  end if;
  if exists (select 1 from profiles where lower(username) = un and id <> auth.uid()) then
    raise exception 'That username is taken.';
  end if;
  update profiles set username = un where id = auth.uid();
  return un;
exception when unique_violation then
  raise exception 'That username is taken.';
end $$;

-- Lets the daily keep-alive job touch the API so the free plan doesn't pause
create or replace function public.ping()
 returns integer language sql set search_path to ''
as $$ select 1 $$;

-- Only the functions the app calls are executable by signed-in users
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_game_member(uuid), public.is_game_player(uuid),
  public.advance_game_if_expired(uuid), public.create_game(text, integer, uuid[]),
  public.submit_word(uuid, text, boolean, boolean, text), public.undo_last_word(uuid),
  public.add_player(uuid, uuid), public.leave_game(uuid), public.rejoin_game(uuid, uuid),
  public.end_game(uuid), public.reopen_story(uuid), public.set_game_archived(uuid, boolean),
  public.delete_story_for_me(uuid), public.set_turn_time_limit(uuid, integer),
  public.change_username(text)
  to authenticated;
grant execute on function public.ping() to anon, authenticated;


-- ─── 4. TRIGGERS ────────────────────────────────────────────────────────────

-- Create a profile from the username given at sign-up
create or replace function public.handle_new_user()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(trim(new.raw_user_meta_data->>'username')));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the legacy hours column in step with turn_time_limit_seconds
create or replace function public.sync_turn_hours()
 returns trigger language plpgsql set search_path to ''
as $$
begin
  new.turn_time_limit_hours := greatest(1, ceil(new.turn_time_limit_seconds / 3600.0)::int);
  return new;
end $$;

create trigger games_sync_turn_hours before insert or update of turn_time_limit_seconds on public.games
  for each row execute function public.sync_turn_hours();

-- Push notifications. The database calls the send-push Edge Function over HTTP (pg_net),
-- authenticated with a shared secret kept in Supabase Vault ('push_webhook_secret').
-- See supabase/migrations/08_push_notifications.sql for the subscription functions
-- (save_push_subscription, remove_push_subscription, send_test_push, push_webhook_secret).
create or replace function public._push_notify(p_payload jsonb)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare sec text;
begin
  select decrypted_secret into sec from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
  if sec is null then return; end if;
  perform net.http_post(
    url := 'https://wzeenraywlbxhecdnrfv.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', sec),
    body := p_payload,
    timeout_milliseconds := 5000
  );
exception when others then
  raise warning 'push notify failed: %', sqlerrm;
end $$;

-- "Your turn" and "story finished"
create or replace function public._games_push_trigger()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform _push_notify(jsonb_build_object('type', 'finished', 'game_id', new.id));
  elsif new.status = 'active' and new.current_turn_user_id is not null
        and new.current_turn_user_id is distinct from old.current_turn_user_id
        and new.current_turn_user_id is distinct from auth.uid() then
    perform _push_notify(jsonb_build_object('type', 'turn', 'game_id', new.id,
                         'user_id', new.current_turn_user_id, 'deadline', new.turn_deadline));
  end if;
  return null;
exception when others then
  raise warning 'games push trigger failed: %', sqlerrm;
  return null;
end $$;

-- "You were added to a story"
create or replace function public._players_push_trigger()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.user_id is distinct from (select created_by from games where id = new.game_id) then
    perform _push_notify(jsonb_build_object('type', 'added', 'game_id', new.game_id,
                         'user_id', new.user_id, 'by', auth.uid()));
  end if;
  return null;
exception when others then
  raise warning 'players push trigger failed: %', sqlerrm;
  return null;
end $$;

create trigger games_push after update on public.games
  for each row
  when (old.current_turn_user_id is distinct from new.current_turn_user_id
        or old.status is distinct from new.status)
  execute function public._games_push_trigger();

create trigger game_players_push after insert on public.game_players
  for each row execute function public._players_push_trigger();


-- ─── 5. SCHEDULED JOBS, REALTIME, STORAGE ───────────────────────────────────

-- Skip players whose turn has run out
select cron.schedule('advance-expired-turns', '* * * * *', $$ select public.advance_expired_turns(); $$);

-- Daily API call so the free plan never pauses the project (publishable key: public by design)
select cron.schedule('keepalive-ping', '17 9 * * *', $$ select net.http_post(
    url := 'https://wzeenraywlbxhecdnrfv.supabase.co/rest/v1/rpc/ping',
    headers := jsonb_build_object('apikey', 'sb_publishable_7LjFzl3p3NkkEoCv7AL1qQ_eA1zhltb', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  ) $$);

-- Live updates in the app (RLS still applies to what each user receives)
alter publication supabase_realtime add table public.games, public.game_players, public.story_words;

-- Profile pictures: public to read, each user writes only inside their own folder
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
create policy "Avatars are publicly viewable" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "Users can upload their own avatar" on storage.objects
  for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users can replace their own avatar" on storage.objects
  for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users can delete their own avatar" on storage.objects
  for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
