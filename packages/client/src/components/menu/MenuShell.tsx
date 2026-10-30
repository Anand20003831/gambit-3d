import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MENU_THEME } from './MenuBackdropLayer.js';

/**
 * The frame every menu screen sits in.
 *
 * One header, one way back. Before this each screen was its own scrolling
 * page of cards, which is why the menus read as a settings form rather than
 * as a game.
 *
 * The scene behind is not rendered here - it belongs to the whole session and
 * lives above the router, so navigating between menus does not restart it.
 */

export interface MenuShellProps {
  /** Shown large on the main menu, small in the header elsewhere. */
  title: string;
  /** A line under the title. */
  subtitle?: string;
  /** Where the back control goes. Omitted on the main menu. */
  back?: { to: string; label: string };
  /** Rendered to the right of the header. */
  actions?: ReactNode;
  /** Widens the panel for screens that need it, like the lobby. */
  wide?: boolean;
  /** The main menu gets the full title lockup and no panel chrome. */
  hero?: boolean;
  children: ReactNode;
}


export function MenuShell({
  title,
  subtitle,
  back,
  actions,
  wide = false,
  hero = false,
  children,
}: MenuShellProps): JSX.Element {
  return (
    <div className={`menu ${hero ? 'menu--hero' : ''}`} data-map={MENU_THEME}>
      <div className="menu__scrim" aria-hidden="true" />

      <div className="menu__content">
        <header className="menu__header">
          {back ? (
            <Link className="menu__back" to={back.to}>
              <span aria-hidden="true">←</span> {back.label}
            </Link>
          ) : (
            <span className="menu__wordmark">Gambit3D</span>
          )}
          {actions && <div className="menu__headerActions">{actions}</div>}
        </header>

        <div className={`menu__body ${wide ? 'menu__body--wide' : ''}`}>
          {hero ? (
            <div className="menu__lockup">
              <h1 className="menu__title">{title}</h1>
              {subtitle && <p className="menu__subtitle">{subtitle}</p>}
            </div>
          ) : (
            <div className="menu__heading">
              <h1 className="menu__screenTitle">{title}</h1>
              {subtitle && <p className="menu__subtitle">{subtitle}</p>}
            </div>
          )}

          <div className="menu__panel">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * One line in a menu list.
 *
 * Large hit area, a label and a supporting line, and a chevron that moves on
 * hover - the shape every game main menu has settled on, because it reads at a
 * glance and works with a keyboard.
 */
export function MenuItem({
  to,
  onClick,
  label,
  hint,
  badge,
  primary = false,
}: {
  to?: string;
  onClick?: () => void;
  label: string;
  hint?: string;
  badge?: string;
  primary?: boolean;
}): JSX.Element {
  const inner = (
    <>
      <span className="menuitem__text">
        <span className="menuitem__label">
          {label}
          {badge && <span className="menuitem__badge">{badge}</span>}
        </span>
        {hint && <span className="menuitem__hint">{hint}</span>}
      </span>
      <span className="menuitem__chevron" aria-hidden="true">
        →
      </span>
    </>
  );

  const className = `menuitem ${primary ? 'menuitem--primary' : ''}`;

  if (to) {
    return (
      <Link className={className} to={to}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {inner}
    </button>
  );
}

/** A group of menu items under a small heading. */
export function MenuGroup({ label, children }: { label?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="menugroup">
      {label && <h2 className="menugroup__label">{label}</h2>}
      <div className="menugroup__items">{children}</div>
    </section>
  );
}
