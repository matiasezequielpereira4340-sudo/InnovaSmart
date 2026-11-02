-- Rinde: límite de intentos fallidos al entrar al admin.
create table if not exists public.rinde_admin_attempts (
  ip_hash text primary key,
  fails integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);
alter table public.rinde_admin_attempts enable row level security;
revoke all on public.rinde_admin_attempts from anon, authenticated;
