// Capturas con Playwright. Uso: node scripts/screenshots.mjs [baseUrl] [carpetaSalida]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // usa el Playwright instalado globalmente
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:3000';
const out = process.argv[3] || 'screenshots';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];
async function shot(name, url, { mobile = false, full = true, before, scrollTo } = {}) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-AR' }
    : { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, locale: 'es-AR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(base + url, { waitUntil: 'networkidle' });
  if (before) await before(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (scrollTo) await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView(), scrollTo);
  await page.waitForTimeout(400);
  // sin scroll horizontal
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: scroll horizontal de ${overflow}px`);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  await ctx.close();
  console.log('✓', name);
}

await shot('01-landing-celular', '/', { mobile: true });
await shot('02-landing-desktop', '/');
await shot('03-diagnostico-demo-desktop', '/demo#/diagnostico', {
  before: async (p) => { await p.click('details.item >> nth=0 >> summary'); },
});
await shot('04-diagnostico-demo-celular', '/demo#/diagnostico', {
  mobile: true,
  before: async (p) => { await p.click('[data-filter="SIN_VENTAS"] >> nth=0'); await p.click('details.item >> nth=0 >> summary'); },
});
await shot('05-rentabilidad-demo-desktop', '/demo#/rentabilidad');
await shot('06-rentabilidad-demo-celular', '/demo#/rentabilidad', { mobile: true });
await shot('07-alertas-demo', '/demo#/alertas');
await shot('08-email-alerta', '/api/email-preview?type=daily', { mobile: true });
await shot('09-email-semanal', '/api/email-preview?type=weekly', { mobile: true });
await shot('10-admin', '/admin?demo=1');
await shot('12-validacion-demo-desktop', '/admin?demo=1#validacion');
await shot('13-validacion-demo-celular', '/admin?demo=1#validacion', { mobile: true, full: false });
await shot('14-validacion-demo-celular-venta', '/admin?demo=1#validacion', { mobile: true, full: false, before: async (p) => { await p.waitForSelector('article'); } , scrollTo: 'article:nth-of-type(2)' });
await shot('11-landing-error-config', '/?error=config', { mobile: true, full: false });
await browser.close();
if (errors.length) { console.log('PROBLEMAS:\n' + errors.join('\n')); process.exitCode = 1; } else console.log('Sin errores de consola.');
