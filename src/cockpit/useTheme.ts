import { useEffect, useLayoutEffect, useState } from "react";

/**
 * Theme controller for the cockpit. With no stored choice the theme follows
 * `prefers-color-scheme`; an explicit choice is persisted to `localStorage` and written as
 * `data-theme` on `document.documentElement`, which `tokens.css` honors over the OS preference.
 * The attribute is written in a `useLayoutEffect` — after the first commit but **before the
 * browser paints** — so the very first visible frame is already in the resolved theme (no flash).
 * (Client-rendered SPA; no SSR, so the layout effect is safe.)
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "orchestra-cockpit-theme";

const prefersLight = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia !== undefined &&
  window.matchMedia("(prefers-color-scheme: light)").matches;

const storedTheme = (): Theme | null => {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "dark" || v === "light" ? v : null;
};

export const resolveTheme = (): Theme => storedTheme() ?? (prefersLight() ? "light" : "dark");

const applyTheme = (theme: Theme): void => {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
};

export const useTheme = (): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } => {
  const [theme, setThemeState] = useState<Theme>(resolveTheme);

  // Apply before paint on mount and whenever it changes (pre-paint → no theme flash).
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia === undefined) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (storedTheme() === null) setThemeState(prefersLight() ? "light" : "dark");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = (next: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  };

  const toggle = () => setTheme(theme === "dark" ? "light" : "dark");

  return { theme, toggle, setTheme };
};
