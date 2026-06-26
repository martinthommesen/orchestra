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

/** Auto-dismiss the latest toast after `TTL_MS`; cleared on unmount. */
export const useToastAutoDismiss = (
  toasts: ReadonlyArray<Toast>,
  dismiss: (id: number) => void,
) => {
  const latest = toasts.at(-1) ?? null;
  const idRef = useRef<number | null>(null);
  useEffect(() => {
    if (latest === null) return;
    if (idRef.current === latest.id) return;
    idRef.current = latest.id;
    const t = setTimeout(() => dismiss(latest.id), TTL_MS);
    return () => clearTimeout(t);
  }, [latest, dismiss]);
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
