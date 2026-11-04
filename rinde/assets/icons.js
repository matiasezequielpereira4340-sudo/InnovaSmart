// Íconos SVG inline (trazo, heredan el color del texto).
const s = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
export const I = {
  alert: s('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  down: s('<path d="M3 7l6 6 4-4 8 8"/><path d="M21 11v6h-6"/>'),
  up: s('<path d="M3 17l6-6 4 4 8-8"/><path d="M21 13V7h-6"/>'),
  eyeoff: s('<path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 4.1-5.1M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.4M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"/>'),
  cart: s('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>'),
  check: s('<path d="M20 6 9 17l-5-5"/>'),
  checkCircle: s('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>'),
  x: s('<path d="M18 6 6 18M6 6l12 12"/>'),
  shield: s('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  lock: s('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  chart: s('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  money: s('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
  bell: s('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  search: s('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  plug: s('<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4"/>'),
  sparkle: s('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  chat: s('<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2-5.4A8.4 8.4 0 1 1 21 11.5z"/>'),
  chevron: s('<path d="m6 9 6 6 6-6"/>'),
  arrow: s('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  download: s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>'),
  upload: s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>'),
  refresh: s('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>'),
  logout: s('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  trash: s('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  loader: s('<path d="M21 12a9 9 0 1 1-9-9"/>'),
  circle: s('<circle cx="12" cy="12" r="9"/>'),
  list: s('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  calendar: s('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  info: s('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  mail: s('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>'),
  user: s('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  tag: s('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>'),
};
export const LOGO_MARK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="ml" d="M4 18 10 11l4 4 6-8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle class="md" cx="20" cy="7" r="2"/></svg>';

/** Reemplaza <i data-i="nombre"></i> por el SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-i]').forEach((el) => {
    const svg = I[el.dataset.i];
    if (svg) el.outerHTML = svg;
  });
  root.querySelectorAll('[data-logo]').forEach((el) => { el.innerHTML = LOGO_MARK; });
}
