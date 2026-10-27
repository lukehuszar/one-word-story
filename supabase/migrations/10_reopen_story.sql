-- 10_reopen_story.sql  ADDITIVE. Reopen a finished story within 24 hours of it finishing.
-- Who: any player who hasn't left (same rule as ending a story).
-- Effect: story is active again; the turn goes to whoever follows the author of the last word;
-- the quiet-turn counter restarts; anyone who had archived or deleted the story sees it again.

create or replace function public.reopen_story(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
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

revoke all on function public.reopen_story(uuid) from public, anon, authenticated;
grant execute on function public.reopen_story(uuid) to authenticated;
