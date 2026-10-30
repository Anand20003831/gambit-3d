import { MenuGroup, MenuItem, MenuShell } from '../components/menu/MenuShell.js';
import { PlayerChip } from '../components/menu/PlayerChip.js';

/**
 * Choosing how to play.
 *
 * Its own screen rather than four cards on the main menu: these are genuinely
 * different games - one needs the internet, one needs a second device in the
 * house, one needs nothing at all - and the differences matter more than
 * fitting them into a grid.
 */
export function PlayPage(): JSX.Element {
  return (
    <MenuShell
      title="Play"
      subtitle="Four ways to start a game. Nothing here needs an account."
      back={{ to: '/', label: 'Main menu' }}
      actions={<PlayerChip />}
    >
      <MenuGroup label="With other people">
        <MenuItem
          primary
          to="/lobby"
          label="Play online"
          hint="Browse games anyone has opened, or host your own"
        />
        <MenuItem
          to="/create?mode=private"
          label="Private game"
          hint="A room only the people you send the code to can find"
        />
        <MenuItem
          to="/lan"
          label="Local Wi-Fi"
          hint="Two devices in the same house, with no internet at all"
          badge="offline"
        />
      </MenuGroup>

      <MenuGroup label="On this device">
        <MenuItem
          to="/create?mode=local"
          label="Pass and play"
          hint="Two players, one screen. The board turns round between moves."
        />
      </MenuGroup>
    </MenuShell>
  );
}
