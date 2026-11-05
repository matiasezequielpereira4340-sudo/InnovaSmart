-- Rinde: sugerencias de título/descripción generadas a pedido (se guardan para no repetir el gasto de IA).
create table if not exists public.rinde_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.rinde_users(id) on delete cascade,
  item_id text not null,
  input_hash text not null,      -- mismos datos de la publicación = misma sugerencia (no se vuelve a pagar IA)
  variant int not null default 0, -- "Generar otra" suma una variante
  content jsonb not null,
  source text not null,          -- ia | reglas
  tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists rinde_suggestions_user_day on public.rinde_suggestions (user_id, created_at desc);
create index if not exists rinde_suggestions_item on public.rinde_suggestions (user_id, item_id, created_at desc);
alter table public.rinde_suggestions enable row level security;
