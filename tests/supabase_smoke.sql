-- Lampa Sync Pro SQL regression smoke.
-- All synthetic rows are rolled back, even after successful assertions.
-- Run in Supabase SQL editor or an admin SQL connection.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $smoke$
declare
 uid_a constant text:='11111111-1111-4111-8111-111111111111';
 uid_b constant text:='22222222-2222-4222-8222-222222222222';
 device_a constant text:='d1111111-1111-4111-8111-111111111111';
 device_b constant text:='d2222222-2222-4222-8222-222222222222';
 session_a constant text:='b1111111-1111-4111-8111-111111111111';
 session_b constant text:='b2222222-2222-4222-8222-222222222222';
 src constant jsonb:='{"infohash":"0123456789abcdef0123456789abcdef01234567","file_index":4,"file_path":"S02E05.mkv"}';
 e jsonb;
 r jsonb;
 assertions integer:=0;
begin
 e:=jsonb_build_object('schema',1,'event_id','a1111111-1111-4111-8111-111111111111',
  'device_id',device_a,'device_seq',1,'base_revision',0,'kind','started',
  'media_key','tmdb:tv:1000','episode_key','s2:e5','playback_session_id',session_a,
  'source_kind','torrent','source_recipe',src,
  'position_seconds',1120,'duration_seconds',2700);
 r:=public.lsp_sync_push(jsonb_build_array(e),0);
 if r->>'status'<>'ok' or (r->>'revision')::int<>1 then raise exception 'push failed: %',r; end if;
 assertions:=assertions+1;

 r:=public.lsp_sync_snapshot();
 if (r->>'revision')::int<>1 or jsonb_array_length(r->'source_progress')<>1 then
  raise exception 'snapshot failed: %',r; end if;
 assertions:=assertions+1;

 r:=public.lsp_get_resume('tmdb:tv:1000');
 if r->>'episode_key'<>'s2:e5' or (r->>'position_seconds')::int<>1120 then
  raise exception 'resume failed: %',r; end if;
 assertions:=assertions+1;

 r:=public.lsp_sync_push(jsonb_build_array(e),0);
 if r->>'status'<>'conflict' or (r->>'revision')::int<>1 then
  raise exception 'conflict failed: %',r; end if;
 assertions:=assertions+1;

 r:=public.lsp_sync_push(jsonb_build_array(e),1);
 if (r->>'duplicates')::int<>1 or (r->>'revision')::int<>1 then
  raise exception 'deduplication failed: %',r; end if;
 assertions:=assertions+1;

 r:=public.lsp_sync_pull(0,1);
 if jsonb_array_length(r->'events')<>1 or (r->>'next_revision')::int<>1
   or r->>'has_more'<>'false' then raise exception 'pull failed: %',r; end if;
 assertions:=assertions+1;

 -- An incomplete schema must be rejected rather than accepted as SQL NULL.
 begin
  perform public.lsp_sync_push(jsonb_build_array(e-'schema'||jsonb_build_object(
    'event_id','a1111111-1111-4111-8111-111111111112','device_seq',2,'base_revision',1)),1);
  raise exception 'missing schema was accepted';
 exception when others then
  if sqlerrm='missing schema was accepted' then raise; end if;
 end;
 assertions:=assertions+1;

 -- A private stream URL cannot appear in the source recipe.
 begin
  perform public.lsp_sync_push(jsonb_build_array(e||jsonb_build_object(
    'event_id','a1111111-1111-4111-8111-111111111113','device_seq',2,'base_revision',1,
    'source_recipe',src||jsonb_build_object('stream','https://invalid.example/private'))),1);
  raise exception 'private stream was accepted';
 exception when others then
  if sqlerrm='private stream was accepted' then raise; end if;
 end;
 assertions:=assertions+1;

 begin
  perform public.lsp_sync_pull(null,100);
  raise exception 'null cursor was accepted';
 exception when others then
  if sqlerrm='null cursor was accepted' then raise; end if;
 end;
 assertions:=assertions+1;

 if (select revision from public.lsp_sync_heads where user_id=uid_a::uuid)<>1 then
  raise exception 'invalid requests changed revision'; end if;
 assertions:=assertions+1;

 -- Completion is sticky: later timeupdates cannot silently unmark a series.
 e:=e||jsonb_build_object('event_id','a1111111-1111-4111-8111-111111111114',
   'device_seq',2,'base_revision',1,'kind','completed','position_seconds',2650);
 perform public.lsp_sync_push(jsonb_build_array(e),1);
 e:=e||jsonb_build_object('event_id','a1111111-1111-4111-8111-111111111115',
   'device_seq',3,'base_revision',2,'kind','progress','position_seconds',1700);
 perform public.lsp_sync_push(jsonb_build_array(e),2);
 if (select state from public.lsp_watch_state where user_id=uid_a::uuid
   and episode_key='s2:e5')<>'completed' then raise exception 'completion was reset'; end if;
 assertions:=assertions+1;

 -- Different device starts a new episode.
 e:=jsonb_build_object('schema',1,'event_id','a2222222-2222-4222-8222-222222222221',
  'device_id',device_b,'device_seq',1,'base_revision',3,'kind','started',
  'media_key','tmdb:tv:1000','episode_key','s2:e6','playback_session_id',session_b,
  'source_kind','torrent','source_recipe',src||jsonb_build_object('file_index',5,'file_path','S02E06.mkv'),
  'position_seconds',100,'duration_seconds',2700);
 perform public.lsp_sync_push(jsonb_build_array(e),3);
 if public.lsp_get_resume('tmdb:tv:1000')->>'episode_key'<>'s2:e6' then
  raise exception 'new episode pointer failed'; end if;
 assertions:=assertions+1;

 -- Old device finishes late; stale event must not overwrite current episode.
 e:=jsonb_build_object('schema',1,'event_id','a1111111-1111-4111-8111-111111111116',
  'device_id',device_a,'device_seq',4,'base_revision',1,'kind','stopped',
  'media_key','tmdb:tv:1000','episode_key','s2:e5','playback_session_id',session_a,
  'source_kind','torrent','source_recipe',src,
  'position_seconds',400,'duration_seconds',2700);
 r:=public.lsp_sync_push(jsonb_build_array(e),4);
 if (r->>'ignored')::int<>1 or
    public.lsp_get_resume('tmdb:tv:1000')->>'episode_key'<>'s2:e6' then
  raise exception 'stale event overwrote current episode'; end if;
 assertions:=assertions+1;

 -- Another user sees no rows belonging to user A.
 perform set_config('request.jwt.claim.sub',uid_b,true);
 if (select count(*) from public.lsp_sync_events)<>0
  or (public.lsp_sync_snapshot()->>'revision')::int<>0
  or public.lsp_get_resume('tmdb:tv:1000') is not null then
  raise exception 'RLS isolation failed'; end if;
 assertions:=assertions+1;

 -- Anonymous access and arbitrary direct writes cannot be granted.
 if has_table_privilege('authenticated','public.lsp_sync_events','INSERT')
   or has_function_privilege('anon','public.lsp_sync_push(jsonb,bigint)','EXECUTE')
   or has_table_privilege('anon','public.lsp_sync_events','SELECT') then
  raise exception 'privileges too wide'; end if;
 assertions:=assertions+1;

 raise notice 'PASS: % regression assertions',assertions;
end;
$smoke$;
select 'PASS: 15 assertions; synthetic records rolled back' as result;
rollback;