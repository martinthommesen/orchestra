# Effect Onboarding Guide (Orchestra)

> Sprint 0, Task 9. The six [Effect](https://effect.website) concepts you need to be
> productive in this codebase, each with a **real Orchestra example**. This is a
> "just enough to contribute" guide, not a replacement for the official docs — when in
> doubt, read [effect.website/docs](https://effect.website/docs).

Orchestra is **Effect all the way through the core and CLI** — there is no `async`/
`Promise` escape hatch in the core. Everything that can fail, block, or touch the
outside world is an `Effect`. If you internalize the six ideas below, the rest of the
codebase reads naturally.

---

## 1. `Effect<A, E, R>` — a description of a computation

An `Effect<A, E, R>` is a **lazy, immutable description** of work that, when run,
either succeeds with an `A`, fails with a typed error `E`, or needs services `R`.
Nothing happens until it's run (by `NodeRuntime.runMain` at the CLI entry). You build
big effects out of small ones with `Effect.gen` (generator syntax — `yield*` is "await
but typed errors").

The success **and** failure channels are both in the type, so the compiler tracks every
way a function can fail.

```ts
// src/core/workflow/render.ts — note the error type is explicit, not `throw`.
export const renderPrompt = (
  template: string,
  scope: PromptScope,
): Effect.Effect<string, TemplateParseError | TemplateRenderError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => engine.parse(template),
      catch: (e) => new TemplateParseError({ message: errorMessage(e), cause: e }),
    });
    // ...renderSync, also wrapped in Effect.try...
    return rendered;
  });
```

**Why it matters here:** `renderPrompt`'s signature tells you it can fail two specific
ways and needs no services (`R = never`). You can't forget to handle those errors — the
types won't let you.

**Gotchas:** wrap any throwing/synchronous-impure call in `Effect.try` (or
`Effect.sync` when it can't throw). Use `Effect.tryPromise` only at the very edges —
**never in the core.**

---

## 2. `Layer` + `Context.Tag` — dependency injection

A **`Context.Tag`** is a typed key for a service (an interface). A **`Layer`** is a
recipe that builds that service (and may need other services/resources to do so). The
program declares *what* it needs via tags; `main.ts` provides the *how* via layers. Swap
a real layer for a fake in tests — same program, different wiring.

Orchestra's seams are the four ports, defined as tags with **signatures only** (impls
land in Sprint 1):

```ts
// src/core/ports/agent-runner.ts
export class AgentRunner extends Context.Tag("orchestra/AgentRunner")<
  AgentRunner,
  { readonly run: (params: AgentRunParams) => Stream.Stream<AgentEvent, AgentError> }
>() {}

// consume it anywhere by yielding the tag:
const program = Effect.gen(function* () {
  const runner = yield* AgentRunner;            // R now includes AgentRunner
  // ...use runner.run(...)
});

// provide it at the edge (main.ts):
program.pipe(Effect.provide(AgentRunnerLive));   // R discharged
```

**Why it matters here:** the orchestrator depends on `IssueTracker` / `AgentRunner` /
`WorkspaceManager` / `Clock` tags, never on Octokit or the `copilot` subprocess. Tests
provide `FakeTracker`/`FakeAgentRunner` layers; production provides the real adapters.
The whole architecture hinges on this.

**Gotchas:** `AppLive` in `main.ts` is `Layer.empty` today — it's the seam Sprint 1
grows. A leftover service in `R` that you forgot to provide is a *type error* at
`runMain`, which is exactly what you want.

---

## 3. `Schema` — parse, don't validate

`Schema` is a two-way codec: `Encoded` (wire form) ↔ `Type` (domain form), with
`decodeUnknown` turning untrusted input into a typed value *or* a `ParseError`. We use
it at **both ends**: WORKFLOW front matter coming in, and the `AgentEvent` stream coming
off the agent. Defaults, transforms, and normalization live *in the schema*, so any
decoded value is guaranteed normalized.

```ts
// src/core/domain/issue.ts — normalization encoded in the type, not left to callers.
export const NormalizedLabel = Schema.transform(Schema.String, Schema.String, {
  strict: true,
  decode: (raw) => raw.trim().toLowerCase(),   // every decoded label is normalized
  encode: (normalized) => normalized,
});

// src/core/domain/workflow.ts — SPEC defaults baked in; an empty config still decodes.
export const PollingConfig = Schema.Struct({
  interval_ms: Schema.optionalWith(PositiveInt, { default: () => 30_000 }),
});

// src/core/workflow/loader.ts — untrusted YAML → typed config or WorkflowParseError.
const decoded = yield* Schema.decodeUnknown(ServiceConfig)(raw).pipe(
  Effect.mapError((e) => new WorkflowParseError({ message: errorMessage(e), cause: e })),
);
```

**Why it matters here:** "parse, don't validate" — once `decodeUnknown` succeeds you
hold a `ServiceConfig` with every default applied and every label lowercased. No
defensive `?? 30000` scattered around the orchestrator.

**Gotchas:** get the static types with `typeof MySchema.Type` (domain) and
`typeof MySchema.Encoded` (wire). Use `Schema.optionalWith(s, { default: () => x })`
for defaults; nest with `Schema.optionalWith(Section, { default: () => Section.make({}) })`.
Unknown keys are stripped by default (matches the SPEC's "ignore unknown keys").

---

## 4. Tagged errors — typed, discriminable failures

Every failure mode is a `Data.TaggedError` with a unique `_tag`. They flow in the
`E` channel of `Effect`, so the compiler knows exactly which errors a computation can
produce. Handle them precisely with `Effect.catchTag`/`catchTags`, or match on `_tag`.

```ts
// src/core/errors.ts — one class per SPEC error category.
export class TurnTimeout extends Data.TaggedError("TurnTimeout")<{
  readonly timeout_ms: number;
}> {}

// You can fail directly by yielding an instance (TaggedError is yieldable):
if (elapsed > limit) {
  return yield* new TurnTimeout({ timeout_ms: limit });
}

// Handle just the cases you care about; the rest stay in the type:
effect.pipe(
  Effect.catchTag("TurnTimeout", (e) => retryWithBackoff(e.timeout_ms)),
);
```

**Why it matters here:** every SPEC error class (§5.5, §10.6, §11.4) is one of these,
unioned into `WorkflowError` / `AgentError` / `TrackerError` / `WorkspaceError`. Sprint 1's
retry logic will `catchTag` on the specific ones (e.g. retry `TurnTimeout`/`Stalled`,
hard-fail `TurnInputRequired`). The discriminated union makes that exhaustive.

**Gotchas:** never put secrets in an error payload (tokens, resolved `$VAR`s) — the brief
forbids it. Construct with the field object: `new TurnTimeout({ timeout_ms: 5000 })`.
For structural equality in tests use `Equal.equals(a, b)` from `effect`.

---

## 5. `Schedule` — composable retry/repeat policies

A `Schedule<Out, In>` is a reusable, **composable** description of *when* to repeat or
retry — fixed delay, exponential backoff, capped, jittered, bounded by count. You attach
it with `Effect.retry` / `Effect.repeat` instead of hand-writing loops and `setTimeout`.

```ts
// Sprint 1 will retry agent attempts with capped exponential backoff. Sketch:
import { Schedule, Effect, Duration } from "effect";

const backoff = Schedule.exponential(Duration.seconds(1), 2.0).pipe(
  Schedule.either(Schedule.spaced(Duration.millis(config.agent.max_retry_backoff_ms))), // cap
  Schedule.jittered,                                                                     // de-sync
);

const runWithRetry = runOneAttempt.pipe(
  Effect.retry({ schedule: backoff, while: (e) => isRetryable(e) }),  // only retryable tags
);

// The poll loop is just a repeat on a fixed interval:
const pollLoop = pollOnce.pipe(Effect.repeat(Schedule.spaced(Duration.millis(poll_interval_ms))));
```

**Why it matters here:** the orchestrator's exponential-backoff retries (`RetryEntry`,
`max_retry_backoff_ms`) and the fixed-cadence poll loop (`polling.interval_ms`) are both
`Schedule`s — no bespoke timer bookkeeping, and they're testable (see §6).

**Gotchas:** combine schedules with `Schedule.either` (cap), `Schedule.jittered`
(de-synchronize), and gate retries with `while`/`until` so you only retry the error tags
that are actually retryable.

---

## 6. `TestClock` — deterministic time-travel tests

Real time makes retry/poll/timeout tests slow and flaky. `TestClock` lets a test
**advance virtual time** instantly: schedule something an hour out, call
`TestClock.adjust("1 hour")`, and it fires immediately — no real waiting. This is why the
core takes a `Clock` port and uses `Schedule`/Effect time primitives rather than
`Date.now()`/`setTimeout`.

```ts
import { it } from "@effect/vitest";
import { Effect, TestClock, Fiber, Duration } from "effect";

it.effect("poll loop ticks once per interval", () =>
  Effect.gen(function* () {
    const fiber = yield* pollLoop.pipe(Effect.fork);   // run in the background
    yield* TestClock.adjust(Duration.millis(30_000));  // jump one interval — instantly
    // assert exactly one poll happened...
    yield* Fiber.interrupt(fiber);
  }),
);
```

**Why it matters here:** Sprint 1's backoff and reconciliation logic will be tested in
*virtual* time — a 5-minute backoff verifies in microseconds, deterministically. Keep the
core time-abstract (the `Clock` port + Effect's clock) so these tests stay possible.

**Gotchas:** `@effect/vitest` provides `it.effect` which supplies the `TestContext`
(including `TestClock`) automatically. Anything reading wall-clock time directly (e.g. a
raw `Date.now()`) bypasses `TestClock` and reintroduces flakiness — go through the `Clock`
port instead.

---

## Putting it together

A single agent attempt in Sprint 1 will read roughly like this — every concept above in
one flow:

```ts
const runAttempt = (issue: Issue) =>
  Effect.gen(function* () {
    const tracker = yield* IssueTracker;                 // §2 Layer/Context
    const runner = yield* AgentRunner;                   //     (ports as tags)
    const ws = yield* prepareWorkspace(issue);           // §4 may fail WorkspaceError
    const prompt = yield* renderPrompt(template, { issue, attempt: null }); // §1,§3
    yield* runner.run({ issue, workspacePath: ws.path, prompt, attempt: null })
      .pipe(Stream.runForEach(handleEvent));             // §3 AgentEvent stream
  }).pipe(
    Effect.retry({ schedule: backoff, while: isRetryable }),  // §5 Schedule
    Effect.catchTag("TurnInputRequired", giveUp),             // §4 tagged errors
  );
// ...all tested under TestClock (§6), all services provided by Layers (§2) in main.ts.
```

If that snippet makes sense, you're ready to work in the core. Read
`src/core/ports/` (the seams) and `src/core/errors.ts` (the failure surface) next.
