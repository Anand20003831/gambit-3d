import { useEffect, useRef } from 'react';
import type { ThemeId } from '@gambit3d/shared';
import { audio } from '../audio/engine.js';
import { loadManifest, musicFor, sfxFor } from '../three/assets.js';
import { useSettings } from './useSettings.js';

/**
 * Binds the audio engine to settings and the active map.
 *
 * Sampled cues are loaded when a map becomes active and layered over the
 * synthesised voices; the ambience track is a separate <audio> element so a
 * multi-megabyte loop streams rather than sitting decoded in memory.
 */

const loadedThemes = new Set<ThemeId>();

export function useAudioBinding(themeId: ThemeId): void {
  const settings = useSettings();
  const musicEl = useRef<HTMLAudioElement | null>(null);
  const fadeTimer = useRef<number | null>(null);

  // Levels
  useEffect(() => {
    audio.setLevels({
      master: settings.masterVolume,
      sfx: settings.sfxVolume,
      music: settings.musicVolume,
      muted: settings.muted,
    });
  }, [settings.masterVolume, settings.sfxVolume, settings.musicVolume, settings.muted]);

  // Theme voice + sampled cues
  useEffect(() => {
    audio.setTheme(themeId);
    if (loadedThemes.has(themeId)) return undefined;

    let cancelled = false;
    void (async () => {
      await loadManifest();
      if (cancelled) return;
      const cues = sfxFor(themeId);
      // Failures are silent by design: the synth voice already covers every cue.
      await Promise.all(
        Object.entries(cues).map(([name, url]) => audio.loadSample(`${themeId}:${name}`, url)),
      );
      if (!cancelled) loadedThemes.add(themeId);
    })();

    return () => {
      cancelled = true;
    };
  }, [themeId]);

  // Ambience: streamed music track plus the synthesised bed underneath it.
  useEffect(() => {
    const wanted = settings.ambienceEnabled && !settings.muted;

    if (!wanted) {
      stopMusic(musicEl, fadeTimer);
      audio.stopAmbience();
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      await loadManifest();
      if (cancelled) return;

      // The synthesised bed always plays; it is what gives each map its tone
      // even when no music file exists.
      if (audio.isUnlocked) audio.startAmbience();

      const track = musicFor(themeId);
      if (!track) return;

      if (musicEl.current?.dataset.theme !== themeId) {
        stopMusic(musicEl, fadeTimer);
        const el = new Audio(track.url);
        el.loop = true;
        el.preload = 'auto';
        el.dataset.theme = themeId;
        el.volume = 0;
        musicEl.current = el;
        // Autoplay may be refused until a gesture; the settings toggle counts.
        el.play().catch(() => undefined);
      }

      const target = clamp01(settings.musicVolume * settings.masterVolume);
      fadeTo(musicEl.current, target, fadeTimer);
    })();

    return () => {
      cancelled = true;
    };
  }, [themeId, settings.ambienceEnabled, settings.muted, settings.musicVolume, settings.masterVolume]);

  // Stop everything on unmount.
  useEffect(
    () => () => {
      stopMusic(musicEl, fadeTimer);
      audio.stopAmbience();
    },
    [],
  );

  // The first user gesture anywhere unlocks the AudioContext.
  useEffect(() => {
    const unlock = (): void => {
      void audio.unlock().then((ok) => {
        if (ok && settings.ambienceEnabled && !settings.muted) audio.startAmbience();
      });
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
    for (const event of events) window.addEventListener(event, unlock, { once: true, passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, unlock);
    };
  }, [settings.ambienceEnabled, settings.muted]);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function fadeTo(el: HTMLAudioElement | null, target: number, timer: React.MutableRefObject<number | null>): void {
  if (!el) return;
  if (timer.current) window.clearInterval(timer.current);
  timer.current = window.setInterval(() => {
    const delta = target - el.volume;
    if (Math.abs(delta) < 0.02) {
      el.volume = target;
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
      return;
    }
    el.volume = clamp01(el.volume + Math.sign(delta) * 0.02);
  }, 40);
}

function stopMusic(
  ref: React.MutableRefObject<HTMLAudioElement | null>,
  timer: React.MutableRefObject<number | null>,
): void {
  if (timer.current) {
    window.clearInterval(timer.current);
    timer.current = null;
  }
  const el = ref.current;
  if (!el) return;
  el.pause();
  el.src = '';
  ref.current = null;
}
