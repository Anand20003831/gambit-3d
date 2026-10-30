import { useStore } from '../net/store.js';

/** Transient notifications. Announced politely so they do not interrupt play. */
export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.level}`}>
          <span className="toast__text">{toast.text}</span>
          <button
            type="button"
            className="toast__close"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
