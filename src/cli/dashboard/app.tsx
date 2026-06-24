import { Box, Text, useApp, useInput } from "ink";
import type { DashboardOptions } from "./args";

/**
 * Dashboard root component.
 *
 * NOTE (#30): this is the subcommand wiring milestone — the component is a thin shell
 * that proves `orchestra dashboard` boots an Ink render and exits cleanly on `q` /
 * Ctrl-C. The live fleet view (snapshot polling + view-model + rich rows) lands in #32,
 * which replaces this body while keeping the same exit semantics.
 */

export interface AppProps {
  readonly baseUrl: string;
  readonly options: DashboardOptions;
}

export function App({ baseUrl }: AppProps) {
  const { exit } = useApp();

  // `q` and Ctrl-C unmount Ink; the (future) polling hook's effect cleanup aborts the
  // in-flight fetch and clears the timer, so no handles leak.
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>orchestra dashboard</Text>
      <Text color="gray">polling {baseUrl}/api/v1/state — press q to quit</Text>
    </Box>
  );
}
