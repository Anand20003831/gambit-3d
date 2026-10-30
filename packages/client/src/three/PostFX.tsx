import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { GradeSpec } from './themes/types.js';

/**
 * The look of a map.
 *
 * Each map is rendered through its own grade, which is what makes them read as
 * different places rather than the same room with the furniture moved: the
 * apartment gets neon bloom, a split-toned cyan/magenta cast and film grain,
 * the station gets clean highlights and a cold, clinical curve.
 *
 * Built on three's own composer rather than a post-processing library - the
 * passes needed here already ship with three, and the whole 3D stack is already
 * the largest chunk in the bundle.
 *
 * The stack is skipped entirely below the top quality tier, and the scene then
 * renders exactly as it did before.
 */

/**
 * Grade, applied after tone mapping so contrast, saturation and posterisation
 * act on the colours actually being shown rather than on linear radiance.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
    uShadowTint: { value: new THREE.Color('#000000') },
    uHighlightTint: { value: new THREE.Color('#ffffff') },
    uTintStrength: { value: 0 },
    uVignette: { value: 0 },
    uVignetteSoftness: { value: 0.5 },
    uGrain: { value: 0 },
    uAberration: { value: 0 },
    uPosterize: { value: 0 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uTintStrength;
    uniform float uVignette;
    uniform float uVignetteSoftness;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uPosterize;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 centred = vUv - 0.5;

      /**
       * Chromatic aberration. The offset grows with distance from the centre,
       * the way a real lens misbehaves, so the middle of the board stays sharp.
       */
      vec3 colour;
      if (uAberration > 0.0) {
        vec2 offset = centred * uAberration / uResolution.x * 8.0;
        colour = vec3(
          texture2D(tDiffuse, vUv + offset).r,
          texture2D(tDiffuse, vUv).g,
          texture2D(tDiffuse, vUv - offset).b
        );
      } else {
        colour = texture2D(tDiffuse, vUv).rgb;
      }

      /**
       * Split tone: shadows one way, highlights the other.
       *
       * The tint is divided through by its own luminance first, so it shifts
       * the hue without also lifting the exposure - otherwise every grade
       * quietly brightens the whole image.
       */
      if (uTintStrength > 0.0) {
        float l = luma(colour);
        vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.15, 0.85, l));
        tint /= max(luma(tint), 0.001);
        colour = mix(colour, colour * tint, uTintStrength);
      }

      colour = (colour - 0.5) * uContrast + 0.5;
      colour = mix(vec3(luma(colour)), colour, uSaturation);

      // Flattens the image into bands, for a drawn rather than rendered look.
      if (uPosterize > 1.0) {
        colour = floor(colour * uPosterize + 0.5) / uPosterize;
      }

      if (uVignette > 0.0) {
        float d = length(centred) * 1.414;
        colour *= 1.0 - uVignette * smoothstep(uVignetteSoftness, 1.0, d);
      }

      if (uGrain > 0.0) {
        float n = hash(vUv * uResolution + uTime) - 0.5;
        // Grain is far more visible in the shadows on real film.
        colour += n * uGrain * (1.0 - luma(colour) * 0.7);
      }

      gl_FragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * ShaderPass types its uniforms as a string index, which loses every name.
 * Keeping the concrete object means the grade can be set by field.
 */
type GradeUniforms = typeof GradeShader.uniforms;

export interface PostFXProps {
  grade: GradeSpec | null;
  enabled: boolean;
  reducedMotion: boolean;
}

export function PostFX({ grade, enabled, reducedMotion }: PostFXProps): null {
  const { gl, scene, camera, size } = useThree();
  const uniforms = useRef<GradeUniforms | null>(null);
  const active = enabled && grade !== null;

  const composer = useMemo(() => {
    if (!active || !grade) return null;

    const instance = new EffectComposer(gl);
    instance.addPass(new RenderPass(scene, camera));

    if (grade.bloom) {
      instance.addPass(
        new UnrealBloomPass(
          new THREE.Vector2(size.width, size.height),
          grade.bloom.strength,
          grade.bloom.radius,
          grade.bloom.threshold,
        ),
      );
    }

    // Tone mapping and the sRGB conversion the renderer would normally do
    // itself; rendering into a target skips both.
    instance.addPass(new OutputPass());

    const pass = new ShaderPass(GradeShader);
    uniforms.current = pass.uniforms as GradeUniforms;
    instance.addPass(pass);

    return instance;
    // `size` deliberately absent: resizing is handled below rather than by
    // rebuilding the whole stack on every drag of the window edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, grade, gl, scene, camera]);

  useEffect(() => {
    if (!composer) return;
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(gl.getPixelRatio());
    uniforms.current?.uResolution.value.set(size.width, size.height);
  }, [composer, size.width, size.height, gl]);

  useEffect(() => {
    const u = uniforms.current;
    if (!u || !grade) return;
    u.uContrast.value = grade.contrast;
    u.uSaturation.value = grade.saturation;
    u.uShadowTint.value.set(grade.shadowTint);
    u.uHighlightTint.value.set(grade.highlightTint);
    u.uTintStrength.value = grade.tintStrength;
    u.uVignette.value = grade.vignette;
    u.uVignetteSoftness.value = grade.vignetteSoftness;
    u.uGrain.value = reducedMotion ? 0 : grade.grain;
    u.uAberration.value = grade.aberration;
    u.uPosterize.value = grade.posterize;
  }, [grade, reducedMotion, composer]);

  useEffect(
    () => () => {
      composer?.dispose();
    },
    [composer],
  );

  /**
   * Priority above zero takes the render loop over from the canvas, so this has
   * to actually draw. When the stack is off it returns without claiming the
   * frame and normal rendering continues.
   */
  useFrame((state, delta) => {
    if (!composer) return;
    const u = uniforms.current;
    if (u && !reducedMotion) u.uTime.value += delta;
    composer.render(delta);
  }, active ? 1 : 0);

  return null;
}
