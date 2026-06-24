import { defineConfig } from "tsup";

// Build the CLI/daemon to dist/. Source uses extensionless ESM imports; esbuild
// (via tsup) resolves and bundles them, so we avoid hand-written .js extensions.
export default defineConfig({
  entry: ["src/cli/main.ts", "src/cli/dashboard.tsx"],
  outDir: "dist/cli",
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  // Keep node_modules external; this is a daemon, not a redistributed bundle.
  skipNodeModulesBundle: true,
});
