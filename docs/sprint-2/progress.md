# Sprint 2 — Progress

Live tracker for cross-chat recovery. Update after each phase. See `plan.md` for
full task detail and `done.md` (written at sprint end) for the handoff.

## Status: COMPLETE — #29–#34 done; gates green (224 tests); ready to push

Branch: `feature/sprint-2` (from `main` @ 5d84402).

## Task board

| # | Task | Depends on | Status |
|----|------|-----------|--------|
| #29 | Ink toolchain spike & gate (BLOCKING) | — | ✅ done (Producer-approved) |
| #30 | CLI dispatcher + `dashboard` subcommand | #29 | ✅ done |
| #31 | Snapshot client + polling hook | #29 | ✅ done |
| #32 | Dashboard view-model + Ink rendering | #29, #31 | ✅ done |
| #33 | Test suite (view-model + hook + light render) | #29, #31, #32 | ✅ done |
| #34 | Apache-2.0 license + dashboard docs + handoff | (docs ← #32) | ✅ done |

## Progress log

- **#29** (commit `7634076`): ink@7.1.0 + react@19.2.7 + react-devtools-core +
  @types/react + ink-testing-library wired; `jsx:react-jsx` (no `react` in
  `types`); vitest include widened to `{ts,tsx}`; second tsup entry. Toolchain
  verdict: integrates cleanly. Approved by Producer.
- **#30**: extracted the daemon into `src/cli/daemon.ts` (`runDaemon(argv)` +
  `appLayer`); `src/cli/main.ts` is now a thin dispatcher (`argv[0]==="dashboard"`
  → `runDashboard`, else `runDaemon`). Separate dashboard arg parser at
  `src/cli/dashboard/args.ts` (`--port/--host/--interval-ms/--ascii/--help`) — the
  daemon's `parseArgs` is untouched, its tests still green. Throwaway
  `dashboard.tsx` replaced with a real standalone entry that calls `runDashboard`;
  the #29 spike test removed (its purpose was served) and replaced by
  `test/dashboard/args.test.ts`. Placeholder Ink shell (`src/cli/dashboard/app.tsx`)
  renders + exits on q/Ctrl-C; the live fleet view lands in #32.
- **#31**: read-only data layer. `snapshot-client.ts` — typed `Snapshot` view +
  defensive `parseSnapshot` (throws `SnapshotParseError` on malformed bytes; keeps
  `rate_limits` opaque) + `makeFetchSnapshot(timeoutMs)` (combines caller signal with
  `AbortSignal.timeout`). `poller.ts` — framework-agnostic `SnapshotPoller`:
  non-overlapping (next poll scheduled only after the current settles), keeps the last
  good snapshot on failure (`connecting`→`live`→`stale`), `stop()` aborts in-flight +
  clears timer. `use-snapshot.ts` — thin React hook over the poller (injected fetcher;
  effect cleanup `stop()`s on unmount). Shipped with `snapshot-client.test.ts`; the
  fake-timer poller/hook tests land in #33 per the plan. Not yet wired into the UI.
- **#32**: live fleet view. `view-model.ts` — pure `toViewModel(snapshot, now, opts)`
  folds a (possibly null) `Snapshot` + connection state into a render-ready model:
  client-calculated `elapsed` from `started_at` (label only, no server trust),
  phase→operator-status via the core `PHASE_TO_STATUS` map (unknown phase → `running`),
  retrying rows carry identifier/attempt/error with **no countdown** (`due_at_ms` is
  monotonic), completed = count + most-recent IDs only (newest first), totals, and a
  **defensive** rate-limits summary (`null` → "unavailable"; unknown shape →
  one-line `JSON.stringify`, never assumes a schema). `components.tsx` — Ink `<Box>`
  layout (no hand-padded columns) reusing `glyphs.ts` (`glyph`/`statusStyle`,
  `ColorToken`→Ink `<Text color>`); honors `--ascii` and `NO_COLOR`/non-TTY via
  `shouldUseColor`. `app.tsx` wires `useSnapshot` + `toViewModel` + `DashboardView`;
  `q`/Ctrl-C unmount (hook cleanup aborts the in-flight fetch + clears the timer).
  `run.tsx` parses args, resolves color, injects `makeFetchSnapshot`, renders `<App>`.
  - **Robustness fix found via live PTY smoke:** Ink's `useInput` calls `setRawMode`,
    which throws on a non-TTY stdin (`stdin.isTTY` is `undefined`, not `false`). Gate
    the handler with `isActive: isRawModeSupported === true` (from `useStdin()`) so a
    piped/redirected invocation renders instead of crashing; the terminal still exits on
    SIGINT/SIGTERM.
- **#33**: tests (Ivy shape). `test/dashboard/fixtures.ts` shared builders;
  `view-model.test.ts` (13) covers the full state matrix — empty/connecting, running
  rich + elapsed + attempt label, phase→status incl. unknown→running, retrying-no-
  countdown (asserts no `due` leaks), completed IDs-only + newest-first + cap, totals,
  `rate_limits` null vs unknown-shape, stale+error banner, `formatDuration` units.
  `poller.test.ts` (5) fake-timer: no-overlap, stale-after-good retains snapshot,
  connecting-until-first-success, `stop()` aborts in-flight + no further polls,
  idempotent `start()`. `render.test.tsx` (4) light ink-testing-library asserts
  (populated / empty-connecting / ascii-glyph swap / stale banner). **224 tests total**
  (188 at #29 → −1 spike +37 dashboard). Live end-to-end PTY smoke against a canned
  snapshot server verified: honest render, non-overlapping polls, disconnect → `stale`
  with data retained (never blanks), clean exit.
- **#34**: licensing + handoff. Apache-2.0 `LICENSE` (full text) + `NOTICE`;
  `package.json` `"license": "Apache-2.0"` and a `dev:dashboard` script. README gains a
  **Dashboard** section (daemon `--port`, then `orchestra dashboard`, flags table) and a
  real **License** section. `docs/sprint-2/done.md` handoff written; `PROJECT_BRIEF.md`
  §5 (file map: dispatcher/daemon split + dashboard module), §7 (Sprint 2 ✅), and §8
  (current state rewrite) updated; the License open-question resolved in
  `docs/ideas-backlog.md`.

## Decisions (from the Sprint 2 design review)
- **Operational status, not history.** MVP = live fleet view; event feed / ring
  buffer / in-process `--tui` deferred.
- **Standalone polling client**, not in-process renderer → core loop untouched.
- **`orchestra dashboard` subcommand** via a thin top-level dispatcher; daemon
  arg parser left alone; core loop untouched.
- **React 19 + Ink 7** (Ink 7 peer-requires react ≥19.2). `#29` is a blocking
  toolchain gate — **rescope if it won't integrate cleanly**.
- **Plain React hook with injected fetch** for the UI island (no Effect↔Ink
  lifecycle bridging).
- **Honest rendering** of the snapshot: completed = IDs only; retrying has no
  countdown (monotonic `due_at_ms`).

## Notes / risks to watch
- `vitest.config.ts` include is `*.test.ts` today → must widen to `{ts,tsx}` or
  `.test.tsx` is silently skipped.
- `exactOptionalPropertyTypes` + JSX props → conditional spreads, not
  `prop={maybeUndefined}`.
- Single `tsup` config with the 2nd entry (avoid `clean:true` wiping output).
- Socket/CodeQL will scan react/ink — expected clean, but watch CI.
