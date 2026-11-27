import en from './locales/en.js';

/**
 * Supported locale registry.
 * To add a new language:
 *   1. Create `ui/locales/<code>.js` exporting a flat key->string dictionary.
 *   2. Add an entry to `LOCALES` below.
 */
export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' }
];

const STORAGE_KEY = 'mcp_shelf_lang';
const loaded = new Map([['en', en]]);
let current = 'en';

export function normalizeLocale(raw) {
  if (!raw) return 'en';
  const s = String(raw).trim().toLowerCase();
  const exact = LOCALES.find((l) => l.code.toLowerCase() === s);
  if (exact) return exact.code;
  if (s.startsWith('zh')) return 'zh-CN';
  const base = s.split('-')[0];
  const prefix = LOCALES.find((l) => l.code.toLowerCase().startsWith(base));
  return prefix ? prefix.code : 'en';
}

export function detectLocale() {
  const param = new URLSearchParams(location.search).get('lang');
  if (param) return normalizeLocale(param);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeLocale(saved);
  } catch {}
  return 'en';
}

export function getLocale() {
  return current;
}

export async function setLocale(code, persist = true) {
  const next = normalizeLocale(code);
  if (!loaded.has(next)) {
    try {
      const mod = await import(`/locales/${next}.js`);
      loaded.set(next, mod.default || {});
    } catch {
      return current;
    }
  }
  current = next;
  document.documentElement.lang = next;
  document.title = t('app.title');
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }
  return current;
}

export function t(key, vars = {}) {
  const dict = loaded.get(current) || en;
  let template = Object.hasOwn(dict, key) ? dict[key] : Object.hasOwn(en, key) ? en[key] : key;
  for (const [k, v] of Object.entries(vars)) {
    template = template.replaceAll(`{${k}}`, String(v));
  }
  return template;
}

export function applyStaticTranslations() {
  document.title = t('app.title');
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  }
}
