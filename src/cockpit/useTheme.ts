import { useEffect, useState } from "react";

/**
 * Theme controller for the cockpit. With no stored choice the theme follows
 * `prefers-color-scheme`; an explicit choice is persisted to `localStorage` and written as
 * `data-theme` on `document.documentElement`, which `tokens.css` honors over the OS preference.
 * The initial attribute is set synchronously during the first render so the very first paint is
 * already in the right theme (no flash).
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

  // Apply on mount and whenever it changes; also track OS preference changes when unpinned.
  useEffect(() => {
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
