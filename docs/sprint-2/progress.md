# Sprint 2 — Progress

Live tracker for cross-chat recovery. Update after each phase. See `plan.md` for
full task detail and `done.md` (written at sprint end) for the handoff.

## Status: IN PROGRESS — #29 approved, #30–#31 done

Branch: `feature/sprint-2` (from `main` @ 5d84402).

## Task board

| # | Task | Depends on | Status |
|----|------|-----------|--------|
| #29 | Ink toolchain spike & gate (BLOCKING) | — | ✅ done (Producer-approved) |
| #30 | CLI dispatcher + `dashboard` subcommand | #29 | ✅ done |
| #31 | Snapshot client + polling hook | #29 | ✅ done |
| #32 | Dashboard view-model + Ink rendering | #29, #31 | pending |
| #33 | Test suite (view-model + hook + light render) | #29, #31, #32 | pending |
| #34 | Apache-2.0 license + dashboard docs + handoff | (docs ← #32) | pending |

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
