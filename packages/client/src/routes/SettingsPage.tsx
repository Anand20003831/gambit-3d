import { Link } from 'react-router-dom';
import { MenuShell } from '../components/menu/MenuShell.js';
import { THEME_META } from '@gambit3d/shared';
import { audio } from '../audio/engine.js';
import {
  DEFAULT_SETTINGS,
  QUALITY_BUDGETS,
  detectDevice,
  resolveQuality,
  useSettings,
} from '../hooks/useSettings.js';
import { Badge, Button, Field, Panel, Segmented, Select, Slider, Toggle } from '../components/ui/index.js';

/** Per-device preferences. Nothing here is sent to the server. */
export function SettingsPage(): JSX.Element {
  const settings = useSettings();
  const profile = detectDevice();
  const resolved = resolveQuality(settings.quality, profile);
  const budget = QUALITY_BUDGETS[resolved];

  return (
    <MenuShell
      wide
      title="Settings"
      back={{ to: '/', label: 'Main menu' }}
    >
      <div className="page settings">
        <header className="page__head">
          <div>

            <p className="muted">These apply to this device only and are saved in your browser.</p>
          </div>
          <Button onClick={() => settings.reset()}>Reset to defaults</Button>
        </header>

        <div className="settings__grid">
          <Panel title="Graphics">
            <Field
              label="Quality"
              hint={
                settings.quality === 'auto'
                  ? `Auto picked ${resolved} for this device (${profile.cores} cores, ${profile.webgl2 ? 'WebGL 2' : 'WebGL 1'}${profile.renderer ? `, ${profile.renderer}` : ''}).`
                  : 'Manual override.'
              }
            >
              {(id, describedBy) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={settings.quality}
                  onValueChange={(v) => settings.set('quality', v)}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                  ]}
                />
              )}
            </Field>

            <dl className="settings__budget">
              <div>
                <dt>Shadows</dt>
                <dd>{budget.shadows ? `${budget.shadowMapSize}px` : 'Off'}</dd>
              </div>
              <div>
                <dt>Particles</dt>
                <dd>{budget.particleScale === 0 ? 'Off' : `${Math.round(budget.particleScale * 100)}%`}</dd>
              </div>
              <div>
                <dt>Reflections</dt>
                <dd>{budget.reflections ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt>Post-processing</dt>
                <dd>{budget.postProcessing ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt>Environment detail</dt>
                <dd>{budget.environmentDetail}</dd>
              </div>
              <div>
                <dt>Antialiasing</dt>
                <dd>{budget.antialias ? 'On' : 'Off'}</dd>
              </div>
            </dl>
            <p className="muted">
              Low never changes the rules or what you can do — only how much the scene draws.
            </p>

            <Segmented
              label="Board rendering"
              value={settings.renderMode}
              onChange={(v) => settings.set('renderMode', v)}
              options={[
                { value: '3d', label: '3D', disabled: !profile.webglAvailable },
                { value: '2d', label: '2D' },
              ]}
            />
            {!profile.webglAvailable && (
              <p className="settings__note">
                <Badge tone="warn">No WebGL</Badge> This device cannot run the 3D board, so the 2D
                board is used everywhere.
              </p>
            )}

            <Segmented
              label="Camera"
              value={settings.cameraMode}
              onChange={(v) => settings.set('cameraMode', v)}
              options={[
                { value: 'orbit', label: 'Free orbit' },
                { value: 'tournament', label: 'Fixed tournament' },
              ]}
            />

            <Field label="Map override" hint="Normally each room chooses its own map. This forces one for you only.">
              {(id, describedBy) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={settings.themeOverride ?? 'room'}
                  onValueChange={(v) => settings.set('themeOverride', v === 'room' ? null : (v as never))}
                  options={[
                    { value: 'room', label: "Follow the room's choice" },
                    ...THEME_META.map((m) => ({ value: m.id, label: m.name })),
                  ]}
                />
              )}
            </Field>
          </Panel>

          <Panel title="Sound">
            <Toggle checked={!settings.muted} onChange={(v) => settings.set('muted', !v)} label="Sound on" />
            <Slider
              label="Overall volume"
              value={Math.round(settings.masterVolume * 100)}
              min={0}
              max={100}
              onChange={(v) => settings.set('masterVolume', v / 100)}
              format={(v) => `${v}%`}
              disabled={settings.muted}
            />
            <Slider
              label="Effects"
              value={Math.round(settings.sfxVolume * 100)}
              min={0}
              max={100}
              onChange={(v) => settings.set('sfxVolume', v / 100)}
              format={(v) => `${v}%`}
              disabled={settings.muted}
            />
            <Slider
              label="Music and ambience"
              value={Math.round(settings.musicVolume * 100)}
              min={0}
              max={100}
              onChange={(v) => settings.set('musicVolume', v / 100)}
              format={(v) => `${v}%`}
              disabled={settings.muted || !settings.ambienceEnabled}
            />
            <Toggle
              checked={settings.ambienceEnabled}
              onChange={(v) => settings.set('ambienceEnabled', v)}
              label="Ambient music"
              hint="Each map has its own track and its own synthesised background layer."
              disabled={settings.muted}
              disabledReason="Turn sound on first."
            />
            <Button
              onClick={() => {
                void audio.unlock().then(() => audio.play('move', { throttleMs: 0 }));
              }}
              disabled={settings.muted}
            >
              Test sound
            </Button>
          </Panel>

          <Panel title="Accessibility">
            <Toggle
              checked={settings.reducedMotion}
              onChange={(v) => settings.set('reducedMotion', v)}
              label="Reduce motion"
              hint={
                profile.prefersReducedMotion
                  ? 'Your system already asks for reduced motion, so this is on regardless.'
                  : 'Stops petals, rain, drifting particles and piece animation.'
              }
            />
            <Toggle
              checked={settings.colorBlindSafe}
              onChange={(v) => settings.set('colorBlindSafe', v)}
              label="Colour-blind-safe markers"
              hint="Uses a blue/amber/violet palette, and shape rather than hue to separate moves from captures."
            />
            <Toggle
              checked={settings.highContrast}
              onChange={(v) => settings.set('highContrast', v)}
              label="High contrast interface"
            />
            <Slider
              label="Interface size"
              value={Math.round(settings.uiScale * 100)}
              min={80}
              max={150}
              step={5}
              onChange={(v) => settings.set('uiScale', v / 100)}
              format={(v) => `${v}%`}
            />
            <Field label="Legal-move markers">
              {(id) => (
                <Select
                  id={id}
                  value={settings.markerStyle}
                  onValueChange={(v) => settings.set('markerStyle', v)}
                  options={[
                    { value: 'dots', label: 'Dots' },
                    { value: 'rings', label: 'Rings' },
                    { value: 'squares', label: 'Squares' },
                  ]}
                />
              )}
            </Field>
            <Toggle
              checked={settings.showCoordinates}
              onChange={(v) => settings.set('showCoordinates', v)}
              label="Show board coordinates"
            />
            <Toggle
              checked={settings.showLegalMoves}
              onChange={(v) => settings.set('showLegalMoves', v)}
              label="Highlight legal moves"
            />
          </Panel>

          <Panel title="Playing">
            <Toggle
              checked={settings.premovesEnabled}
              onChange={(v) => settings.set('premovesEnabled', v)}
              label="Premoves"
              hint="Queue your reply while the opponent is thinking. The server still validates it when it fires."
            />
            <Toggle
              checked={settings.autoQueen}
              onChange={(v) => settings.set('autoQueen', v)}
              label="Always promote to queen"
              hint="Skips the promotion dialog."
            />
          </Panel>
        </div>

        <p className="settings__footer muted">
          Defaults: quality {DEFAULT_SETTINGS.quality}, {Math.round(DEFAULT_SETTINGS.masterVolume * 100)}% volume,
          3D board. <Link to="/credits">Asset credits and licences</Link>.
        </p>
      </div>
    </MenuShell>
  );
}
