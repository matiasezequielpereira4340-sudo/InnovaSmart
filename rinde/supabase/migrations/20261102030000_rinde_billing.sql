-- Rinde: cobros (Mercado Pago Suscripciones + transferencia manual).
alter table public.rinde_users
  add column if not exists plan_interval text check (plan_interval in ('monthly', 'annual')),
  add column if not exists plan_expires_at timestamptz,
  add column if not exists billing_status text,          -- trial | active | past_due | canceled | lapsed | manual
  add column if not exists grace_until timestamptz,
  add column if not exists payment_method text,           -- mp | transfer
  add column if not exists mp_preapproval_id text,
  add column if not exists billing_email text;
create index if not exists rinde_users_preapproval on public.rinde_users (mp_preapproval_id);

create table if not exists public.rinde_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.rinde_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.rinde_users(id) on delete set null,
  source text not null,                 -- mp | transfer
  external_id text unique,              -- id del pago en MP (evita duplicados)
  status text not null default 'approved',
  amount numeric not null,
  currency text not null default 'ARS',
  plan_interval text,
  paid_at timestamptz not null default now(),
  customer_name text,
  customer_email text,
  customer_doc text,
  invoiced_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists rinde_payments_paid on public.rinde_payments (paid_at desc);

create table if not exists public.rinde_billing_events (
  id uuid primary key default gen_random_uuid(),
  topic text,
  resource_id text,
  payload jsonb,
  result text,
  error text,
  created_at timestamptz not null default now()
);

alter table public.rinde_settings enable row level security;
alter table public.rinde_payments enable row level security;
alter table public.rinde_billing_events enable row level security;
revoke all on public.rinde_settings, public.rinde_payments, public.rinde_billing_events from anon, authenticated;
