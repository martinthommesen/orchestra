import { NodeSdk } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Layer } from "effect";

const SERVICE_NAME = "orchestra";
const VERSION = process.env.npm_package_version ?? "0.0.0";

export const telemetryEnabled = (): boolean => {
  if (process.env.OTEL_SDK_DISABLED === "true") return false;
  if (process.env.OTEL_TRACES_EXPORTER === "none") return false;
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return endpoint !== undefined && endpoint !== "";
};

/**
 * OpenTelemetry tracing layer. Exports Effect spans via OTLP/HTTP when a collector
 * endpoint is configured (`OTEL_EXPORTER_OTLP_ENDPOINT` or `_TRACES_ENDPOINT`), else a
 * no-op Layer so normal runs emit no wasted export requests to a nonexistent collector.
 */
export const TelemetryLive: Layer.Layer<never> = telemetryEnabled()
  ? NodeSdk.layer(() => ({
      resource: { serviceName: SERVICE_NAME, serviceVersion: VERSION },
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
    }))
  : Layer.empty;
