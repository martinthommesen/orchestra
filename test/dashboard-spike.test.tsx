import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Dashboard } from "../src/cli/dashboard";

describe("dashboard spike (#29)", () => {
  it("renders the placeholder frame via ink-testing-library", () => {
    const { lastFrame } = render(<Dashboard />);
    expect(lastFrame()).toContain("orchestra dashboard");
  });
});
