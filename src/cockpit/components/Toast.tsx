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

const TTL_MS: Record<ToastTone, number> = {
  success: 3500,
  info: 3500,
  danger: 8000,
};

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
 * One toast row. It owns its own auto-dismiss timer: armed `TTL_MS` after it mounts and cleared on
 * unmount (whether it expired or the operator closed it early). Because each row is keyed by id and
 * mounts independently, a burst of actions dismisses every toast on its own schedule — and there is
 * no shared timer map to leak.
 */
const ToastItem = ({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) => {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TTL_MS[toast.tone]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);
  return (
    <output className={`toast toast--${toast.tone}`}>
      <span className="toast__icon" aria-hidden="true">
        {toast.tone === "danger" ? <XIcon /> : <CheckIcon />}
      </span>
      <span className="toast__msg">{toast.message}</span>
      <button
        type="button"
        className="toast__close"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <XIcon />
      </button>
    </output>
  );
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
      <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
    ))}
  </section>
);
