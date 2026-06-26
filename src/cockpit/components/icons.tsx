import type { SVGProps } from "react";

/**
 * Inline SVG icon set — dep-free, `currentColor`-driven, 24×24 viewBox (sized via `font-size`/CSS).
 * Kept minimal: only the glyphs the chrome actually needs. Each is decorative (`aria-hidden`) — a
 * visible label always travels with the interactive element that hosts it, so an icon never carries
 * meaning alone (parity with the cockpit's "color is never the only signal" posture).
 */

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: "1em",
  height: "1em",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const FilterIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" />
  </svg>
);

export const SortAscIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 4v16" />
  </svg>
);

export const SortDescIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M11 5h4M11 9h7M11 13h10M3 7l3 3 3-3M6 4v16" />
  </svg>
);

export const SortIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4" />
  </svg>
);

export const PauseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);

export const PlayIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M7 5v14l11-7L7 5z" />
  </svg>
);

export const RefreshIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
  </svg>
);

export const SunIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const MoonIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

export const XIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 15 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

export const ColumnsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="16" rx="1" />
    <rect x="17" y="4" width="4" height="16" rx="1" />
  </svg>
);

export const ListIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);

export const FleetIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} aria-hidden="true">
    <path d="M3 17l6-4 4 3 8-6v11H3V17z" />
    <circle cx="9" cy="13" r="1.5" />
    <circle cx="13" cy="16" r="1.5" />
  </svg>
);
