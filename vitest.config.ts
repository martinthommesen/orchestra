import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // @effect/vitest provides it.effect / it.scoped helpers used across the suite.
    globals: false,
    environment: "node",
  },
});
