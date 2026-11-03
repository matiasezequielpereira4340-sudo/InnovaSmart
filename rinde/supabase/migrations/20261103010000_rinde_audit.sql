-- Registro permanente de desconexiones, borrados y errores de token.
-- Sin clave foránea a propósito: el registro tiene que sobrevivir aunque el usuario se borre.
create table if not exists public.rinde_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  meli_user_id bigint,
  nickname text,
  event text not null,         -- disconnect | delete | delete_rejected | token_error | logout | login | login_error
  reason text,
  ip text,
  user_agent text,
  referer text,
  page text,                   -- pantalla de la app desde donde se pidió (la manda el navegador)
  detail jsonb
);
create index if not exists rinde_audit_created_idx on public.rinde_audit (created_at desc);
create index if not exists rinde_audit_user_idx on public.rinde_audit (user_id, created_at desc);
alter table public.rinde_audit enable row level security;

-- "Hay que reconectar": un error de token nunca borra nada, solo marca la cuenta.
alter table public.rinde_users add column if not exists needs_reconnect_at timestamptz;
alter table public.rinde_users add column if not exists needs_reconnect_reason text;
