-- Additive device identity only. No changes to playback/CUB tables or event payloads.
-- Pre-change snapshot for exact recovery of the existing device rows.
create table if not exists lsp_private.lsp_devices_backup_20261108 as
select user_id, device_id, last_seq, last_seen from public.lsp_devices;
revoke all on table lsp_private.lsp_devices_backup_20261108 from public, anon, authenticated;

alter table public.lsp_devices
  add column if not exists platform text not null default 'unknown',
  add column if not exists device_name text,
  add column if not exists player text not null default 'unknown',
  add column if not exists first_seen timestamptz;

update public.lsp_devices d
set first_seen=coalesce((
  select min(e.created_at) from public.lsp_sync_events e
  where e.user_id=d.user_id and e.device_id=d.device_id
),d.last_seen)
where d.first_seen is null;

alter table public.lsp_devices alter column first_seen set default now();
alter table public.lsp_devices alter column first_seen set not null;

create or replace function lsp_private.register_device(
  p_device_id uuid, p_platform text, p_player text default 'unknown'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=auth.uid();
  v_platform text:=lower(coalesce(nullif(btrim(p_platform),''),'unknown'));
  v_player text:=lower(coalesce(nullif(btrim(p_player),''),'unknown'));
  v_row public.lsp_devices%rowtype;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_device_id is null then raise exception 'invalid_device_id'; end if;
  if v_platform not in ('unknown','iphone','ipad','mac','android_tv','android','windows','linux')
    then raise exception 'invalid_platform'; end if;
  if v_player not in ('unknown','vimu','vlc','iina','native')
    then raise exception 'invalid_player'; end if;
  insert into public.lsp_devices(user_id,device_id,last_seq,last_seen,platform,player,first_seen)
    values(v_user,p_device_id,0,now(),v_platform,v_player,now())
    on conflict(user_id,device_id) do update set
      platform=case when excluded.platform<>'unknown' then excluded.platform else public.lsp_devices.platform end,
      player=case when excluded.player<>'unknown' then excluded.player else public.lsp_devices.player end,
      last_seen=greatest(public.lsp_devices.last_seen,excluded.last_seen)
    returning * into v_row;
  return jsonb_build_object('status','ok','device_id',v_row.device_id,
    'platform',v_row.platform,'player',v_row.player,'device_name',v_row.device_name);
end;
$$;

create or replace function lsp_private.rename_device(
  p_device_id uuid,p_name text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=auth.uid();
  v_name text:=nullif(btrim(coalesce(p_name,'')),'');
  v_row public.lsp_devices%rowtype;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_device_id is null then raise exception 'invalid_device_id'; end if;
  if length(coalesce(v_name,''))>60 or coalesce(v_name,'') ~ '[<>]'
    then raise exception 'invalid_device_name'; end if;
  update public.lsp_devices
     set device_name=v_name
   where user_id=v_user and device_id=p_device_id
   returning * into v_row;
  if not found then raise exception 'device_not_found'; end if;
  return jsonb_build_object('status','ok','device_id',v_row.device_id,
    'device_name',v_row.device_name,'platform',v_row.platform);
end;
$$;

create or replace function public.lsp_register_device(
  p_device_id uuid,p_platform text,p_player text default 'unknown'
) returns jsonb language sql security invoker set search_path='' as $$
  select lsp_private.register_device(p_device_id,p_platform,p_player);
$$;

create or replace function public.lsp_rename_device(
  p_device_id uuid,p_name text
) returns jsonb language sql security invoker set search_path='' as $$
  select lsp_private.rename_device(p_device_id,p_name);
$$;

grant usage on schema lsp_private to authenticated;
revoke execute on function lsp_private.register_device(uuid,text,text) from public,anon;
revoke execute on function lsp_private.rename_device(uuid,text) from public,anon;
revoke execute on function public.lsp_register_device(uuid,text,text) from public,anon;
revoke execute on function public.lsp_rename_device(uuid,text) from public,anon;
grant execute on function lsp_private.register_device(uuid,text,text) to authenticated;
grant execute on function lsp_private.rename_device(uuid,text) to authenticated;
grant execute on function public.lsp_register_device(uuid,text,text) to authenticated;
grant execute on function public.lsp_rename_device(uuid,text) to authenticated;
