-- Lampa Sync Pro: Realtime publication carries only per-user revision heads.
-- Payload contains user_id, revision, updated_at; full progress is read via RLS RPC.
do $lsp$
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    raise exception 'supabase_realtime publication is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.lsp_sync_heads'::regclass) then
    raise exception 'lsp_sync_heads RLS must remain enabled';
  end if;
  if not exists(
    select 1 from pg_policies
    where schemaname='public' and tablename='lsp_sync_heads'
      and cmd='SELECT' and 'authenticated'=any(roles)
      and qual like '%auth.uid()%'
  ) then
    raise exception 'authenticated owner-scoped read policy is missing';
  end if;
  if not exists(
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public'
      and tablename='lsp_sync_heads'
  ) then
    alter publication supabase_realtime add table public.lsp_sync_heads;
  end if;
end;
$lsp$;