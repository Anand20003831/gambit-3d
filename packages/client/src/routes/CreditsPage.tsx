
import { MenuShell } from '../components/menu/MenuShell.js';
import { Panel } from '../components/ui/index.js';
import { THEME_LIST } from '../three/themes/index.js';

/**
 * Credits.
 *
 * This page is not decorative: the Milky Way plate is CC BY 4.0, and its licence
 * requires the credit to be clear and visible to users. Removing this page means
 * removing that image too.
 */
export function CreditsPage(): JSX.Element {
  return (
    <MenuShell
      wide
      title="Credits &amp; licences"
      back={{ to: '/', label: 'Main menu' }}
    >
      <div className="page page--narrow credits">

        <p className="muted">
          Everything listed here was checked against its source licence before use. The full record,
          including source URLs and what was modified, is in <code>ASSET_CREDITS.md</code>.
        </p>

        <Panel title="Attribution required">
          <ul className="credits__list">
            <li>
              <strong>The Milky Way panorama</strong> — <em>ESO/S. Brunier</em>
              <span className="credits__lic">CC BY 4.0</span>
              <p className="credits__use">The sky beyond the viewport in Orbital Station.</p>
            </li>
          </ul>
        </Panel>

        <Panel title="Public domain (CC0)">
          <ul className="credits__list">
            <li>
              <strong>Quaternius</strong>
              <span className="credits__lic">CC0</span>
              <p className="credits__use">
                Downtown City MegaKit (the city buildings), Cyberpunk Game Kit (neon signs, screens,
                aerials and rooftop clutter — including their lettering, which is Quaternius&rsquo; own
                artwork), Ultimate Furniture Pack (the apartment furniture), Ultimate Modular Sci-Fi
                Pack (station consoles, crates and pods), and Ultimate Space Kit (planets and station
                hardware).
              </p>
            </li>
            <li>
              <strong>Chess Set</strong> — Riley Queen, via Poly Haven
              <span className="credits__lic">CC0</span>
              <p className="credits__use">The playable piece geometry.</p>
            </li>
            <li>
              <strong>Rooftop Night</strong> — Greg Zaal, via Poly Haven
              <span className="credits__lic">CC0</span>
              <p className="credits__use">Environment lighting for the apartment.</p>
            </li>
            <li>
              <strong>Marble 012, Metal Plates 006, Asphalt 033</strong> — ambientCG
              <span className="credits__lic">CC0</span>
              <p className="credits__use">Floor, wall and board surfaces.</p>
            </li>
            <li>
              <strong>Interface, Digital and Sci-fi sound packs</strong> — Kenney
              <span className="credits__lic">CC0</span>
              <p className="credits__use">Every move, capture, check and interface sound.</p>
            </li>
            <li>
              <strong>Robotic City V2</strong> — section31, via OpenGameArt
              <span className="credits__lic">CC0</span>
              <p className="credits__use">Ambient music for Neon City Apartment.</p>
            </li>
            <li>
              <strong>Deep Space Array</strong> — Tozan, via OpenGameArt
              <span className="credits__lic">CC0</span>
              <p className="credits__use">Ambient music for Orbital Station.</p>
            </li>
          </ul>
        </Panel>

        <Panel title="Original to this project">
          <p>
            Both room interiors, the board, the stylised piece silhouettes, every shader, the rain and
            low-gravity particle systems, and all synthesised sound were created for this game. No
            real brand, logo, or copyrighted character appears anywhere.
          </p>
        </Panel>

        <Panel title="Per-map attribution">
          <ul className="credits__maps">
            {THEME_LIST.map((theme) => (
              <li key={theme.id}>
                <h3>{theme.name}</h3>
                {theme.attribution && theme.attribution.length > 0 ? (
                  <ul>
                    {theme.attribution.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Entirely original.</p>
                )}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Software">
          <p className="muted">
            Built with React, Three.js and React Three Fiber, Socket.IO, chess.js and Vite — each under
            its own open-source licence.
          </p>
        </Panel>
      </div>
    </MenuShell>
  );
}
