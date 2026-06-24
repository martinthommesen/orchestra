// THROWAWAY spike (#29): proves React 19 + Ink 7 compile, test, build, and run
// under this repo's strict ESM/Effect toolchain before the real dashboard (#30–#33)
// is written. Replaced in #32.
import { pathToFileURL } from "node:url";
import { render, Text } from "ink";

export function Dashboard() {
  return <Text>orchestra dashboard</Text>;
}

// Render only when executed as the built entry (node dist/cli/dashboard.js), never
// when imported by a test. With `noUncheckedIndexedAccess`, argv[1] is possibly
// undefined, so guard it before comparing the resolved file URL.
const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMain) {
  const instance = render(<Dashboard />);
  // Spike smoke-run: paint one frame, then unmount so a TTY-less run exits cleanly
  // instead of hanging the event loop.
  setTimeout(() => instance.unmount(), 100);
  void instance.waitUntilExit();
}
