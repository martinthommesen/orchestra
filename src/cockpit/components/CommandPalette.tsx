import { Fragment, type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react";
import { describeError } from "../api/errors";
import { client } from "../api/instance";
import { derivePauseControl } from "../model/pause-control";
import { ROUTE_KEY, ROUTE_LABELS, ROUTES, type Route } from "../router";
import { useSnapshot } from "../snapshot";
import type { Theme } from "../useTheme";
import {
  ArrowTurnIcon,
  ColumnsIcon,
  FleetIcon,
  GearIcon,
  ListIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  SunIcon,
} from "./icons";

/**
 * The ⌘K command palette — the cockpit's keyboard front door. Jump to any view, toggle the theme, or
 * pause/resume dispatch without leaving the keyboard. Mounted at `App` (so it composes route + theme
 * + the dispatch client) and rendered only while open, so each open starts fresh.
 *
 * Built on the native `<dialog>` element (opened with `showModal`), so focus-trapping, the Escape
 * key, initial focus, and the dimmed `::backdrop` are the browser's job, not ours. The input is a
 * `combobox` driving a `listbox` via `aria-activedescendant`; Up/Down move, Enter runs. The dispatch
 * command mirrors `derivePauseControl` exactly — it is hidden while dispatch is held by the budget
 * gate, so the palette never offers a no-op resume.
 */

interface Command {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: ReactNode;
  readonly run: () => unknown;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export const PALETTE_HINT = IS_MAC ? "⌘K" : "Ctrl K";

const ROUTE_ICON: Record<Route, ReactNode> = {
  fleet: <FleetIcon />,
  kanban: <ColumnsIcon />,
  events: <ListIcon />,
  settings: <GearIcon />,
};

export const CommandPalette = ({
  open,
  onClose,
  navigate,
  theme,
  onToggleTheme,
}: {
  open: boolean;
  onClose: () => void;
  navigate: (route: Route) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) => {
  const poll = useSnapshot();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Guards against double-firing an in-flight async command; never rendered, so a ref (not state).
  const busy = useRef(false);
  const listId = useId();

  // Open as a real modal on mount (the component only renders while `open`), so the browser handles
  // focus-trapping, Escape, initial focus and the backdrop.
  const dialogRef = useCallback((node: HTMLDialogElement | null) => {
    if (node && !node.open) node.showModal();
  }, []);

  const pause = derivePauseControl(poll.data?.control ?? null);

  const commands = useMemo<ReadonlyArray<Command>>(() => {
    const items: Command[] = ROUTES.map((r) => ({
      id: `go-${r}`,
      group: "Go to",
      label: ROUTE_LABELS[r],
      hint: `g ${ROUTE_KEY[r]}`,
      icon: ROUTE_ICON[r],
      run: () => navigate(r),
    }));
    if (pause.showToggle) {
      items.push({
        id: "dispatch-toggle",
        group: "Dispatch",
        label: pause.buttonLabel,
        icon: pause.action === "resume" ? <PlayIcon /> : <PauseIcon />,
        run: () => (pause.action === "resume" ? client.resume() : client.pause()),
      });
    }
    items.push({
      id: "toggle-theme",
      group: "Appearance",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? <SunIcon /> : <MoonIcon />,
      run: onToggleTheme,
    });
    return items;
  }, [navigate, onToggleTheme, theme, pause.showToggle, pause.action, pause.buttonLabel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return commands;
    return commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(q));
  }, [commands, query]);

  // Keep the selection in range as the filtered list shrinks/grows.
  const selClamped = filtered.length === 0 ? 0 : Math.min(sel, filtered.length - 1);

  if (!open) return null;

  const exec = async (cmd: Command) => {
    if (busy.current) return;
    setError(null);
    busy.current = true;
    try {
      await cmd.run();
      onClose();
    } catch (err) {
      setError(describeError(err));
      busy.current = false;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (filtered.length === 0 ? 0 : (s + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (filtered.length === 0 ? 0 : (s - 1 + filtered.length) % filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[selClamped];
      if (cmd) void exec(cmd);
    }
  };

  let lastGroup = "";

  return (
    <dialog ref={dialogRef} className="cmdk" aria-label="Command palette" onClose={onClose}>
      <div className="cmdk__input-wrap">
        <span className="cmdk__prompt" aria-hidden="true">
          ›
        </span>
        <input
          type="text"
          className="cmdk__input"
          placeholder="Type a command or search…"
          value={query}
          aria-controls={listId}
          aria-activedescendant={filtered[selClamped]?.id}
          aria-label="Command palette search"
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- W3C APG combobox/listbox command-palette pattern; <datalist> cannot hold actionable, icon-bearing command buttons. */}
      <div className="cmdk__list" id={listId} role="listbox" aria-label="Commands">
        {filtered.length === 0 ? (
          <div className="cmdk__empty">No matching commands</div>
        ) : (
          filtered.map((cmd, i) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            return (
              <Fragment key={cmd.id}>
                {header ? (
                  <div className="cmdk__group" aria-hidden="true">
                    {header}
                  </div>
                ) : null}
                <button
                  type="button"
                  id={cmd.id}
                  role="option"
                  aria-selected={i === selClamped}
                  tabIndex={-1}
                  className={`cmdk__item${i === selClamped ? " cmdk__item--active" : ""}`}
                  onMouseMove={() => setSel(i)}
                  onClick={() => void exec(cmd)}
                >
                  <span className="cmdk__item-icon" aria-hidden="true">
                    {cmd.icon}
                  </span>
                  <span className="cmdk__item-label">{cmd.label}</span>
                  {cmd.hint ? <kbd className="cmdk__item-kbd">{cmd.hint}</kbd> : null}
                </button>
              </Fragment>
            );
          })
        )}
      </div>

      <div className="cmdk__footer">
        {error ? (
          <span className="cmdk__error" role="alert">
            {error}
          </span>
        ) : (
          <span className="cmdk__legend">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <span>navigate</span>
            <kbd className="cmdk__legend-enter">
              <ArrowTurnIcon />
            </kbd>
            <span>run</span>
            <kbd>esc</kbd>
            <span>close</span>
          </span>
        )}
      </div>
    </dialog>
  );
};
