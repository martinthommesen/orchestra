import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ColorToken, Status } from "../../core/observability/glyphs";
import { glyph, statusStyle } from "../../core/observability/glyphs";
import type { DashboardViewModel, RetryingRowVM, RunningRowVM, TotalsVM } from "./view-model";

/**
 * Presentational Ink components for the dashboard (#32). They are deliberately dumb:
 * every decision (status rollup, elapsed, truncation, rate-limit defensiveness) already
 * happened in {@link file://./view-model.ts}. Layout is via Ink `<Box>` (column widths,
 * not hand-padded spaces). Color reuses the design-system {@link ColorToken} palette and
 * is gated by `color` so `NO_COLOR` / non-TTY render plain; glyphs honor `ascii`.
 */

/** Map a semantic design-system token to an Ink named color. */
const INK_COLOR: Record<ColorToken, string> = {
  info: "cyan",
  warn: "yellow",
  muted: "gray",
  success: "green",
  danger: "red",
};

interface Themed {
  readonly ascii: boolean;
  readonly color: boolean;
}

interface TintedProps {
  readonly tone: ColorToken;
  readonly color: boolean;
  readonly bold?: boolean;
  readonly children: ReactNode;
}

/** `<Text>` whose color/bold are applied only when enabled (exactOptionalPropertyTypes). */
function Tinted({ tone, color, bold, children }: TintedProps) {
  const colorProps = color ? { color: INK_COLOR[tone] } : {};
  const boldProps = bold ? { bold: true } : {};
  return (
    <Text {...colorProps} {...boldProps}>
      {children}
    </Text>
  );
}

/** Muted (gray) text, gated by the color flag. */
function Dim({ color, children }: { readonly color: boolean; readonly children: ReactNode }) {
  return (
    <Tinted tone="muted" color={color}>
      {children}
    </Tinted>
  );
}

function StatusBadge({ status, ascii, color }: { readonly status: Status } & Themed) {
  const style = statusStyle(status);
  return (
    <Tinted tone={style.color} color={color}>
      {glyph(status, ascii)} {style.label}
    </Tinted>
  );
}

function Header({ vm, color }: { readonly vm: DashboardViewModel; readonly color: boolean }) {
  const h = vm.header;
  const meta =
    `running ${h.runningCount} · retrying ${h.retryingCount} · completed ${h.completedCount}` +
    (h.pollIntervalMs !== null ? ` · poll ${h.pollIntervalMs}ms` : "") +
    (h.maxConcurrentAgents !== null ? ` · cap ${h.maxConcurrentAgents}` : "");
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>orchestra dashboard</Text>
        <Dim color={color}> · {h.baseUrl}</Dim>
      </Box>
      <Box>
        <Text>status </Text>
        <Tinted tone={h.connectionColor} color={color} bold>
          {h.connectionLabel}
        </Tinted>
        {h.updatedLabel !== null ? <Dim color={color}> · {h.updatedLabel}</Dim> : null}
      </Box>
      <Dim color={color}>{meta}</Dim>
      {h.error !== null ? (
        <Tinted tone="danger" color={color}>
          ! {h.error}
        </Tinted>
      ) : null}
    </Box>
  );
}

function RunningRow({ row, ascii, color }: { readonly row: RunningRowVM } & Themed) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={14}>
          <Text>{row.identifier}</Text>
        </Box>
        <Box width={12}>
          <StatusBadge status={row.status} ascii={ascii} color={color} />
        </Box>
        <Box width={9}>
          <Text>{row.elapsedLabel}</Text>
        </Box>
        <Box width={5}>
          <Text>{row.attemptLabel}</Text>
        </Box>
        <Box flexGrow={1}>
          <Dim color={color}>{row.workspace}</Dim>
        </Box>
      </Box>
      {row.error !== null ? (
        <Box marginLeft={2}>
          <Tinted tone="danger" color={color}>
            ! {row.error}
          </Tinted>
        </Box>
      ) : null}
    </Box>
  );
}

function RetryingRow({ row, color }: { readonly row: RetryingRowVM; readonly color: boolean }) {
  return (
    <Box>
      <Box width={14}>
        <Text>{row.identifier}</Text>
      </Box>
      <Box width={6}>
        <Text>{row.attemptLabel}</Text>
      </Box>
      <Box flexGrow={1}>
        <Dim color={color}>{row.error}</Dim>
      </Box>
    </Box>
  );
}

function Section({
  title,
  count,
  color,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly color: boolean;
  readonly children: ReactNode;
}) {
  const heading = count === undefined ? title : `${title} (${count})`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Dim color={color}>{heading}</Dim>
      {children}
    </Box>
  );
}

function Totals({ totals }: { readonly totals: TotalsVM }) {
  return (
    <Box marginLeft={2}>
      <Text>
        tokens in {totals.inputTokens} · out {totals.outputTokens} · total {totals.totalTokens} ·
        runtime {totals.runtimeLabel}
      </Text>
    </Box>
  );
}

/** The whole dashboard, rendered from a fully-computed view model. */
export function DashboardView({ vm, ascii, color }: { readonly vm: DashboardViewModel } & Themed) {
  return (
    <Box flexDirection="column">
      <Header vm={vm} color={color} />

      <Section title="RUNNING" count={vm.running.length} color={color}>
        {vm.running.length === 0 ? (
          <Box marginLeft={2}>
            <Dim color={color}>none</Dim>
          </Box>
        ) : (
          vm.running.map((row) => (
            <RunningRow key={row.issueId} row={row} ascii={ascii} color={color} />
          ))
        )}
      </Section>

      <Section title="RETRYING" count={vm.retrying.length} color={color}>
        {vm.retrying.length === 0 ? (
          <Box marginLeft={2}>
            <Dim color={color}>none</Dim>
          </Box>
        ) : (
          vm.retrying.map((row) => <RetryingRow key={row.issueId} row={row} color={color} />)
        )}
      </Section>

      <Section title="COMPLETED" count={vm.completed.count} color={color}>
        <Box marginLeft={2}>
          {vm.completed.count === 0 ? (
            <Dim color={color}>none</Dim>
          ) : (
            <Text>
              {vm.completed.recentIds.join(" ")}
              {vm.completed.count > vm.completed.recentIds.length ? " …" : ""}
            </Text>
          )}
        </Box>
      </Section>

      <Section title="TOTALS" color={color}>
        {vm.totals === null ? (
          <Box marginLeft={2}>
            <Dim color={color}>—</Dim>
          </Box>
        ) : (
          <Totals totals={vm.totals} />
        )}
      </Section>

      <Section title="RATE LIMITS" color={color}>
        <Box marginLeft={2}>
          {vm.rateLimits.available ? (
            <Text>{vm.rateLimits.summary}</Text>
          ) : (
            <Dim color={color}>{vm.rateLimits.summary}</Dim>
          )}
        </Box>
      </Section>

      <Box marginTop={1}>
        <Dim color={color}>press q to quit</Dim>
      </Box>
    </Box>
  );
}
