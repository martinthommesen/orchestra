import { describe, expect, it } from "vitest";
import { COLOR_TOKEN_VAR } from "../src/cockpit/design/tokens";
import { badgeOf } from "../src/cockpit/model/fleet";
import { parseRoute, ROUTE_LABELS, ROUTES, routeHref } from "../src/cockpit/router";
import { STATUS_STYLES, type Status } from "../src/core/observability/glyphs";

describe("cockpit design tokens — single source of truth parity", () => {
  const statuses = Object.keys(STATUS_STYLES) as Status[];

  it("exposes a CSS var for every semantic color token used by the statuses", () => {
    for (const status of statuses) {
      const semanticColor = STATUS_STYLES[status].color;
      expect(COLOR_TOKEN_VAR[semanticColor]).toMatch(/^--status-/);
    }
  });

  it("badgeOf mirrors the glyph + label from glyphs.ts and binds the matching color var", () => {
    for (const status of statuses) {
      const style = STATUS_STYLES[status];
      const badge = badgeOf(status);
      expect(badge.glyph).toBe(style.glyph);
      expect(badge.label).toBe(style.label);
      expect(badge.colorVar).toBe(`var(${COLOR_TOKEN_VAR[style.color]})`);
      expect(badge.known).toBe(true);
    }
  });

  it("covers all five statuses with distinct glyphs and color vars", () => {
    expect(statuses).toHaveLength(5);
    expect(new Set(statuses.map((s) => badgeOf(s).glyph)).size).toBe(5);
    expect(new Set(statuses.map((s) => badgeOf(s).colorVar)).size).toBe(5);
  });
});

describe("cockpit router (pure)", () => {
  it("lists the four nav targets in order with labels", () => {
    expect(ROUTES).toEqual(["fleet", "kanban", "events", "settings"]);
    expect(ROUTE_LABELS.fleet).toBe("Fleet");
    expect(ROUTE_LABELS.settings).toBe("Settings");
  });

  it("parses known hashes case-insensitively", () => {
    expect(parseRoute("#/kanban")).toBe("kanban");
    expect(parseRoute("#kanban")).toBe("kanban");
    expect(parseRoute("#/EVENTS")).toBe("events");
    expect(parseRoute("#/settings")).toBe("settings");
  });

  it("defaults unknown / empty hashes to fleet", () => {
    expect(parseRoute("")).toBe("fleet");
    expect(parseRoute("#")).toBe("fleet");
    expect(parseRoute("#/nope")).toBe("fleet");
  });

  it("round-trips route ↔ href", () => {
    for (const r of ROUTES) {
      expect(parseRoute(routeHref(r))).toBe(r);
    }
  });
});
