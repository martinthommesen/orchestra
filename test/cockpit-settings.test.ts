import { describe, expect, it } from "vitest";
import type { EditableSettingsWire } from "../src/cockpit/api/types";
import {
  type SettingsFormModel,
  toFormModel,
  validateSettings,
} from "../src/cockpit/model/settings";

const WIRE: EditableSettingsWire = {
  polling: { interval_ms: 30000 },
  agent: {
    max_concurrent_agents: 10,
    max_concurrent_agents_by_state: { triage: 2, build: 4 },
    max_turns: 20,
    max_retry_backoff_ms: 60000,
  },
  budget: { max_total_tokens: 100000 },
};

const validForm = (): SettingsFormModel => toFormModel(WIRE);

describe("toFormModel", () => {
  it("maps the whitelisted wire settings into string form fields", () => {
    const f = toFormModel(WIRE);
    expect(f.intervalMs).toBe("30000");
    expect(f.maxConcurrentAgents).toBe("10");
    expect(f.maxTurns).toBe("20");
    expect(f.maxRetryBackoffMs).toBe("60000");
    expect(f.maxTotalTokens).toBe("100000");
    expect(f.byState).toEqual([
      { state: "build", value: "4" },
      { state: "triage", value: "2" },
    ]);
  });

  it("renders a null token ceiling as an empty field", () => {
    const f = toFormModel({ ...WIRE, budget: { max_total_tokens: null } });
    expect(f.maxTotalTokens).toBe("");
  });

  it("never surfaces a secret/tracker key (whitelist only)", () => {
    const f = toFormModel(WIRE);
    const serialized = JSON.stringify(f).toLowerCase();
    expect(serialized).not.toContain("tracker");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("secret");
  });
});

describe("validateSettings", () => {
  it("accepts a valid form and builds the whitelisted patch", () => {
    const r = validateSettings(validForm());
    expect(r.ok).toBe(true);
    expect(r.patch).toEqual({
      polling: { interval_ms: 30000 },
      agent: {
        max_concurrent_agents: 10,
        max_turns: 20,
        max_retry_backoff_ms: 60000,
        max_concurrent_agents_by_state: { triage: 2, build: 4 },
      },
      budget: { max_total_tokens: 100000 },
    });
  });

  it("the built patch contains only whitelisted keys (no secret leaks)", () => {
    const r = validateSettings(validForm());
    expect(Object.keys(r.patch ?? {}).sort()).toEqual(["agent", "budget", "polling"]);
    expect(JSON.stringify(r.patch).toLowerCase()).not.toContain("tracker");
  });

  it("maps a blank token field to a null ceiling (clears it)", () => {
    const r = validateSettings({ ...validForm(), maxTotalTokens: "  " });
    expect(r.ok).toBe(true);
    expect(r.patch?.budget?.max_total_tokens).toBeNull();
  });

  it.each([
    ["intervalMs", "0"],
    ["intervalMs", "-5"],
    ["maxConcurrentAgents", "1.5"],
    ["maxTurns", "abc"],
    ["maxRetryBackoffMs", ""],
  ])("rejects %s = %j as not a positive integer", (field, value) => {
    const r = validateSettings({ ...validForm(), [field]: value } as SettingsFormModel);
    expect(r.ok).toBe(false);
    expect(r.patch).toBeUndefined();
    expect(r.errors[field as keyof typeof r.errors]).toBeDefined();
  });

  it("rejects an invalid per-state value with a keyed error and no patch", () => {
    const form: SettingsFormModel = {
      ...validForm(),
      byState: [
        { state: "triage", value: "2" },
        { state: "build", value: "0" },
      ],
    };
    const r = validateSettings(form);
    expect(r.ok).toBe(false);
    expect(r.errors["byState:build"]).toBeDefined();
    expect(r.errors["byState:triage"]).toBeUndefined();
  });

  it("rejects a non-integer token ceiling but accepts a valid one", () => {
    expect(validateSettings({ ...validForm(), maxTotalTokens: "1.5" }).ok).toBe(false);
    const ok = validateSettings({ ...validForm(), maxTotalTokens: "5000" });
    expect(ok.ok).toBe(true);
    expect(ok.patch?.budget?.max_total_tokens).toBe(5000);
  });
});
