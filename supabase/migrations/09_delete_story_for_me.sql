-- 09_delete_story_for_me.sql  ADDITIVE.
-- "Delete" removes a finished story from YOUR list only. The story and other players' copies are untouched.
-- Same idea as archiving: a per-player timestamp. Only completed stories you played in and have not archived.

alter table public.game_players add column if not exists deleted_at timestamptz;

create or replace function public.delete_story_for_me(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
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

revoke all on function public.delete_story_for_me(uuid) from public, anon, authenticated;
grant execute on function public.delete_story_for_me(uuid) to authenticated;
