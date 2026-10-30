import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/**
 * UI primitives.
 *
 * Every control here is a real, focusable element with a visible focus ring and
 * a label association. Nothing renders a disabled-looking stub - if a control is
 * shown, it does something.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  full?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  full = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--${size} ${full ? 'btn--full' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {children != null && <span className="btn__label">{children}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Field wrapper
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  inline?: boolean;
}

export function Field({ label, hint, error, children, inline = false }: FieldProps): JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`field ${inline ? 'field--inline' : ''} ${error ? 'field--error' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="field__control">{children(id, describedBy)}</div>
      {hint && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className = '', ...rest }: TextInputProps): JSX.Element {
  return <input className={`input ${className}`} {...rest} />;
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  className = '',
  ...rest
}: SelectProps<T>): JSX.Element {
  return (
    <select
      className={`select ${className}`}
      value={value}
      onChange={(event) => onValueChange(event.target.value as T)}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Explains why the control is disabled, for screen readers and tooltips. */
  disabledReason?: string;
}

export function Toggle({ checked, onChange, label, hint, disabled, disabledReason }: ToggleProps): JSX.Element {
  const id = useId();
  const hintId = hint || disabledReason ? `${id}-hint` : undefined;
  const shownHint = disabled && disabledReason ? disabledReason : hint;

  return (
    <div className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-describedby={hintId}
        className="toggle__switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        title={disabled ? disabledReason : undefined}
      >
        <span className="toggle__track">
          <span className="toggle__thumb" />
        </span>
        <span className="toggle__label">{label}</span>
      </button>
      {shownHint && (
        <p className="toggle__hint" id={hintId}>
          {shownHint}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  disabled,
}: SliderProps): JSX.Element {
  const id = useId();
  return (
    <div className="slider">
      <div className="slider__head">
        <label className="slider__label" htmlFor={id}>
          {label}
        </label>
        <output className="slider__value" htmlFor={id}>
          {format ? format(value) : value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>): JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`segmented__option ${value === option.value ? 'is-active' : ''}`}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: (() => void) | null;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function Modal({ open, title, description, onClose, children, footer, size = 'md' }: ModalProps): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  // Focus trap + Escape, so the dialog is keyboard-complete.
  useEffect(() => {
    if (!open) return undefined;

    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const initial = node?.querySelector<HTMLElement>('[data-autofocus]');
    if (initial) initial.focus();
    else node?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && onClose) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !node) return;

      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        ref={panel}
        tabIndex={-1}
      >
        <header className="modal__head">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          {onClose && (
            <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog">
              ×
            </button>
          )}
        </header>
        {description && (
          <p className="modal__desc" id={descId}>
            {description}
          </p>
        )}
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger';
}): JSX.Element {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Panel({
  title,
  children,
  actions,
  className = '',
  collapsible = false,
  defaultOpen = true,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel__head">
          {collapsible ? (
            <button
              type="button"
              className="panel__toggle"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen((v) => !v)}
            >
              <span className={`panel__chevron ${open ? 'is-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              <h3 className="panel__title">{title}</h3>
            </button>
          ) : (
            <h3 className="panel__title">{title}</h3>
          )}
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      {(!collapsible || open) && (
        <div className="panel__body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

export function EmptyState({ icon, title, message, action }: { icon?: string; title: string; message: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      {icon && (
        <div className="empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="empty__title">{title}</p>
      <p className="empty__message">{message}</p>
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__ring" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Copy-to-clipboard button that reports success inline. */
export function CopyButton({ value, label = 'Copy', size = 'sm' }: { value: string; label?: string; size?: 'sm' | 'md' }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Clipboard access can be denied; fall back to a selection prompt.
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2200);
  }, [value]);

  return (
    <Button size={size} variant="subtle" onClick={() => void copy()}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'normal';
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<((req: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback(
    (req: Omit<ConfirmRequest, 'resolve'>) =>
      new Promise<boolean>((resolve) => {
        setRequest({ ...req, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      request?.resolve(ok);
      setRequest(null);
    },
    [request],
  );

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        open={request !== null}
        title={request?.title ?? ''}
        onClose={() => settle(false)}
        size="sm"
        footer={
          <>
            <Button onClick={() => settle(false)}>{request?.cancelLabel ?? 'Cancel'}</Button>
            <Button
              variant={request?.tone === 'danger' ? 'danger' : 'primary'}
              onClick={() => settle(true)}
              data-autofocus
            >
              {request?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <p>{request?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (req: { title: string; message: string; confirmLabel?: string; cancelLabel?: string; tone?: 'danger' | 'normal' }) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
