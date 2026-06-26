import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, XIcon } from "./icons";

/**
 * Transient action toasts — a dep-free, ARIA-live confirmation surface for mutating actions
 * (pause/resume, cancel/retry, save). Auto-dismiss after `TTL_MS`; an operator can also close one
 * early. Tone drives the accent color (success/info/danger) but the icon + text always carry the
 * meaning, so color is never the only signal. Kept in one file: the `useToast` hook owns the queue,
 * `ToastRegion` renders it.
 */

export type ToastTone = "success" | "info" | "danger";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
}

const TTL_MS = 3500;

export interface ToastApi {
  readonly toasts: ReadonlyArray<Toast>;
  readonly notify: (tone: ToastTone, message: string) => void;
  readonly dismiss: (id: number) => void;
}

export const useToast = (): ToastApi => {
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((tone: ToastTone, message: string) => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((ts) => [...ts, { id, tone, message }]);
  }, []);

  return { toasts, notify, dismiss };
};

/**
 * Auto-dismiss EACH toast `TTL_MS` after it first appears — one independent timer per id, so a
 * burst of actions dismisses every toast on its own schedule (not just the latest) and the queue
 * can't grow without bound. Timers for toasts dismissed early are dropped; all are cleared on unmount.
 */
export const useToastAutoDismiss = (
  toasts: ReadonlyArray<Toast>,
  dismiss: (id: number) => void,
) => {
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const live = timers.current;
    // Arm a timer for every toast that doesn't already have one.
    for (const t of toasts) {
      if (!live.has(t.id)) {
        live.set(
          t.id,
          setTimeout(() => dismiss(t.id), TTL_MS),
        );
      }
    }
    // Reap timers for toasts already gone (dismissed early or auto-dismissed) so the map can't leak.
    for (const [id, handle] of live) {
      if (!toasts.some((t) => t.id === id)) {
        clearTimeout(handle);
        live.delete(id);
      }
    }
  }, [toasts, dismiss]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const handle of live.values()) clearTimeout(handle);
      live.clear();
    };
  }, []);
};

export const ToastRegion = ({
  toasts,
  onDismiss,
}: {
  toasts: ReadonlyArray<Toast>;
  onDismiss: (id: number) => void;
}) => (
  <section className="toast-region" aria-label="Notifications" aria-live="polite">
    {toasts.map((t) => (
      <output key={t.id} className={`toast toast--${t.tone}`}>
        <span className="toast__icon" aria-hidden="true">
          {t.tone === "danger" ? <XIcon /> : <CheckIcon />}
        </span>
        <span className="toast__msg">{t.message}</span>
        <button
          type="button"
          className="toast__close"
          aria-label="Dismiss"
          onClick={() => onDismiss(t.id)}
        >
          <XIcon />
        </button>
      </output>
    ))}
  </section>
);
