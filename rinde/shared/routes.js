// Rutas públicas de Rinde y cómo las resuelve Vercel (sin dependencias: lo usan el build, el admin y las pruebas).
// Con "cleanUrls": true, Vercel NO sirve un destino de rewrite que termina en .html (/demo → /app.html daba 404).
export const ROUTES = ['/', '/demo', '/app', '/admin', '/suscribirme', '/privacidad', '/terminos'];

/** Resuelve una ruta como Vercel: primero el archivo (cleanUrls), después los rewrites. Devuelve el archivo o el motivo. */
export function resolveRoute(p, cfg, exists) {
  const file = (q) => (q === '/' ? 'index.html' : q.replace(/^\//, '') + (cfg.cleanUrls ? '.html' : ''));
  const direct = (q) => [file(q), q.replace(/^\//, '') + '/index.html'].find((f) => exists(f));
  if (cfg.cleanUrls && p.endsWith('.html')) return { ok: false, why: `${p}: con cleanUrls Vercel no sirve rutas .html` };
  const d = direct(p);
  if (d) return { ok: true, file: d, via: 'archivo' };
  for (const r of cfg.rewrites || []) {
    if (r.source !== p) continue;
    const dest = r.destination.split('?')[0];
    if (dest.startsWith('/api/')) return { ok: true, file: dest, via: 'función' };
    if (cfg.cleanUrls && dest.endsWith('.html')) return { ok: false, why: `${p} → ${dest}: con cleanUrls el destino tiene que ser la ruta limpia (${dest.replace(/\.html$/, '')}), si no Vercel responde 404` };
    const f = direct(dest);
    return f ? { ok: true, file: f, via: 'rewrite ' + dest } : { ok: false, why: `${p} → ${dest}: no existe el archivo` };
  }
  return { ok: false, why: `${p}: no hay archivo ni rewrite` };
}

export function checkConfig(cfg, exists) {
  const problems = [];
  for (const r of cfg.rewrites || []) if (cfg.cleanUrls && /\.html($|\?)/.test(r.destination)) problems.push(`rewrite ${r.source} → ${r.destination}: con cleanUrls no puede terminar en .html`);
  const routes = ROUTES.map((p) => ({ p, ...resolveRoute(p, cfg, exists) }));
  for (const r of routes) if (!r.ok) problems.push(r.why);
  return { problems: [...new Set(problems)], routes };
}

