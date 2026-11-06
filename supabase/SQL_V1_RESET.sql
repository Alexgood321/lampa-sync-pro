-- Fix: explicit "unwatched" must clear stale resume pointers and source progress.
-- This changes only the private writer; no data is removed.
do $patch$
declare original_sql text;
begin
 original_sql:=pg_get_functiondef('lsp_private.apply_events(jsonb,bigint)'::regprocedure);
 if strpos(original_sql, 'deleted=false,updated_revision=excluded.updated_revision,updated_at=now();'||E'\n'||
       '       if v_source_key is not null then')=0 then
   raise exception 'unexpected writer definition; refusing patch';
 end if;
 execute replace(original_sql,
   'deleted=false,updated_revision=excluded.updated_revision,updated_at=now();'||E'\n'||
   '       if v_source_key is not null then',
   'deleted=false,updated_revision=excluded.updated_revision,updated_at=now();'||E'\n'||
   '       if v_kind=''marked_unwatched'' then'||E'\n'||
   '         update public.lsp_source_progress set deleted=true,updated_revision=v_revision,updated_at=now()'||E'\n'||
   '          where user_id=v_user and media_key=v_media and episode_key=v_episode;'||E'\n'||
   '         delete from public.lsp_resume_pointers where user_id=v_user and media_key=v_media'||E'\n'||
   '          and episode_key=v_episode;'||E'\n'||
   '       end if;'||E'\n'||
   '       if v_source_key is not null then');
end;
$patch$;