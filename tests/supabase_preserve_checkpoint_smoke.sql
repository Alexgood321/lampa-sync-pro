-- Lampa Sync Pro: TrackTimecode and cross-device start regression.
-- Synthetic authenticated identity, transaction rolled back after assertions.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $check$
declare
  recipe jsonb:='{"infohash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","file_index":1,"file_path":"S01E01.mkv"}';
  e jsonb;
  r jsonb;
  tests integer:=0;
begin
  e:=jsonb_build_object('schema',1,
    'event_id','aaaa1111-1111-4111-8111-111111111111',
    'device_id','dddd1111-1111-4111-8111-111111111111',
    'device_seq',1,'base_revision',0,'kind','started',
    'media_key','tmdb:tv:7001','episode_key','s1:e1',
    'playback_session_id','bbbb1111-1111-4111-8111-111111111111',
    'source_kind','torrent','source_recipe',recipe,
    'position_seconds',90,'duration_seconds',2700);
  r:=public.lsp_sync_push(jsonb_build_array(e),0);
  if r->>'status'<>'ok' then raise exception 'first launch failed: %',r;end if;
  tests:=tests+1;
  e:=e||jsonb_build_object('event_id','aaaa1111-1111-4111-8111-111111111112',
    'device_seq',2,'base_revision',1,'kind','progress','position_seconds',120);
  r:=public.lsp_sync_push(jsonb_build_array(e),1);
  if (select position_seconds from public.lsp_source_progress
    where media_key='tmdb:tv:7001')<>120 then raise exception 'checkpoint failed';end if;
  tests:=tests+1;
  e:=e||jsonb_build_object('event_id','aaaa2222-2222-4222-8222-222222222221',
    'device_id','dddd2222-2222-4222-8222-222222222222','device_seq',1,
    'base_revision',2,'playback_session_id','bbbb2222-2222-4222-8222-222222222222',
    'kind','started','position_seconds',0,'duration_seconds',0);
  r:=public.lsp_sync_push(jsonb_build_array(e),2);
  if r->>'status'<>'ok' or
    (select position_seconds from public.lsp_source_progress where media_key='tmdb:tv:7001')<>120 or
    (select duration_seconds from public.lsp_source_progress where media_key='tmdb:tv:7001')<>2700
    then raise exception 'zero second device start erased checkpoint: %',r;
  end if;
  tests:=tests+1;
  e:=e||jsonb_build_object('event_id','aaaa2222-2222-4222-8222-222222222222',
    'device_seq',2,'base_revision',3,'kind','progress','position_seconds',180,
    'duration_seconds',0);
  r:=public.lsp_sync_push(jsonb_build_array(e),3);
  if (select position_seconds from public.lsp_source_progress where media_key='tmdb:tv:7001')<>180 or
    (select duration_seconds from public.lsp_source_progress where media_key='tmdb:tv:7001')<>2700
    then raise exception 'new session progress/duration failed';
  end if;
  tests:=tests+1;
  if public.lsp_get_resume('tmdb:tv:7001')->>'episode_key'<>'s1:e1'
    then raise exception 'resume pointer lost';end if;
  tests:=tests+1;
  raise notice 'PASS: % TorrServer cloud-checkpoint assertions',tests;
end;
$check$;
select 'PASS 5 checkpoint assertions; all test data rolled back' as result;
rollback;