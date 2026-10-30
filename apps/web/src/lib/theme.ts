import { useSyncExternalStore } from 'react';

/** What the user picked; `system` follows `prefers-color-scheme`. */
export type ThemePreference = 'dark' | 'light' | 'system';
type Theme = Exclude<ThemePreference, 'system'>;

/** Keep in sync with the inline script in index.html, which applies the theme before first paint. */
const storageKey = 'mcp-theme';
const lightQuery = '(prefers-color-scheme: light)';
const switchMs = 250;

let preference: ThemePreference = 'system';
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch {
    return 'system';
  }
}

function resolve(value: ThemePreference): Theme {
  if (value !== 'system') return value;
  return window.matchMedia(lightQuery).matches ? 'light' : 'dark';
}

let clearSwitching: number | undefined;
function apply(animate: boolean) {
  const theme = resolve(preference);
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    // Cross-fade colours only for a visible switch, and never under reduced motion.
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.classList.add('theme-switching');
      window.clearTimeout(clearSwitching);
      clearSwitching = window.setTimeout(() => root.classList.remove('theme-switching'), switchMs);
    }
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }
  for (const listener of listeners) listener();
}

/** Sync with storage, follow live system changes and other tabs. Call once at startup. */
export function initTheme() {
  preference = readPreference();
  apply(false);
  window.matchMedia(lightQuery).addEventListener('change', () => {
    if (preference === 'system') apply(true);
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    preference = readPreference();
    apply(true);
  });
}

export function setThemePreference(next: ThemePreference) {
  try {
    if (next === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
  } catch {
    // Storage can be unavailable (private mode); the choice still applies to this page.
  }
  preference = next;
  apply(true);
}

export function useThemePreference() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preference,
  );
}
