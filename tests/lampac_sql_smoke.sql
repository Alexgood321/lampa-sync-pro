-- Lampac online source / manual NUM mark regression, all rows rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $online$
declare
  event jsonb;
  result jsonb;
  record jsonb;
  accepted int:=0;
begin
  event:=jsonb_build_object('schema',1,'event_id','a3333333-3333-4333-8333-333333333331',
    'device_id','d3333333-3333-4333-8333-333333333333','device_seq',1,
    'base_revision',0,'kind','started','media_key','tmdb:tv:99111','episode_key','s1:e2',
    'playback_session_id','b3333333-3333-4333-8333-333333333333',
    'source_kind','lampac',
    'source_recipe',jsonb_build_object('balanser','kodik','voice_id','voice.22',
      'voice_name','Voice label','season_index',0,'voice_index',2),
    'position_seconds',0,'duration_seconds',0);
  result:=public.lsp_sync_push(jsonb_build_array(event),0);
  if result->>'status'<>'ok' or result->>'revision'<>'1' then
    raise exception 'lampac source push failure: %',result; end if;
  accepted:=accepted+1;
  record:=public.lsp_get_resume('tmdb:tv:99111');
  if record->>'source_kind'<>'lampac' or record->>'episode_key'<>'s1:e2'
     or record->'source_recipe'->>'balanser'<>'kodik' then
    raise exception 'lampac resume source lost: %',record;end if;
  accepted:=accepted+1;
  if (select count(*) from public.lsp_source_progress where source_kind='lampac'
      and user_id=auth.uid())<>1 then
    raise exception 'lampac RLS read failure';end if;
  accepted:=accepted+1;
  begin
    perform public.lsp_sync_push(jsonb_build_array(event||jsonb_build_object(
      'event_id','a3333333-3333-4333-8333-333333333332','device_seq',2,'base_revision',1,
      'source_recipe',event->'source_recipe'||jsonb_build_object('stream_url','https://bad.example/secret'))),1);
    raise exception 'unsafe online recipe accepted';
  exception when others then
    if sqlerrm='unsafe online recipe accepted' then raise; end if;
  end;
  accepted:=accepted+1;
  result:=public.lsp_sync_push(jsonb_build_array(jsonb_build_object(
     'schema',1,'event_id','a3333333-3333-4333-8333-333333333333',
     'device_id','d3333333-3333-4333-8333-333333333333','device_seq',2,
     'base_revision',1,'kind','marked_complete','media_key','tmdb:tv:99111',
     'episode_key','s1:e2')),1);
  if result->>'status'<>'ok' or
    (select state from public.lsp_watch_state where user_id=auth.uid()
      and media_key='tmdb:tv:99111' and episode_key='s1:e2')<>'completed' then
    raise exception 'manual NUM mark failed: %',result;end if;
  accepted:=accepted+1;
  result:=public.lsp_sync_push(jsonb_build_array(jsonb_build_object(
     'schema',1,'event_id','a3333333-3333-4333-8333-333333333334',
     'device_id','d3333333-3333-4333-8333-333333333333','device_seq',3,
     'base_revision',2,'kind','marked_unwatched','media_key','tmdb:tv:99111',
     'episode_key','s1:e2')),2);
  if result->>'status'<>'ok' or
    (select state from public.lsp_watch_state where user_id=auth.uid()
     and media_key='tmdb:tv:99111' and episode_key='s1:e2')<>'reset' or
    public.lsp_get_resume('tmdb:tv:99111') is not null then
    raise exception 'manual reset did not erase pointer: %',result;end if;
  accepted:=accepted+1;
  raise notice 'PASS % lampac/NUM SQL assertions, rollback follows',accepted;
end;
$online$;
rollback;