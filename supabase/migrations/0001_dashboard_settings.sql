-- Dashboard settings (currently: which Discord channels to watch).
-- Run this in the Supabase SQL editor.
--
-- Only the server touches this table, using the service role key. RLS is enabled
-- with no policies, so anon/authenticated clients get nothing even if the anon
-- key leaks; the service role bypasses RLS by design.

create table if not exists public.dashboard_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.dashboard_settings enable row level security;

-- No policies on purpose: deny-by-default for every non-service-role caller.

comment on table public.dashboard_settings is
  'Server-managed dashboard settings. Written only via the service role key.';
