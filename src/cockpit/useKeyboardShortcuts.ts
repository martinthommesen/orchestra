import { useEffect } from "react";
import { ROUTE_KEY, ROUTES, type Route } from "./router";

/**
 * Sprint 6 — keyboard navigation for the cockpit (power-operator affordance). A two-key,
 * `g`-prefixed sequence (e.g. `g` then `f`) jumps to a view, matching the convention operators
 * already know from GitHub/Gmail and keeping single keys free for future per-view actions. The
 * suffix→route map is derived from `ROUTE_KEY` so the shortcuts and the nav hints share one source.
 * Typing in a field is never hijacked.
 */

const PREFIX_WINDOW_MS = 1200;

const ROUTE_FOR_KEY: Record<string, Route> = Object.fromEntries(
  ROUTES.map((route) => [ROUTE_KEY[route], route]),
);

const isEditable = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
};

export const useKeyboardShortcuts = (navigate: (route: Route) => void): void => {
  useEffect(() => {
    let prefixAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      const key = e.key.toLowerCase();
      const now = Date.now();
      if (now - prefixAt <= PREFIX_WINDOW_MS) {
        prefixAt = 0;
        const route = ROUTE_FOR_KEY[key];
        if (route !== undefined) {
          e.preventDefault();
          navigate(route);
        }
        return;
      }
      if (key === "g") prefixAt = now;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
};
