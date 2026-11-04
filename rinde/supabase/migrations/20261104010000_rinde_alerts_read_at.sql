-- Alertas en el panel: marca de leída (mientras no haya emails, la app muestra las no leídas).
alter table public.rinde_alerts add column if not exists read_at timestamptz;
create index if not exists rinde_alerts_unread_idx on public.rinde_alerts (user_id) where resolved_at is null and read_at is null;
