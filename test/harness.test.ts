import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { CliUsageError, parseArgs } from "../src/cli/args";

/**
 * Sprint 0, Task 10 (harness proof). These tests exist to prove the test harness
 * itself is wired correctly: `@effect/vitest` runs Effects, `fast-check` runs
 * property tests, and the CLI arg parser is exercised end-to-end. Real domain
 * coverage lands alongside each module.
 */

describe("test harness", () => {
  it.effect("runs Effects via @effect/vitest", () =>
    Effect.gen(function* () {
      const result = yield* Effect.succeed(2 + 2);
      expect(result).toBe(4);
    }),
  );

  it("runs property tests via fast-check", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        // String concatenation length is the sum of the parts — a trivial
        // invariant whose only job is to prove fast-check executes.
        expect((a + b).length).toBe(a.length + b.length);
      }),
    );
  });
});

describe("parseArgs", () => {
  it.effect("returns the workflow path when provided", () =>
    Effect.gen(function* () {
      const args = yield* parseArgs(["./WORKFLOW.example.md"]);
      expect(args.workflowPath).toBe("./WORKFLOW.example.md");
    }),
  );

  it.effect("fails with CliUsageError when the path is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseArgs([]));
      expect(Exit.isFailure(exit)).toBe(true);
      const error = yield* Effect.flip(parseArgs([]));
      expect(error).toBeInstanceOf(CliUsageError);
      expect(error._tag).toBe("CliUsageError");
    }),
  );

  it.effect("fails with CliUsageError when the path is empty", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseArgs([""]));
      expect(error._tag).toBe("CliUsageError");
    }),
  );
});
