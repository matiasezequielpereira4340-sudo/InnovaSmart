# Rinde — ¿Tu cuenta de Mercado Libre rinde?

Un servicio de Innovasmart para vendedores de Mercado Libre Argentina: diagnóstico de publicaciones paradas, rentabilidad real por producto y alertas por email. **Solo lectura**: nunca modifica la cuenta del vendedor.

Proyecto 100 % independiente del resto del repo. Se deploya como proyecto Vercel aparte con **Root Directory = `rinde`**.

## Pantallas
| Ruta | Qué es |
|---|---|
| `/` | Landing |
| `/demo` | Modo demo (cuenta ficticia, sin login) — `#/diagnostico`, `#/rentabilidad`, `#/alertas` |
| `/app` | App real (después de conectar Mercado Libre) |
| `/admin` | Panel admin (clave `ADMIN_KEY`). `/admin?demo=1` muestra usuarios de ejemplo |
| `/api/email-preview?type=daily` · `?type=weekly` | Vista previa de los emails (datos demo) |
| `/privacidad`, `/terminos` | Legales |

## Variables de entorno
Ver `.env.example`. Todas van en Vercel → Settings → Environment Variables (Production y Preview).

| Variable | De dónde sale |
|---|---|
| `RINDE_MELI_APP_ID` / `RINDE_MELI_SECRET` | developers.mercadolibre.com.ar → Mis aplicaciones |
| `RINDE_MELI_REDIRECT_URI` | `https://TU-DOMINIO/api/auth/callback` (idéntica en MeLi) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API (service_role) |
| `ANTHROPIC_API_KEY` | console.anthropic.com (modelo `claude-haiku-5-5`) |
| `RESEND_API_KEY` | resend.com → API Keys |
| `SESSION_SECRET`, `TOKEN_ENC_KEY`, `CRON_SECRET`, `ADMIN_KEY` | Valores aleatorios. `TOKEN_ENC_KEY` = 64 caracteres hex. Generalos en https://www.random.org/strings/ o con `openssl rand -hex 32` |
| `RINDE_EMAIL_FROM` (opcional) | Remitente con dominio verificado en Resend |
| `RINDE_APP_URL` (opcional) | URL pública, para los links de los emails |

## Base de datos
Ejecutar `supabase/migrations/20261102000000_rinde_init.sql` en el SQL Editor de Supabase. Crea tablas `rinde_*` con RLS activada y sin políticas (solo accede la service key desde `/api`).

## Cómo funciona por dentro (resumen)
- `shared/` — reglas (umbrales en `shared/config.js`), clasificación, rentabilidad, alertas y datos demo. Lo usan el servidor y el navegador.
- `api/` — 9 funciones serverless (Node, sin build). `api/_lib/` no se publica como endpoint.
- Sincronización por pasos (`POST /api/sync`) para mostrar progreso real y no pasarse del tiempo de las funciones. Caché de 6 h.
- Cargos por venta: API de facturación de MeLi (`/billing/integration/group/ML/order/details`). Si no hay dato: orden + costo del envío, marcado "estimado".
- IA: Claude Haiku 5.5, salida JSON con esquema, tope de tokens por diagnóstico (`LIMITS` en `shared/config.js`) y caché por hash de datos en `rinde_ai_plans`. Sin clave o si falla, se usan planes por reglas.
- Cron diario (`/api/cron`, 11:17 UTC ≈ 8:17 AR) con `CRON_SECRET`: alertas nuevas por email; los lunes, resumen semanal.

## Local
```bash
cd rinde && npm install && node scripts/dev-server.mjs
```
Abrí http://localhost:3000/demo. Variables locales opcionales en `rinde/.env.local`.
Capturas: `node scripts/screenshots.mjs http://localhost:3000 ./screenshots`.
