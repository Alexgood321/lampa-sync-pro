-- Regression for manual unwatch, completion and per-user state.
-- Entire test is rolled back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $test$
declare
  e jsonb;
  r jsonb;
  revision integer := 0;
  tested integer := 0;
begin
 e:=jsonb_build_object('schema',1,'event_id','11111111-1111-4111-8111-111111111112',
  'device_id','aaaa1111-1111-4111-8111-111111111111','device_seq',1,'base_revision',0,
  'kind','started','media_key','tmdb:tv:7000','episode_key','s1:e2',
  'playback_session_id','bbbbaaaa-1111-4111-8111-111111111111','source_kind','torrent',
  'source_recipe',jsonb_build_object('infohash','abcdefabcdefabcdefabcdefabcdefabcdefabcd',
     'file_index',7,'file_path','S01E02.mkv'),'position_seconds',240,'duration_seconds',2500);
 r:=public.lsp_sync_push(jsonb_build_array(e),revision);
 if r->>'status'<>'ok' then raise exception 'failed start';end if;
 revision:=(r->>'revision')::integer;
 if public.lsp_get_resume('tmdb:tv:7000') is null then raise exception 'missing resume';end if;
 tested:=tested+1;

 e:=jsonb_build_object('schema',1,'event_id','11111111-1111-4111-8111-111111111113',
  'device_id','aaaa1111-1111-4111-8111-111111111111','device_seq',2,
  'base_revision',revision,'kind','marked_complete','media_key','tmdb:tv:7000','episode_key','s1:e2');
 r:=public.lsp_sync_push(jsonb_build_array(e),revision);
 revision:=(r->>'revision')::integer;
 if (select state from public.lsp_watch_state where media_key='tmdb:tv:7000'
     and episode_key='s1:e2')<>'completed' then raise exception 'mark complete broken';end if;
 tested:=tested+1;

 e:=e||jsonb_build_object('event_id','11111111-1111-4111-8111-111111111114',
   'device_seq',3,'base_revision',revision,'kind','marked_unwatched');
 r:=public.lsp_sync_push(jsonb_build_array(e),revision);
 revision:=(r->>'revision')::integer;
 if public.lsp_get_resume('tmdb:tv:7000') is not null then
   raise exception 'unwatch did not clear pointer';end if;
 if (select count(*) from public.lsp_source_progress where media_key='tmdb:tv:7000'
   and not deleted)<>0 then raise exception 'unwatch did not clear source';end if;
 if (select state from public.lsp_watch_state where media_key='tmdb:tv:7000'
   and episode_key='s1:e2')<>'reset' then raise exception 'unwatch did not reset state';end if;
 tested:=tested+1;

 e:=jsonb_build_object('schema',1,'event_id','11111111-1111-4111-8111-111111111115',
  'device_id','aaaa1111-1111-4111-8111-111111111111','device_seq',4,'base_revision',revision,
  'kind','started','media_key','tmdb:tv:7000','episode_key','s1:e2',
  'playback_session_id','bbbbaaaa-1111-4111-8111-111111111115','source_kind','torrent',
  'source_recipe',jsonb_build_object('infohash','abcdefabcdefabcdefabcdefabcdefabcdefabcd',
     'file_index',7,'file_path','S01E02.mkv'),'position_seconds',100,'duration_seconds',2500);
 r:=public.lsp_sync_push(jsonb_build_array(e),revision);
 if public.lsp_get_resume('tmdb:tv:7000') is null then
  raise exception 'cannot resume after restarting';end if;
 tested:=tested+1;

 raise notice 'PASS: % reset tests',tested;
end;
$test$;
select 'PASS 4 reset regression tests, rollback' as result;
rollback;