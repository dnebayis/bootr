'use client';

/**
 * Minimal class-strategy theme (replaces next-themes, whose provider renders its no-flash <script>
 * from a client component, which React 19 warns about). Same contract: localStorage key `theme`
 * ('light' | 'dark' | 'system', default 'system'), `.light` / `.dark` on <html>, `color-scheme` set.
 * The no-flash script is `THEME_SCRIPT`, rendered in <head> by the root layout (a server component).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

export type ThemeSetting = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const KEY = 'theme';
const MQ = '(prefers-color-scheme: dark)';

function readSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const settingListeners = new Set<() => void>();
function subscribeSetting(cb: () => void) {
  settingListeners.add(cb);
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener('storage', onStorage);
  return () => {
    settingListeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

function subscribeSystem(cb: () => void) {
  const m = window.matchMedia(MQ);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

function apply(resolved: Resolved) {
  const el = document.documentElement;
  // Suppress transitions for one frame so the swap is instant everywhere.
  const style = document.createElement('style');
  style.appendChild(document.createTextNode('*,*::before,*::after{transition:none!important}'));
  document.head.appendChild(style);
  el.classList.remove('light', 'dark');
  el.classList.add(resolved);
  el.style.colorScheme = resolved;
  void window.getComputedStyle(document.body).opacity;
  setTimeout(() => style.remove(), 1);
}

type Ctx = { theme: ThemeSetting; resolvedTheme: Resolved | undefined; setTheme: (t: ThemeSetting) => void };
const ThemeContext = createContext<Ctx>({ theme: 'system', resolvedTheme: undefined, setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeSetting, readSetting, () => 'system' as ThemeSetting);
  const systemDark = useSyncExternalStore(subscribeSystem, () => window.matchMedia(MQ).matches, () => false);
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const resolvedTheme: Resolved | undefined = mounted ? (theme === 'system' ? (systemDark ? 'dark' : 'light') : theme) : undefined;

  useEffect(() => {
    if (resolvedTheme && !document.documentElement.classList.contains(resolvedTheme)) apply(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((t: ThemeSetting) => {
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage unavailable: theme still applies for this page view */
    }
    settingListeners.forEach((l) => l());
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
