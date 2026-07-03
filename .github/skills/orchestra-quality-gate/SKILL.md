---
name: orchestra-quality-gate
description: >-
  Run Orchestra's full quality gate before committing or opening a PR. Executes
  pnpm check (typecheck + lint + test + doctor:score), reports which gates pass
  or fail, and lists any actionable failures with the command to auto-fix them.
  Use when the user says "run the gate", "check before PR", "is this ready to
  commit", or asks if the code is clean.
version: "1.0.0"
---

# Orchestra Quality Gate

Run the full quality gate for the Orchestra codebase before committing or opening a PR.

## Steps

### 1. Run the full gate

```bash
pnpm check
```

This is equivalent to:

```bash
pnpm typecheck   # tsc --noEmit (strict, both tsconfig.json + tsconfig.cockpit.json)
pnpm lint        # biome check . && prettier --check "**/*.{md,yml,yaml,html}"
pnpm test        # vitest run (429 tests, 39 files)
pnpm doctor:score  # react-doctor health check (must stay 100/100)
```

### 2. Interpret results

Report each gate as ✅ PASS or ❌ FAIL with the exit code and relevant error lines.

**Expected baseline**: the following files have pre-existing prettier failures that
are the owner's in-progress work — do NOT attempt to fix them:

- `src/cockpit/index.html`
- `.impeccable/critique/*.md`

Any failure outside that set is a new issue that must be fixed.

### 3. Auto-fix lint/format issues

If `pnpm lint` fails on files you own, run:

```bash
pnpm lint:fix   # biome check --write . && prettier --write "**/*.{md,yml,yaml,html}"
```

Then re-run `pnpm lint` to confirm clean.

### 4. Fix type errors

If `pnpm typecheck` fails, show the compiler errors and suggest the correct Effect
idiom or type annotation. Common fixes:

- Missing `R` discharge → add `Effect.provide(SomeLayer)` in the call chain.
- Untyped `throw` → convert to `Data.TaggedError` + `Effect.try`.
- Schema type mismatch → use `Schema.decodeUnknown` and propagate `ParseError`.

### 5. Fix failing tests

If `pnpm test` fails, show the test name and assertion failure. Check whether a
fake (e.g. `FakeTracker`, `FakeAgentRunner`) needs updating, or whether the domain
logic change requires a new test case.

### 6. Confirm ready

Once all gates pass (accounting for the known baseline exceptions above), confirm:

```
✅ typecheck PASS
✅ lint PASS (baseline exceptions only)
✅ test PASS (429/429)
✅ doctor:score PASS (100/100)
Ready to commit.
```

## Commit convention reminder

```
type(scope): imperative title ≤72 chars

Body explaining user impact.

Assisted-by: <model>
```

Types: `feat` · `fix` · `chore` · `docs` · `refactor` · `test`
