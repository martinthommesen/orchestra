import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Check,
  ChevronsUpDown,
  Columns3,
  Command,
  CornerDownLeft,
  Gauge,
  type LucideProps,
  Moon,
  Pause,
  Play,
  ScrollText,
  Search,
  Settings2,
  Sun,
  X,
} from "lucide-react";

/**
 * The cockpit icon set — thin wrappers over Lucide so the whole app shares one polished, consistent
 * line-icon family (1em-sized, so each icon inherits the font-size of its host; finer 1.75 stroke for
 * a refined feel). Re-exported under cockpit-semantic names so call sites read intent
 * (`FleetIcon`, not `Gauge`) and the underlying glyph can change in one place. Every icon is
 * decorative — a visible label always travels with the interactive element that hosts it.
 */

const icon = (Glyph: React.ComponentType<LucideProps>) => (props: LucideProps) => (
  <Glyph size="1em" strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" {...props} />
);

/** Brand: sound-wave bars — a conductor's downbeat / a fleet running in parallel. */
export const OrchestraMark = icon(AudioLines);

export const FleetIcon = icon(Gauge);
export const ColumnsIcon = icon(Columns3);
export const ListIcon = icon(ScrollText);
export const GearIcon = icon(Settings2);

export const SortAscIcon = icon(ArrowUp);
export const SortDescIcon = icon(ArrowDown);
export const SortIcon = icon(ChevronsUpDown);

export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);
export const CheckIcon = icon(Check);
export const XIcon = icon(X);
export const SearchIcon = icon(Search);
export const CommandIcon = icon(Command);
export const PauseIcon = icon(Pause);
export const PlayIcon = icon(Play);
export const ArrowTurnIcon = icon(CornerDownLeft);
