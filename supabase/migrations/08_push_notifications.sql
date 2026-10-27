-- 08_push_notifications.sql  (Phase 4)  ADDITIVE: new table, new functions, new triggers.
-- Triggers on games/game_players call the send-push Edge Function through pg_net.
-- A failed call can never break a game write (everything is wrapped in exception handlers).

-- 1. One row per phone/browser that wants notifications
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;           -- no policies: browsers never read or write it directly
revoke all on public.push_subscriptions from anon, authenticated;

-- 2. Shared secret between the database triggers and the Edge Function (generated here, never shown)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_webhook_secret') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'push_webhook_secret',
                                'Shared secret: database triggers -> send-push Edge Function');
  end if;
end $$;

-- The Edge Function (service role only) reads it to check who is calling.
create or replace function public.push_webhook_secret() returns text
language sql security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1
$$;
revoke all on function public.push_webhook_secret() from public, anon, authenticated;
grant execute on function public.push_webhook_secret() to service_role;

-- 3. Internal: send an event to the Edge Function (fire and forget)
create or replace function public._push_notify(p_payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
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
revoke all on function public._push_notify(jsonb) from public, anon, authenticated;

-- 4. Triggers
-- Turn changed -> "your turn" (the function waits 30 s and re-checks, so Undo cancels it).
-- Story finished -> everyone who hasn't left.
create or replace function public._games_push_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform _push_notify(jsonb_build_object('type', 'finished', 'game_id', new.id));
  elsif new.status = 'active' and new.current_turn_user_id is not null
        and new.current_turn_user_id is distinct from old.current_turn_user_id
        and new.current_turn_user_id is distinct from auth.uid() then   -- not for your own undo / solo game
    perform _push_notify(jsonb_build_object('type', 'turn', 'game_id', new.id,
                         'user_id', new.current_turn_user_id, 'deadline', new.turn_deadline));
  end if;
  return null;
exception when others then
  raise warning 'games push trigger failed: %', sqlerrm;
  return null;
end $$;
revoke all on function public._games_push_trigger() from public, anon, authenticated;

drop trigger if exists games_push on public.games;
create trigger games_push after update on public.games
  for each row
  when (old.current_turn_user_id is distinct from new.current_turn_user_id or old.status is distinct from new.status)
  execute function public._games_push_trigger();

-- Added to a story (not for the creator's own row)
create or replace function public._players_push_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
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
revoke all on function public._players_push_trigger() from public, anon, authenticated;

drop trigger if exists game_players_push on public.game_players;
create trigger game_players_push after insert on public.game_players
  for each row execute function public._players_push_trigger();

-- 5. Functions the app calls
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Invalid push subscription';
  end if;
  -- the same phone can switch accounts: the subscription follows whoever is signed in now
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, last_seen_at = now();
  -- keep at most 10 devices per person
  delete from push_subscriptions
   where user_id = auth.uid()
     and id not in (select id from push_subscriptions where user_id = auth.uid()
                     order by last_seen_at desc limit 10);
end $$;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

create or replace function public.send_test_push() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform _push_notify(jsonb_build_object('type', 'test', 'user_id', auth.uid()));
end $$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon, authenticated;
revoke all on function public.remove_push_subscription(text) from public, anon, authenticated;
revoke all on function public.send_test_push() from public, anon, authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
grant execute on function public.send_test_push() to authenticated;
