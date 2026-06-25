import { spawnSync } from "node:child_process";

const run = spawnSync("react-doctor", ["--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

if (run.error) {
  console.error(`React Doctor failed to start: ${run.error.message}`);
  process.exit(1);
}

if (run.status !== 0) {
  console.error(`React Doctor exited with status ${run.status ?? "unknown"}.`);
  process.exit(run.status ?? 1);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch (error) {
  console.error("React Doctor did not emit valid JSON.");
  if (run.stdout.trim().length > 0) {
    console.error(run.stdout);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const score = report?.summary?.score;
const diagnostics = report?.summary?.totalDiagnosticCount;

if (score !== 100 || diagnostics !== 0) {
  console.error(
    `React Doctor must be 100/100 with zero diagnostics; got score=${String(
      score,
    )}, diagnostics=${String(diagnostics)}.`,
  );
  process.exit(1);
}

console.log("React Doctor score: 100/100");
