# PRODUCT.md — Orchestra Cockpit

## Register

product

## Users & Purpose

Engineering team leads and DevOps engineers who manage fleets of GitHub Copilot coding-agent sessions. They use the cockpit to observe live orchestrator state, diagnose stalled or failed sessions, control dispatch (pause/resume), review token budget consumption, and verify that the daemon is healthy — typically from a desktop browser in a terminal-adjacent workflow.

## Brand Personality

Technical · Precise · Authoritative

The interface speaks the language of its operators: monospace data, semantic status colors, keyboard-first navigation. It earns trust through density and clarity, not decoration.

## Design Language

Warm-neutral, flat, typography-driven — modeled on Cursor's documentation design language. Surfaces are separated by background tone rather than elevation/shadows. Borders are subtle rgba values (warm-tinted). Dark-first with a warm off-white light theme (`#f7f7f4`). One cool accent (blue = running) for focus, links, and active nav.

## Anti-references

- Jira / heavy enterprise dashboards (too busy, too many competing affordances)
- Cool/blue-tinted dark UIs (cold, generic)
- Overly playful DevOps tools (Netlify-style confetti, bright illustrations)
- Bland corporate monitoring (gray on gray, no information hierarchy)
- Heavy shadows / glassmorphism / card-heavy layouts

## Accessibility Posture

Color is never the only signal (chips always carry glyph + label). Meets WCAG 2.1 AA: muted text ≥6:1, faint text ≥5:1, interactive borders ≥3:1. Reduced-motion strips all animation. High-contrast mode reinforces borders and text.

## Tech Stack (Cockpit)

React 19 · Vite · TypeScript · CSS custom properties (tokens) · Inter font (sans) + Geist Mono (code) · No component library — hand-built components following a single design system.
