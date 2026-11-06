
create schema if not exists lsp_private;
revoke all on schema lsp_private from public, anon, authenticated;

create table public.lsp_sync_heads (
 user_id uuid primary key,
 revision bigint not null default 0 check (revision>=0),
 updated_at timestamptz not null default now()
);
create table public.lsp_devices (
 user_id uuid not null,
 device_id uuid not null,
 last_seq bigint not null default 0 check (last_seq>=0),
 last_seen timestamptz not null default now(),
 primary key(user_id,device_id)
);
create table public.lsp_watch_state (
 user_id uuid not null,
 media_key text not null,
 episode_key text not null,
 state text not null check (state in ('in_progress','completed','reset')),
 deleted boolean not null default false,
 updated_revision bigint not null check (updated_revision>0),
 updated_at timestamptz not null default now(),
 primary key(user_id,media_key,episode_key)
);
create table public.lsp_source_progress (
 user_id uuid not null,
 media_key text not null,
 episode_key text not null,
 source_key text not null,
 source_kind text not null check (source_kind in ('torrent','hdrezka')),
 source_recipe jsonb not null default '{}'::jsonb,
 position_seconds integer not null default 0 check (position_seconds>=0 and position_seconds<=86400),
 duration_seconds integer not null default 0 check (duration_seconds>=0 and duration_seconds<=86400),
 playback_session_id uuid not null,
 deleted boolean not null default false,
 updated_revision bigint not null check (updated_revision>0),
 updated_at timestamptz not null default now(),
 primary key(user_id,media_key,episode_key,source_key)
);
create table public.lsp_resume_pointers (
 user_id uuid not null,
 media_key text not null,
 episode_key text not null,
 source_key text not null,
 active_session_id uuid not null,
 updated_revision bigint not null check (updated_revision>0),
 updated_at timestamptz not null default now(),
 primary key(user_id,media_key)
);
create table public.lsp_sync_events (
 user_id uuid not null,
 event_id uuid not null,
 revision bigint not null check (revision>0),
 device_id uuid not null,
 device_seq bigint not null check (device_seq>0),
 event jsonb not null,
 created_at timestamptz not null default now(),
 primary key(user_id,event_id),
 unique(user_id,revision),
 unique(user_id,device_id,device_seq)
);
create index lsp_sync_events_revision_idx on public.lsp_sync_events(user_id,revision);
create index lsp_source_progress_media_idx on public.lsp_source_progress(user_id,media_key);

alter table public.lsp_sync_heads enable row level security;
alter table public.lsp_devices enable row level security;
alter table public.lsp_watch_state enable row level security;
alter table public.lsp_source_progress enable row level security;
alter table public.lsp_resume_pointers enable row level security;
alter table public.lsp_sync_events enable row level security;

revoke all on public.lsp_sync_heads,public.lsp_devices,public.lsp_watch_state,
  public.lsp_source_progress,public.lsp_resume_pointers,public.lsp_sync_events
  from public,anon,authenticated;
grant select on public.lsp_sync_heads,public.lsp_devices,public.lsp_watch_state,
  public.lsp_source_progress,public.lsp_resume_pointers,public.lsp_sync_events
  to authenticated;

create policy lsp_owner_read on public.lsp_sync_heads
 for select to authenticated using (user_id=(select auth.uid()));
create policy lsp_owner_read on public.lsp_devices
 for select to authenticated using (user_id=(select auth.uid()));
create policy lsp_owner_read on public.lsp_watch_state
 for select to authenticated using (user_id=(select auth.uid()));
create policy lsp_owner_read on public.lsp_source_progress
 for select to authenticated using (user_id=(select auth.uid()));
create policy lsp_owner_read on public.lsp_resume_pointers
 for select to authenticated using (user_id=(select auth.uid()));
create policy lsp_owner_read on public.lsp_sync_events
 for select to authenticated using (user_id=(select auth.uid()));

-- The privileged writer is in a schema NOT exposed by PostgREST.
-- It authorizes from auth.uid(), never a client-supplied user_id.
create function lsp_private.apply_events(p_events jsonb,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
 v_user uuid := auth.uid();
 v_revision bigint;
 v_initial_revision bigint;
 v_event jsonb;
 v_id uuid;
 v_device uuid;
 v_device_seq bigint;
 v_last_seq bigint;
 v_base_revision bigint;
 v_kind text;
 v_media text;
 v_episode text;
 v_session uuid;
 v_source_kind text;
 v_recipe jsonb;
 v_source_key text;
 v_hash text;
 v_file_index integer;
 v_film text;
 v_season text;
 v_epid text;
 v_translator text;
 v_position integer;
 v_duration integer;
 v_payload jsonb;
 v_existing_session uuid;
 v_existing_revision bigint;
 v_existing_deleted boolean;
 v_ignored boolean;
 v_accepted integer := 0;
 v_duplicates integer := 0;
 v_ignored_count integer := 0;
begin
 if v_user is null then raise exception 'authentication_required' using errcode='28000'; end if;
 if p_expected_revision is null or p_expected_revision<0 then raise exception 'invalid_revision'; end if;
 if p_events is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events) not between 1 and 50
    or octet_length(p_events::text)>100000 then raise exception 'invalid_batch'; end if;

 insert into public.lsp_sync_heads(user_id) values(v_user) on conflict do nothing;
 select revision into v_revision from public.lsp_sync_heads where user_id=v_user for update;
 v_initial_revision := v_revision;
 if v_revision <> p_expected_revision then
   return jsonb_build_object('status','conflict','revision',v_revision);
 end if;

 for v_event in select value from jsonb_array_elements(p_events) loop
   if jsonb_typeof(v_event)<>'object' or v_event->>'schema' <> '1' then
     raise exception 'invalid_event_schema';
   end if;
   v_id := (v_event->>'event_id')::uuid;
   v_device := (v_event->>'device_id')::uuid;
   v_device_seq := (v_event->>'device_seq')::bigint;
   v_base_revision := (v_event->>'base_revision')::bigint;
   if v_id is null or v_device is null or v_device_seq is null or v_device_seq<1
       or v_base_revision is null or v_base_revision<0 or v_base_revision>p_expected_revision then
     raise exception 'invalid_event_identity';
   end if;
   if exists (select 1 from public.lsp_sync_events where user_id=v_user and event_id=v_id) then
     v_duplicates := v_duplicates + 1;
     continue;
   end if;
   select last_seq into v_last_seq from public.lsp_devices
    where user_id=v_user and device_id=v_device;
   if v_device_seq<=coalesce(v_last_seq,0) then raise exception 'device_sequence_conflict'; end if;

   v_kind := v_event->>'kind';
   if v_kind is null or v_kind <> all(array[
      'started','progress','paused','stopped','completed',
      'marked_complete','marked_unwatched','deleted'
   ]) then raise exception 'invalid_event_kind'; end if;
   v_media := v_event->>'media_key';
   v_episode := v_event->>'episode_key';
   if v_media is null or v_media !~ '^(tmdb:(tv|movie):[0-9]{1,12}|imdb:tt[0-9]{1,12}|kinopoisk:[0-9]{1,12}|provider:rezka:[0-9]{1,12})$'
      or v_episode is null or v_episode !~ '^(movie|s[0-9]{1,3}:e[0-9]{1,4})$'
      or (v_media ~ '^tmdb:movie:' and v_episode<>'movie')
      then raise exception 'invalid_media_identity'; end if;

   v_source_kind := null;
   v_source_key := null;
   v_recipe := '{}'::jsonb;
   v_position := 0;
   v_duration := 0;
   v_session := null;
   if v_kind in ('started','progress','paused','stopped','completed') then
     v_session := (v_event->>'playback_session_id')::uuid;
     v_source_kind := v_event->>'source_kind';
     v_recipe := v_event->'source_recipe';
     v_position := coalesce((v_event->>'position_seconds')::integer,0);
     v_duration := coalesce((v_event->>'duration_seconds')::integer,0);
     if v_session is null or jsonb_typeof(v_recipe)<>'object'
        or v_position not between 0 and 86400 or v_duration not between 0 and 86400
        or (v_duration>0 and v_position>v_duration+30)
        then raise exception 'invalid_playback_data'; end if;

     if v_source_kind='torrent' then
       if (v_recipe - 'infohash' - 'file_index' - 'file_path' - 'torrent_title') <> '{}'::jsonb
          then raise exception 'unexpected_torrent_fields'; end if;
       v_hash := upper(v_recipe->>'infohash');
       v_file_index := (v_recipe->>'file_index')::integer;
       if v_hash is null or v_hash !~ '^([0-9A-F]{40}|[A-Z2-7]{32})$'
          or v_file_index is null or v_file_index not between 0 and 100000
          or length(coalesce(v_recipe->>'file_path','')) not between 1 and 600
          or length(coalesce(v_recipe->>'torrent_title',''))>300
          then raise exception 'invalid_torrent_recipe'; end if;
       v_recipe := jsonb_build_object('infohash',v_hash,'file_index',v_file_index,
          'file_path',v_recipe->>'file_path','torrent_title',coalesce(v_recipe->>'torrent_title',''));
       v_source_key := 'torrent:'||v_hash||':'||v_file_index;
     elsif v_source_kind='hdrezka' then
       if (v_recipe - 'film_id' - 'season_id' - 'episode_id' - 'translator_id' - 'voice_label') <> '{}'::jsonb
          then raise exception 'unexpected_hdrezka_fields'; end if;
       v_film:=v_recipe->>'film_id';
       v_season:=coalesce(v_recipe->>'season_id','0');
       v_epid:=coalesce(v_recipe->>'episode_id','0');
       v_translator:=coalesce(v_recipe->>'translator_id','0');
       if v_film is null or v_film !~ '^[0-9]{1,12}$'
          or v_season !~ '^[0-9]{1,12}$' or v_epid !~ '^[0-9]{1,12}$'
          or v_translator !~ '^[0-9]{1,12}$'
          or length(coalesce(v_recipe->>'voice_label',''))>100
          then raise exception 'invalid_hdrezka_recipe'; end if;
       v_recipe:=jsonb_build_object('film_id',v_film,'season_id',v_season,
          'episode_id',v_epid,'translator_id',v_translator,
          'voice_label',coalesce(v_recipe->>'voice_label',''));
       v_source_key:='hdrezka:'||v_film||':'||v_season||':'||v_epid||':'||v_translator;
     else
       raise exception 'unsupported_source';
     end if;
   else
     if (v_event ? 'source_recipe') or (v_event ? 'source_kind') or (v_event ? 'position_seconds')
       then raise exception 'manual_event_contains_source'; end if;
   end if;

   select updated_revision,deleted into v_existing_revision,v_existing_deleted
     from public.lsp_watch_state where user_id=v_user and media_key=v_media and episode_key=v_episode;
   v_ignored := coalesce(v_existing_revision>v_base_revision and v_existing_revision<=v_initial_revision,false);
   -- Only a fresh confirmed new session may replace another session for this specific source.
   if not v_ignored and v_source_key is not null and v_kind<>'started' then
     select playback_session_id into v_existing_session
     from public.lsp_source_progress
     where user_id=v_user and media_key=v_media and episode_key=v_episode and source_key=v_source_key;
     if v_existing_session is not null and v_existing_session<>v_session then v_ignored:=true; end if;
   end if;

   v_revision := v_revision + 1;
   if not v_ignored then
     if v_kind='deleted' then
       insert into public.lsp_watch_state(user_id,media_key,episode_key,state,deleted,updated_revision)
         values(v_user,v_media,v_episode,'reset',true,v_revision)
         on conflict(user_id,media_key,episode_key) do update
           set state='reset',deleted=true,updated_revision=excluded.updated_revision,updated_at=now();
       update public.lsp_source_progress set deleted=true,updated_revision=v_revision,updated_at=now()
         where user_id=v_user and media_key=v_media and episode_key=v_episode;
       delete from public.lsp_resume_pointers where user_id=v_user and media_key=v_media
         and episode_key=v_episode;
     else
       insert into public.lsp_watch_state(user_id,media_key,episode_key,state,deleted,updated_revision)
         values(v_user,v_media,v_episode,
           case when v_kind in ('completed','marked_complete') then 'completed'
             when v_kind='marked_unwatched' then 'reset' else 'in_progress' end,false,v_revision)
         on conflict(user_id,media_key,episode_key) do update
           set state=case
                when v_kind in ('completed','marked_complete') then 'completed'
                when v_kind='marked_unwatched' then 'reset'
                when public.lsp_watch_state.state='completed' then 'completed'
                else 'in_progress' end,
               deleted=false,updated_revision=excluded.updated_revision,updated_at=now();
       if v_source_key is not null then
         insert into public.lsp_source_progress(user_id,media_key,episode_key,
           source_key,source_kind,source_recipe,position_seconds,duration_seconds,
           playback_session_id,deleted,updated_revision)
           values(v_user,v_media,v_episode,v_source_key,v_source_kind,v_recipe,
             v_position,v_duration,v_session,false,v_revision)
           on conflict(user_id,media_key,episode_key,source_key) do update
             set source_kind=excluded.source_kind,source_recipe=excluded.source_recipe,
                 position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,
                 playback_session_id=excluded.playback_session_id,deleted=false,
                 updated_revision=excluded.updated_revision,updated_at=now();
         if v_kind='started' and v_base_revision=v_initial_revision then
           insert into public.lsp_resume_pointers(user_id,media_key,episode_key,source_key,
              active_session_id,updated_revision)
             values(v_user,v_media,v_episode,v_source_key,v_session,v_revision)
             on conflict(user_id,media_key) do update
               set episode_key=excluded.episode_key,source_key=excluded.source_key,
                   active_session_id=excluded.active_session_id,
                   updated_revision=excluded.updated_revision,updated_at=now();
         elsif v_kind<>'started' then
           update public.lsp_resume_pointers set updated_revision=v_revision,updated_at=now()
            where user_id=v_user and media_key=v_media and episode_key=v_episode
              and source_key=v_source_key and active_session_id=v_session;
         end if;
       end if;
     end if;
     v_accepted:=v_accepted+1;
   else
     v_ignored_count:=v_ignored_count+1;
   end if;

   v_payload:=jsonb_build_object('schema',1,'event_id',v_id,'device_id',v_device,
     'device_seq',v_device_seq,'base_revision',v_base_revision,
     'kind',v_kind,'media_key',v_media,'episode_key',v_episode,
     'applied',not v_ignored,'revision',v_revision);
   if v_source_key is not null then
     v_payload:=v_payload||jsonb_build_object('playback_session_id',v_session,
        'source_kind',v_source_kind,'source_key',v_source_key,
        'source_recipe',v_recipe,'position_seconds',v_position,'duration_seconds',v_duration);
   end if;
   insert into public.lsp_sync_events(user_id,event_id,revision,device_id,device_seq,event)
     values(v_user,v_id,v_revision,v_device,v_device_seq,v_payload);
   insert into public.lsp_devices(user_id,device_id,last_seq)
     values(v_user,v_device,v_device_seq)
     on conflict(user_id,device_id) do update
       set last_seq=excluded.last_seq,last_seen=now();
 end loop;
 update public.lsp_sync_heads set revision=v_revision,updated_at=now() where user_id=v_user;
 return jsonb_build_object('status','ok','revision',v_revision,
   'accepted',v_accepted,'duplicates',v_duplicates,'ignored',v_ignored_count);
end;
$fn$;

revoke all on function lsp_private.apply_events(jsonb,bigint) from public,anon,authenticated;
grant usage on schema lsp_private to authenticated;
grant execute on function lsp_private.apply_events(jsonb,bigint) to authenticated;

create function public.lsp_sync_push(p_events jsonb,p_expected_revision bigint)
returns jsonb language sql security invoker set search_path = '' as $fn$
 select lsp_private.apply_events(p_events,p_expected_revision);
$fn$;
revoke all on function public.lsp_sync_push(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.lsp_sync_push(jsonb,bigint) to authenticated;

create function public.lsp_sync_pull(p_since bigint default 0,p_limit integer default 100)
returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare
 v_user uuid := auth.uid();
 v_head bigint;
 v_next bigint;
 v_rows jsonb;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if p_since<0 or p_limit not between 1 and 200 then raise exception 'invalid_pull_pagination'; end if;
 select coalesce(revision,0) into v_head from public.lsp_sync_heads where user_id=v_user;
 v_head:=coalesce(v_head,0);
 select coalesce(jsonb_agg(t.event order by t.revision),'[]'::jsonb),
        coalesce(max(t.revision),p_since) into v_rows,v_next
 from (select revision,event from public.lsp_sync_events
        where user_id=v_user and revision>p_since order by revision limit p_limit) t;
 return jsonb_build_object('status','ok','server_revision',v_head,
    'next_revision',v_next,'has_more',exists(
      select 1 from public.lsp_sync_events where user_id=v_user and revision>v_next),
    'events',v_rows);
end;
$fn$;
revoke all on function public.lsp_sync_pull(bigint,integer) from public,anon,authenticated;
grant execute on function public.lsp_sync_pull(bigint,integer) to authenticated;

create function public.lsp_sync_snapshot()
returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare
 v_user uuid := auth.uid();
 v_head bigint;
 v_n bigint;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 select coalesce(revision,0) into v_head from public.lsp_sync_heads where user_id=v_user;
 v_head:=coalesce(v_head,0);
 select (select count(*) from public.lsp_watch_state where user_id=v_user)
      +(select count(*) from public.lsp_source_progress where user_id=v_user)
      +(select count(*) from public.lsp_resume_pointers where user_id=v_user) into v_n;
 if v_n>2500 then raise exception 'snapshot_too_large_use_pull'; end if;
 return jsonb_build_object('status','ok','revision',v_head,
   'watch_state',coalesce((select jsonb_agg(to_jsonb(x)) from
       (select media_key,episode_key,state,deleted,updated_revision
         from public.lsp_watch_state where user_id=v_user order by media_key,episode_key) x),'[]'::jsonb),
   'source_progress',coalesce((select jsonb_agg(to_jsonb(x)) from
       (select media_key,episode_key,source_key,source_kind,source_recipe,
           position_seconds,duration_seconds,deleted,updated_revision
         from public.lsp_source_progress where user_id=v_user
         order by media_key,episode_key,source_key) x),'[]'::jsonb),
   'resume_pointers',coalesce((select jsonb_agg(to_jsonb(x)) from
       (select media_key,episode_key,source_key,updated_revision
         from public.lsp_resume_pointers where user_id=v_user order by media_key) x),'[]'::jsonb));
end;
$fn$;
revoke all on function public.lsp_sync_snapshot() from public,anon,authenticated;
grant execute on function public.lsp_sync_snapshot() to authenticated;

create function public.lsp_get_resume(p_media_key text)
returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare
 v_user uuid:=auth.uid();
 v_result jsonb;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if p_media_key is null or length(p_media_key)>220 then raise exception 'invalid_media_key'; end if;
 select jsonb_build_object('media_key',p.media_key,'episode_key',p.episode_key,
   'source_key',p.source_key,'source_kind',s.source_kind,
   'source_recipe',s.source_recipe,'position_seconds',s.position_seconds,
   'duration_seconds',s.duration_seconds,
   'watched_state',w.state,'revision',p.updated_revision)
 into v_result
 from public.lsp_resume_pointers p
 join public.lsp_source_progress s on s.user_id=p.user_id
   and s.media_key=p.media_key and s.episode_key=p.episode_key and s.source_key=p.source_key
 left join public.lsp_watch_state w on w.user_id=p.user_id
   and w.media_key=p.media_key and w.episode_key=p.episode_key
 where p.user_id=v_user and p.media_key=p_media_key and not s.deleted;
 return v_result;
end;
$fn$;
revoke all on function public.lsp_get_resume(text) from public,anon,authenticated;
grant execute on function public.lsp_get_resume(text) to authenticated;

comment on schema lsp_private is 'Private transactional sync implementation, not exposed through REST';
comment on function public.lsp_sync_push(jsonb,bigint) is 'Version 1 transactional sync endpoint; authenticated only';
