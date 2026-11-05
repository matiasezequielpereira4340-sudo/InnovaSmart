#!/usr/bin/env node
// Chequeo de rutas públicas. Es el buildCommand de Vercel: si falla, NO se publica el deploy.
//   node api/_lib/check-routes.mjs                     revisa vercel.json contra los archivos (sin red)
//   node api/_lib/check-routes.mjs --url https://rinde-orcin.vercel.app   además exige 200 en cada ruta
// Vive en api/_lib porque .vercelignore excluye scripts/ (y api/_lib no se publica como endpoint).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, checkConfig } from '../../shared/routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const { problems, routes } = checkConfig(cfg, (f) => fs.existsSync(path.join(root, f)));
for (const r of routes) console.log(`${r.ok ? '✓' : '✗'} ${r.p}${r.ok ? ` (${r.via}: ${r.file})` : ''}`);
const i = process.argv.indexOf('--url');
if (i > -1) {
  const base = process.argv[i + 1].replace(/\/$/, '');
  for (const p of ROUTES) {
    const res = await fetch(base + p, { redirect: 'manual' }).catch(() => ({ status: 0 }));
    console.log(`${res.status === 200 ? '✓' : '✗'} ${base}${p} → ${res.status}`);
    if (res.status !== 200) problems.push(`${base}${p} respondió ${res.status}`);
  }
}
if (problems.length) { console.error('\nRutas rotas (no se publica):\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('\nRutas OK');
