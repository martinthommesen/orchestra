import { describe, expect, it } from "vitest";
import {
  COLOR_TOKEN_VAR,
  LEVEL_COLOR_TOKEN,
  levelColorVar,
  statusVisual,
} from "../src/cockpit/design/tokens";
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

  it("statusVisual mirrors glyph + ascii + label from glyphs.ts verbatim", () => {
    for (const status of statuses) {
      const style = STATUS_STYLES[status];
      const v = statusVisual(status);
      expect(v.glyph).toBe(style.glyph);
      expect(v.ascii).toBe(style.ascii);
      expect(v.label).toBe(style.label);
      expect(v.colorVar).toBe(`var(${COLOR_TOKEN_VAR[style.color]})`);
    }
  });

  it("covers all five statuses with distinct glyphs and color vars", () => {
    expect(statuses).toHaveLength(5);
    const glyphs = new Set(statuses.map((s) => statusVisual(s).glyph));
    expect(glyphs.size).toBe(5);
  });

  it("maps event levels to color vars (info muted, warn highlighted)", () => {
    expect(LEVEL_COLOR_TOKEN.info).toBe("muted");
    expect(LEVEL_COLOR_TOKEN.warn).toBe("warn");
    expect(levelColorVar("info")).toBe(`var(${COLOR_TOKEN_VAR.muted})`);
    expect(levelColorVar("warn")).toBe(`var(${COLOR_TOKEN_VAR.warn})`);
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
