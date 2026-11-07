-- Lampa Sync Pro: never replace a valid cloud checkpoint with a zero-second
-- 'started' event from another device (e.g. VLC / IINA external launch).
-- Also retain known duration when incoming event has unknown duration.
-- Existing watched states and events are not deleted.
do $patch$
declare v_function text;
        v_old text:='position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,';
        v_new text;
begin
  v_function:=pg_get_functiondef('lsp_private.apply_events(jsonb,bigint)'::regprocedure);
  if strpos(v_function,v_old)=0 then
    raise exception 'unexpected writer definition; refusing patch';
  end if;
  v_new:='position_seconds=case when v_kind=''started'' and excluded.position_seconds=0 '||
      'and not public.lsp_source_progress.deleted then public.lsp_source_progress.position_seconds '||
      'else excluded.position_seconds end,'||E'\n'||
      '                 duration_seconds=case when excluded.duration_seconds=0 '||
      'and not public.lsp_source_progress.deleted then public.lsp_source_progress.duration_seconds '||
      'else excluded.duration_seconds end,';
  execute replace(v_function,v_old,v_new);
end;
$patch$;