import { useEffect, useState } from "react";
import { parseRoute, type Route, routeHref } from "./router";

/**
 * DOM binding for the hash router (#68). Keeps React state in sync with `location.hash` and
 * exposes a `navigate` that updates the hash (the `hashchange` listener then re-renders). Split
 * from `router.ts` so the pure parse/serialize stays Node-testable without pulling in the DOM.
 */
const navigate = (next: Route) => {
  window.location.hash = routeHref(next);
};

export const useRoute = (): { route: Route; navigate: (route: Route) => void } => {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return { route, navigate };
};
