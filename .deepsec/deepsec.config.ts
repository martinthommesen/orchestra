import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    {
      id: "orchestra",
      root: "..",
      priorityPaths: [
        "src/core/cockpit/",
        "src/core/workflow/",
        "src/core/workspace/",
        "src/adapters/workspace/",
        "src/adapters/agent-copilot/",
        "src/adapters/tracker-github/",
      ],
      promptAppend:
        "For Orchestra, prioritize loopback cockpit control-plane security, workflow YAML/settings persistence, workspace path confinement, shell hook execution, Copilot subprocess invocation, GitHub token handling, and prompt-injection risks from issue text.",
    },
    // <deepsec:projects-insert-above>
  ],
});
