import { Link } from 'react-router-dom';
import { THEME_META } from '@gambit3d/shared';
import { MenuGroup, MenuItem, MenuShell } from '../components/menu/MenuShell.js';
import { PlayerChip } from '../components/menu/PlayerChip.js';

/**
 * The main menu.
 *
 * One column of choices over a live shot of the board, in the order they are
 * actually wanted: start a game, join one, then everything else. The four ways
 * to play used to sit here as a grid of cards, which made choosing a game mode
 * look like the same weight of decision as opening the credits; they have a
 * screen of their own now.
 */
export function HomePage(): JSX.Element {
  return (
    <MenuShell
      hero
      title="Gambit3D"
      subtitle="Three-dimensional chess, across the room or across the world."
      actions={<PlayerChip />}
    >
      <MenuGroup>
        <MenuItem primary to="/play" label="Play" hint="Online, over Wi-Fi, or two players on this screen" />
        <MenuItem to="/join" label="Join with a code" hint="Someone has sent you a room code or a link" />
      </MenuGroup>

      <MenuGroup label="More">
        <MenuItem to="/editor" label="Level editor" hint="Rearrange the scenery in either map" />
        <MenuItem to="/settings" label="Settings" hint="Graphics, sound, board and accessibility" />
      </MenuGroup>

      <section className="menumaps" aria-label="Maps">
        {THEME_META.map((meta) => (
          <article className="menumap" key={meta.id} style={{ '--card-accent': meta.accent } as React.CSSProperties}>
            <h2 className="menumap__name">{meta.name}</h2>
            <p className="menumap__tagline">{meta.tagline}</p>
          </article>
        ))}
      </section>

      <p className="menu__meta">
        <Link to="/credits">Credits &amp; licences</Link>
        <span>Server-authoritative · no account needed</span>
      </p>
    </MenuShell>
  );
}
