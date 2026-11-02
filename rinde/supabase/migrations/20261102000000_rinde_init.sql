-- Rinde v1 — tablas con prefijo rinde_. Todo el acceso es desde las funciones con la service key.
-- RLS activada y SIN políticas: nadie con la clave pública (anon) puede leer ni escribir.

create extension if not exists pgcrypto;

create table if not exists public.rinde_users (
  id uuid primary key default gen_random_uuid(),
  meli_user_id bigint not null unique,
  nickname text,
  email text,
  alert_email text,
  alerts_enabled boolean not null default true,
  weekly_enabled boolean not null default true,
  plan text not null default 'free' check (plan in ('free', 'rinde')),
  plan_activated_at timestamptz,
  free_diagnosis_used_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  last_cron_at timestamptz
);

create table if not exists public.rinde_connections (
  user_id uuid primary key references public.rinde_users(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now()
);

create table if not exists public.rinde_sync_jobs (
  user_id uuid primary key references public.rinde_users(id) on delete cascade,
  status text not null default 'running',
  phase text not null default 'list',
  item_ids jsonb not null default '[]'::jsonb,
  cursor integer not null default 0,
  total integer not null default 0,
  meta jsonb not null default '{}'::jsonb,
  error text,
  retries integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.rinde_items (
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  item_id text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists public.rinde_orders (
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  order_id text not null,
  date_created timestamptz not null,
  data jsonb not null,
  fees jsonb,
  fees_source text,           -- 'facturación' (dato real) | 'orden' (estimado)
  taxes_unknown boolean not null default false,
  primary key (user_id, order_id)
);
create index if not exists rinde_orders_user_date on public.rinde_orders (user_id, date_created desc);

create table if not exists public.rinde_costs (
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  sku text not null,
  purchase_cost numeric,
  replacement_cost numeric,
  updated_at timestamptz not null default now(),
  primary key (user_id, sku)
);

create table if not exists public.rinde_ai_plans (
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  item_id text not null,
  input_hash text not null,   -- si los datos no cambiaron, no se regenera
  plan jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists public.rinde_diagnoses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  input_hash text,
  summary jsonb not null,
  counts jsonb,
  tokens_used integer,
  sync_finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists rinde_diagnoses_user on public.rinde_diagnoses (user_id, created_at desc);

create table if not exists public.rinde_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  key text not null,
  kind text not null,
  item_id text,
  title text,
  message text not null,
  severity text,
  created_at timestamptz not null default now(),
  emailed_at timestamptz,
  resolved_at timestamptz
);
create index if not exists rinde_alerts_user on public.rinde_alerts (user_id, created_at desc);

alter table public.rinde_users enable row level security;
alter table public.rinde_connections enable row level security;
alter table public.rinde_sync_jobs enable row level security;
alter table public.rinde_items enable row level security;
alter table public.rinde_orders enable row level security;
alter table public.rinde_costs enable row level security;
alter table public.rinde_ai_plans enable row level security;
alter table public.rinde_diagnoses enable row level security;
alter table public.rinde_alerts enable row level security;

-- Por las dudas: sacar permisos a los roles públicos.
revoke all on public.rinde_users, public.rinde_connections, public.rinde_sync_jobs, public.rinde_items,
  public.rinde_orders, public.rinde_costs, public.rinde_ai_plans, public.rinde_diagnoses, public.rinde_alerts
  from anon, authenticated;
