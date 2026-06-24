# Sprint 2 — Progress

Live tracker for cross-chat recovery. Update after each phase. See `plan.md` for
full task detail and `done.md` (written at sprint end) for the handoff.

## Status: NOT STARTED — issues seeded, awaiting dev kickoff

Branch: `feature/sprint-2` (from `main` @ 5d84402).

## Task board

| # | Task | Depends on | Status |
|----|------|-----------|--------|
| #29 | Ink toolchain spike & gate (BLOCKING) | — | pending |
| #30 | CLI dispatcher + `dashboard` subcommand | #29 | pending |
| #31 | Snapshot client + polling hook | #29 | pending |
| #32 | Dashboard view-model + Ink rendering | #29, #31 | pending |
| #33 | Test suite (view-model + hook + light render) | #29, #31, #32 | pending |
| #34 | Apache-2.0 license + dashboard docs + handoff | (docs ← #32) | pending |

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
