-- Rinde: corridas de la Validación (admin). Guarda el reporte y la respuesta cruda de MeLi (sin tokens ni datos del comprador).
create table if not exists public.rinde_validation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  report jsonb not null,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists rinde_validation_runs_user on public.rinde_validation_runs (user_id, created_at desc);
alter table public.rinde_validation_runs enable row level security;
revoke all on public.rinde_validation_runs from anon, authenticated;
