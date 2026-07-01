import { NodeSdk } from "@effect/opentelemetry";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telemetryEnabled } from "../src/core/observability/telemetry";

it("exports Effect spans through the NodeSdk layer", async () => {
  const exporter = new InMemorySpanExporter();
  const TestTelemetry = NodeSdk.layer(() => ({
    resource: { serviceName: "orchestra-test" },
    spanProcessor: new SimpleSpanProcessor(exporter),
  }));

  // Read the span names inside the Effect while the layer scope is still open.
  // InMemorySpanExporter.shutdown() clears _finishedSpans, so we must capture
  // before the scope closes (which happens after the outer Effect completes).
  const names = await Effect.runPromise(
    Effect.void.pipe(
      Effect.withSpan("test.span"),
      Effect.andThen(Effect.sync(() => exporter.getFinishedSpans().map((s) => s.name))),
      Effect.provide(TestTelemetry),
    ),
  );

  expect(names).toContain("test.span");
});

// ── telemetryEnabled gating logic ───────────────────────────────────────────

const GATING_ENV_VARS = [
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
] as const;

type GatingEnv = Record<(typeof GATING_ENV_VARS)[number], string | undefined>;

describe("telemetryEnabled gating", () => {
  let saved: GatingEnv;

  beforeEach(() => {
    saved = Object.fromEntries(GATING_ENV_VARS.map((k) => [k, process.env[k]])) as GatingEnv;
    for (const k of GATING_ENV_VARS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of GATING_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns false when no endpoint is set", () => {
    expect(telemetryEnabled()).toBe(false);
  });

  it("returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    expect(telemetryEnabled()).toBe(true);
  });

  it("returns true when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
    expect(telemetryEnabled()).toBe(true);
  });

  it("returns false when endpoint is set but OTEL_SDK_DISABLED=true", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_SDK_DISABLED = "true";
    expect(telemetryEnabled()).toBe(false);
  });

  it("returns false when endpoint is set but OTEL_TRACES_EXPORTER=none", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_TRACES_EXPORTER = "none";
    expect(telemetryEnabled()).toBe(false);
  });

  it("returns false when endpoint is whitespace-only (proves .trim())", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "   ";
    expect(telemetryEnabled()).toBe(false);
  });
});
