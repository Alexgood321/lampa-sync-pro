-- New completion provenance: staged regression; all test rows rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
do $test$
declare
  p_user uuid := auth.uid();
  p_media text := 'tmdb:tv:94444';
  p_episode text := 's1:e3';
  p_device text := 'd4444444-4444-4444-8444-444444444444';
  p_event jsonb;
  p_result jsonb;
  p_state text;
  p_basis text;
  p_seq int;
  p_kind text;
  p_expected text;
  p_event_id text;
  p_extra jsonb;
  p_session text := 'b4444444-4444-4444-8444-444444444444';
  p_source jsonb := jsonb_build_object('balanser','kodik','voice_id','v1',
    'voice_name','test','season_index',0,'voice_index',0);
begin
  if p_user is null then raise exception 'auth uid missing'; end if;
  for p_seq in 1..8 loop
    p_kind:=case p_seq
      when 1 then 'started'
      when 2 then 'marked_complete'
      when 3 then 'started'
      when 4 then 'marked_complete'
      when 5 then 'marked_complete'
      when 6 then 'marked_unwatched'
      when 7 then 'started'
      else 'completed' end;
    p_extra:='{}'::jsonb;
    if p_kind in ('started','completed') then
      p_extra:=jsonb_build_object('playback_session_id',p_session,
        'source_kind','lampac','source_recipe',p_source,
        'position_seconds',case when p_kind='completed' then 3600 else 0 end,
        'duration_seconds',case when p_kind='completed' then 3600 else 0 end);
    elsif p_kind='marked_complete' then
      p_extra:=jsonb_build_object('completion_basis',
        case when p_seq=4 then 'manual' else 'inferred' end);
    end if;
    p_event_id:=format('a4444444-4444-4444-8444-%012s',p_seq);
    p_event_id:=replace(p_event_id,' ','0');
    p_event:=jsonb_build_object('schema',1,'event_id',p_event_id,
      'device_id',p_device,'device_seq',p_seq,'base_revision',p_seq-1,
      'kind',p_kind,'media_key',p_media,'episode_key',p_episode)||p_extra;
    p_result:=public.lsp_sync_push(jsonb_build_array(p_event),p_seq-1);
    if p_result->>'status'<>'ok' or (p_result->>'accepted')::int<>1 then
      raise exception 'push % rejected: %',p_seq,p_result;
    end if;
    select state,completion_basis into p_state,p_basis
      from public.lsp_watch_state
      where user_id=p_user and media_key=p_media and episode_key=p_episode;
    p_expected:=case p_seq
      when 1 then 'in_progress:none'
      when 2 then 'completed:inferred'
      when 3 then 'completed:inferred'
      when 4 then 'completed:manual'
      when 5 then 'completed:manual'
      when 6 then 'reset:none'
      when 7 then 'in_progress:none'
      else 'completed:playback' end;
    if p_state||':'||p_basis<>p_expected then
      raise exception 'mismatch at %: got %, expected %',p_seq,p_state||':'||p_basis,p_expected;
    end if;
  end loop;
  if (select count(*) from public.lsp_sync_events where user_id=p_user
      and event->>'completion_basis'='inferred')<>2 then
    raise exception 'audit metadata missing in synced events'; end if;
  raise notice 'PASS 8 transactional states and inferred provenance, rollback follows';
end;
$test$;
rollback;
