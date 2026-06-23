# Brainstorm — Phase 4: Team Vote

> Each agent votes for a primary concept (A "Faithful Loop", B "SDK-Native Studio",
> or C "Ports-First Platform") with a brief justification. A blended winner emerges.

| Agent | Vote | Justification |
|-------|------|---------------|
| **Remy** (Producer) | **A** | v1 is the loop. A ships the spec fastest with the least risk. We can grow into C. |
| **Sage** (Backend) | **A + C ports** | The loop must land first (A), but the seams must be ports from day one (C's discipline) — without C's full monorepo ceremony yet. |
| **Ivy** (QA) | **A** | A's small surface is the only one I can property-test thoroughly in v1. B's TUI and in-process SDK are the hardest things to make deterministic. |
| **Dash** (DevOps) | **A** | Subprocess isolation + CI from commit #1. B's in-process SDK weakens the safety model I have to operate. |
| **Nova** (Runtime) | **A** | Prove the Effect core loop before adding surfaces. Start ugly, ship the daemon. |
| **Kira** (Product) | **B**, conceding to **A** | I want the SDK + delight of B, but Remy's right that an unproven SDK can't gate v1. I'll trade it for the spike + a fast follow. |
| **Milo** (Art) | **B**, conceding to **A** | The TUI is the joy. I accept post-v1 **if** I get to build the status-glyph/color design system now so logs already look intentional. |

## Tally

- **Concept A:** 5 primary votes (Remy, Ivy, Dash, Nova, + Sage's base).
- **Concept B:** 2 (Kira, Milo) — both conceded to A for v1 with conditions.
- **Concept C:** 0 primary, but **strong cross-support for its ports discipline**
  (Sage explicit; Dash, Ivy implicitly via testability/isolation).

## Decision

**Winner: Concept A — "The Faithful Loop", hardened with Concept C's ports
discipline (minus the full monorepo ceremony in v1).**

Adopted conditions from the dissenters:
1. **Sprint 0 spike** pins the real Copilot integration surface (SDK vs headless
   CLI) behind the `AgentRunner` port — honors Kira's SDK interest reversibly.
2. **Milo builds the status glyph + color design system now**, used in logs in v1
   and reused by the post-v1 Ink TUI.
3. **Every spec seam is a port/`Layer`** (tracker, agent, workspace, clock, state)
   so Concept B's SDK and the post-v1 TUI/Linear adapter are additive swaps.
4. Monorepo is a **pnpm workspace**, but v1 keeps a lean package set; we don't split
   into six packages until there's a second adapter to justify it.
