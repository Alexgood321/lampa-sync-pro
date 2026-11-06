do $hardening$
declare v_def text;
begin
 v_def:=pg_get_functiondef('lsp_private.apply_events(jsonb,bigint)'::regprocedure);
 if strpos(v_def,'v_event->>''schema'' <> ''1''')=0 then
   raise exception 'unexpected_apply_events_signature';
 end if;
 execute replace(v_def,
  'v_event->>''schema'' <> ''1''',
  'v_event->>''schema'' is distinct from ''1''');

 v_def:=pg_get_functiondef('public.lsp_sync_pull(bigint,integer)'::regprocedure);
 if strpos(v_def,'p_since<0 or p_limit not between 1 and 200')=0 then
   raise exception 'unexpected_sync_pull_signature';
 end if;
 execute replace(v_def,
  'p_since<0 or p_limit not between 1 and 200',
  'p_since is null or p_since<0 or p_limit is null or p_limit not between 1 and 200');
end;
$hardening$;

-- Both indexes duplicated the leftmost columns of existing unique/PK indexes.
drop index if exists public.lsp_sync_events_revision_idx;
drop index if exists public.lsp_source_progress_media_idx;