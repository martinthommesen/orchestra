# Orchestra Status Design System

> Sprint 0, Task 8. Implemented in `src/core/observability/glyphs.ts`.
> Used by v1 structured logs; reused by the post-v1 TUI. This is the **one** place
> status glyphs, colors, and truncation rules are defined — don't hand-roll them
> elsewhere.

## Principles

1. **One vocabulary, two renderers.** The same five statuses render in logfmt logs
   (v1) and a future TUI. Define once, reuse everywhere.
2. **Pure & dependency-free.** `glyphs.ts` has no Effect, no IO, no npm deps — it's
   safe to call from any layer and trivial to unit-test.
3. **Color is opt-in and respectful.** Never emit ANSI unless asked; honor
   [`NO_COLOR`](https://no-color.org) and non-TTY sinks. Structured logs stay
   color-free by default so they grep/parse cleanly.
4. **Every glyph has an ASCII fallback.** Terminals and log sinks that can't render
   Unicode still get a legible status.
5. **Truncate aggressively in logs.** One event = one line. Multi-line agent/hook
   output is collapsed and capped so it can never break a record or leak volume.

## The five statuses

| Status     | Glyph | ASCII | Color token       | Meaning                                                                          |
| ---------- | :---: | :---: | ----------------- | -------------------------------------------------------------------------------- |
| `running`  |  `▶`  |  `>`  | `info` (cyan)     | A worker is actively preparing, prompting, or streaming a turn.                  |
| `retrying` | `⏳`  |  `~`  | `warn` (yellow)   | A retryable fault (timeout/stall/failed attempt) is backing off for another try. |
| `blocked`  |  `⏸`  |  `=`  | `muted` (gray)    | Withdrawn or waiting — cancelled by reconciliation, or awaiting input.           |
| `done`     |  `✓`  |  `+`  | `success` (green) | Reached the workflow handoff/terminal state successfully.                        |
| `failed`   |  `✗`  |  `x`  | `danger` (red)    | Terminal failure with no further retry.                                          |

`formatStatus("running")` → `▶ running`. With `{ color: true }` the badge is wrapped in
the status' semantic color; with `{ ascii: true }` it renders `> running`.

## Color tokens

Semantic tokens decouple meaning from concrete ANSI codes (so a TUI theme can remap
them without touching call sites):

| Token     | ANSI (SGR)  | Used by                           |
| --------- | ----------- | --------------------------------- |
| `info`    | `36` cyan   | `running`                         |
| `warn`    | `33` yellow | `retrying`                        |
| `muted`   | `90` gray   | `blocked`, de-emphasized metadata |
| `success` | `32` green  | `done`                            |
| `danger`  | `31` red    | `failed`, error text              |

`colorize(text, token, enabled)` wraps text in the token's SGR + reset.
`shouldUseColor({ env, isTTY })` decides `enabled`: `NO_COLOR` set → never;
`FORCE_COLOR` set → always; otherwise follow the TTY bit.

## Truncation rules

| Helper                           | Rule                                                                                      | Use for                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `truncate(text, max=120)`        | Cut to `max` chars; append `…` (counts toward the budget, so output never exceeds `max`). | single-value log fields                                              |
| `truncateOneLine(text, max=120)` | Collapse all whitespace/newlines → single spaces, trim, then `truncate`.                  | **agent messages and hook output** in logs (PROJECT_BRIEF §9.2/§9.4) |

`DEFAULT_MAX_LEN = 120`, `ELLIPSIS = "…"`. Rationale: 120 keeps a status + identifier +
message comfortably on one line in a typical terminal while preserving enough of the
message to be useful. Hook/agent output **must** go through `truncateOneLine` — it both
keeps logs one-line-per-event and bounds the blast radius of accidental secret echo.

## Mapping the domain to statuses

The orchestrator tracks a granular `RunAttemptPhase` (SPEC §7.2, 11 phases).
`phaseStatus(phase)` rolls those up to the five operator-facing statuses via the total
`PHASE_TO_STATUS` map (exhaustive — a new phase is a compile error until mapped):

- `PreparingWorkspace`, `BuildingPrompt`, `LaunchingAgentProcess`,
  `InitializingSession`, `StreamingTurn`, `Finishing` → **running**
- `Succeeded` → **done**
- `Failed` → **failed**
- `TimedOut`, `Stalled` → **retrying** (these are the retryable faults)
- `CanceledByReconciliation` → **blocked** (withdrawn, not failed)

## Example (v1 log line)

```ts
import {
  formatStatus,
  truncateOneLine,
  phaseStatus,
} from "../core/observability/glyphs";

// human-facing, colorized when attached to a TTY:
formatStatus(phaseStatus("StreamingTurn"), { color: true }); // "▶ running" (cyan)

// structured log annotations stay plain + bounded:
yield *
  Effect.logInfo("agent turn").pipe(
    Effect.annotateLogs({
      issue: issue.identifier,
      status: phaseStatus(attempt.status), // "running"
      glyph: glyph(phaseStatus(attempt.status)), // "▶"
      message: truncateOneLine(lastAgentMessage), // one line, ≤120 chars
    }),
  );
```

## Accessibility / robustness notes

- Color is **never** the only signal — the glyph **and** the text label always carry
  the status, so color-blind operators and no-color sinks lose nothing.
- ASCII fallbacks exist for every glyph; pass `{ ascii: true }` (a future
  `--no-unicode` flag can flip this globally).
- Glyphs were chosen to be single display-width where the terminal cooperates; the
  emoji-class `⏳`/`⏸` may render double-width in some terminals — acceptable for v1
  logs, revisited if the TUI needs strict column alignment.
