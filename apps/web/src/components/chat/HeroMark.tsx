import React, { useEffect, useRef } from "react";
import AiMark from "../shared/AiMark";
import { MOBILE_QUERY } from "../../utils/viewport";

interface Props {
  /** The fallback SVG spark's intrinsic size in px; CSS scales it with the orb, and the shader sizes its own spark to the orb. */
  iconSize?: number;
  className?: string;
}

/**
 * Rye's AI mark as light inside a small drop of glass (a WebGL fragment shader). The glass is clear and dark (frosted
 * and pale on a light theme) and not quite round: its outline slowly leans, stretches and swells like a droplet, and
 * the lens follows the outline. Inside, one continuous field of light flows like dye in water (domain-warped noise,
 * turned by a slow swirl, so bright threads stretch, fold and thin), in the accent colours, white only in its hottest
 * cores, with faint prismatic fringes on the edges of the bright threads. The glass reads as glass: a window's
 * reflection at the upper left that slides as the drop moves, Fresnel sheen brightening the rim, the lens squeezing the
 * flow against the edge, and a caustic pooling light at the lower inside. The spark sits in the middle as the brightest
 * light, seen through the same glass: softened and bent by the flow and the lens, veiled and tinted where bright flow
 * passes in front. Light blooms past the edge onto a faint, slowly turning ring of dots that follows the outline.
 * Decorative. Until the first frame lands, and whenever WebGL is unavailable or lost, the CSS fallback shows instead:
 * the `.hero-mark::before`/`::after` gradients with the AiMark SVG on top.
 * Colours are read from CSS variables at draw time and re-read when the theme or accent changes on <html>.
 * Motion: ~30 fps, paused while the tab is hidden or the orb is off screen; one still frame under reduced motion.
 * Hovering speeds everything up, deepens the lens and the shape's sway, and tilts the view toward the pointer.
 * Small devices (four cores or fewer, or a phone-width window) get a lighter shader and at most 1.5× pixel density.
 */
export default function HeroMark({ iconSize = 24, className }: Props) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    return host ? startOrb(host) : undefined;
  }, []);

  return (
    <span ref={hostRef} className={className ? `hero-mark ${className}` : "hero-mark"} aria-hidden="true">
      <AiMark size={iconSize} className="hero-mark-icon" />
    </span>
  );
}

type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

/** The shader's detail: noise octaves and wavelength samples per rainbow, full and on the lighter path. */
const DETAIL = { full: { octaves: 3, samples: 7 }, lite: { octaves: 2, samples: 5 } };

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Coordinates are in orb radii, centred on the orb, y up. The outline is a circle bent by four slow low-frequency
// terms (uShape phases, uShapeAmp amplitudes; a few percent of the radius). Inside, a point is normalised onto the
// unit disc (s) and given a dome's height; the deformed outline tilts the dome's normal along the rim, so the lens and
// the reflections follow the shape.
// Refraction: what is seen at a point comes from a content point pushed out along the normal (ever more steeply toward
// the rim, so the flow near the edge is squeezed into a thin band and swings as the shape moves), past a thick spot
// drifting through the glass (it magnifies what passes under it), then turned by a swirl that is strongest in the
// middle (it winds the threads round the spark and back).
// The flow: gradient-noise fbm, domain-warped twice (a, then b, both drifting on slow closed loops set on the CPU),
// so the field folds and stretches like dye; the final field f is lit where it is high (dye: a steep rise plus a thin
// thread just below it), only where the first warp gathers it, and its colour runs continuously between the accent
// colours by the warp's own values. Dispersion: f is evaluated at three wavelengths
// (shifted along the lens's and a small prism's direction) and interpolated quadratically for every wavelength sample;
// the spectral sum of the lit density, minus the undispersed light, is the fringe. Every rainbow (fringe, caustic,
// rim line, the spark's edge) is a sum over wavelength samples (uWave: spectrum weights, normalised on the CPU)
// blended in linear light, never per-channel offsets.
// The spark is a superellipse star (AiMark's curves), lensed more than the flow (it sits deeper), bent by the warp,
// twisted a little by the swirl; its dispersion is applied per wavelength through its distance and gradient. Bright
// flow passing in front veils and tints its glow; a squeezed reflection of it slides round the inner rim.
// Glass: Fresnel sheen of a dim room (brighter above) at grazing angles, a window's reflection (a soft pane with one
// mullion, found by the reflected view ray, so it curves and slides with the surface), a thin refracted rim line, and a
// caustic pooling at the lower inside. Dark: light added to the dark glass and tone mapped. Light: it tints a pale
// frosted body by coverage and turns white where hottest. Outside (no flow evaluated there): a bloom lit by a cheap
// estimate of the flow at the rim, and a faint ring of dots. Every phase and drift is wrapped on the CPU, so the shader
// never sees a large value. The output is premultiplied (the canvas is transparent) and the outline is a
// one-and-a-half pixel smoothstep on the outline's distance, so it never fringes.
const fragment = (octaves: number, samples: number) => `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define SAMPLES ${samples}
#define OCTAVES ${octaves}
#define FBM_NORM ${(0.55 / (0.5 * (1 - 0.45 ** octaves))).toFixed(6)}
varying vec2 vUv;
uniform float uScale;
uniform float uPx;
uniform float uCss;
uniform float uRadius;
uniform vec4 uShape;
uniform vec4 uShapeAmp;
uniform vec4 uFlow;
uniform vec4 uDriftA;
uniform vec4 uDriftB;
uniform vec4 uDriftC;
uniform vec4 uBlob;
uniform vec4 uCaustic;
uniform vec4 uDots;
uniform vec2 uLight;
uniform float uGlow;
uniform vec3 uSpark;
uniform vec4 uSparkLive;
uniform vec3 uWave[SAMPLES];
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uBody;
uniform vec3 uBodyRim;
uniform vec3 uCore;
uniform vec3 uSparkGlow;
uniform vec3 uSpec;
uniform vec3 uRoom;
uniform vec3 uDot;
uniform vec4 uFluid;
uniform vec4 uLens;
uniform vec4 uDisp;
uniform vec4 uTone;
uniform vec4 uGlass;
uniform vec4 uSparkP;

const float TAU = 6.2831853;
const float FREQ = 0.62;

float bump(float x) {
  return exp(-x * x);
}

float maxOf(vec3 c) {
  return max(c.r, max(c.g, c.b));
}

// Gradient noise on an arithmetic hash (no sines, so it stays exact at any offset the CPU sends), 0-1.
vec2 hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash(i), f);
  float b = dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return 0.5 + 0.9 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractal noise, 0-1: each octave doubles the frequency, turned so the lattice never shows.
float fbm(vec2 p) {
  float v = 0.0;
  float k = 0.5;
  for (int i = 0; i < OCTAVES; i++) {
    v += k * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(1.7, 9.2);
    k *= 0.45;
  }
  return v * FBM_NORM;
}

// The dye's light from the field: dark where the field is low, rising steeply above uFluid.y, with a thin thread of
// light just below that edge (uDisp.y) that stretches and thins with the warp. High dynamic range.
float dye(float f) {
  float t = smoothstep(uFluid.y, uFluid.z, f);
  return uFluid.x * (t * t + uDisp.y * bump((f - uFluid.y + 0.04) / 0.035));
}

// A four-point star with concave sides: a superellipse with exponent 0.6, which matches AiMark's curves. Returns its
// norm g (1 on the outline; it scales linearly about the star's centre, so g * e is the star magnified 1/e), |grad g|,
// and the unit gradient. The true gradient blows up along the axes; capping it keeps it sane.
vec4 starField(vec2 p, vec2 c, vec2 size) {
  vec2 v = p - c;
  vec2 d = abs(v) / size + 0.0001;
  vec2 dn = pow(d, vec2(0.6));
  float sum = dn.x + dn.y;
  float g23 = pow(sum, 0.6666667);
  vec2 grad = g23 * min(dn / d, vec2(2.5)) / size * sign(v);
  float len = max(length(grad), 0.001);
  return vec4(sum * g23, len, grad / len);
}

// Distance (orb radii) to the star outline scaled by e, from its norm g, |grad g| and the distance r from its centre.
float starDist(float g, float len, float r, float e) {
  float ge = g * e;
  return max((ge - 1.0) / len, 0.85 * r * (1.0 - 1.0 / max(ge, 0.001)));
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uScale / uRadius;
  float r = length(p);
  float around = atan(p.y, p.x + 0.00001);
  // The outline: a circle bent by four slow, low-frequency terms (a droplet that leans, stretches and swells).
  vec4 ph = vec4(1.0, 2.0, 3.0, 4.0) * around + uShape;
  float R = 1.0 + dot(uShapeAmp, sin(ph));
  float slope = dot(uShapeAmp * vec4(1.0, 2.0, 3.0, 4.0), cos(ph));
  float dist = (r - R) / sqrt(1.0 + slope * slope / (R * R));
  float aa = 0.75 * uPx / uRadius;
  float inside = 1.0 - smoothstep(-aa, aa, dist);
  mat2 turn0 = mat2(uFlow.x, uFlow.y, -uFlow.y, uFlow.x);

  // A cheap estimate of the flow just inside the rim at this angle (two noise lookups): it lights the bloom, the dots
  // and the rim line.
  vec2 dirP = p / max(r, 0.0001);
  vec2 rq = turn0 * dirP * (1.9 * FREQ);
  float rimN = noise(rq * 0.8 + uDriftA.xy);
  vec3 rimCol = mix(uColA, uColB, smoothstep(0.3, 0.7, noise(rq * 0.6 + uDriftB.zw)));
  float rimI = uFluid.x * 0.45 * smoothstep(0.3, 0.75, rimN);
  vec3 edgeLight = rimCol * rimI;

  // Outside: a bloom lit by the light nearest the rim, fading out before the canvas edge.
  float o = max(dist, 0.0) * uRadius;
  float reach = uScale - 1.0 - dot(uShapeAmp, vec4(1.0));
  float fade = 1.0 - smoothstep(reach * 0.5, reach * 0.97, o);
  vec3 bloomE = (edgeLight * 1.3 + uColA * 0.05 + uColB * 0.025)
    * (exp(-o * 17.0) * 0.8 + exp(-o * 6.5) * 0.15) * uGlass.w * uGlow * fade;
  vec3 bloom = pow(1.0 - exp(-bloomE), vec3(1.0 / 2.2));
  vec4 outside = vec4(bloom, maxOf(bloom));

  // A faint ring of dots following the outline: concentric rings (alternate ones turning the other way), each dot
  // twinkling on its own.
  float ro = 1.0 + dist;
  float gap = max(0.1, 3.6 * uCss);
  float ring0 = 1.16;
  float k = clamp(floor((ro - ring0) / gap + 0.5), 0.0, 4.0);
  float rr = ring0 + k * gap;
  float odd = mod(k, 2.0);
  float count = floor(TAU * rr / max(0.075, 2.8 * uCss));
  float spin = mix(uDots.x, -uDots.w, odd);
  float fd = fract((around + spin) / TAU) * count + 0.5 * odd;
  float idx = mod(floor(fd), count);
  float along = (fract(fd) - 0.5) * TAU * rr / count;
  float dotR = max(0.018, 0.6 * uCss);
  float dotMask = 1.0 - smoothstep(dotR - aa, dotR + aa, length(vec2(along, ro - rr)));
  float h1 = fract(sin(idx * 12.9898 + k * 78.233) * 43758.5453);
  float h2 = fract(sin(idx * 39.3468 + k * 11.135) * 24634.6345);
  float twinkle = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uDots.y * (1.0 + floor(h2 * 3.0)) + h1 * TAU), 4.0);
  float lit = 0.45 + 0.55 * clamp(rimI * 0.6, 0.0, 1.0);
  float da = dotMask * twinkle * lit * uDots.z * fade * smoothstep(0.08, 0.17, o) * exp(-o * 1.2);
  outside = vec4(uDot * da, da) + outside * (1.0 - da);

  // Wholly outside the glass: nothing more to do (the flow is only evaluated inside).
  if (inside <= 0.0) {
    gl_FragColor = outside;
    return;
  }

  // Onto the glass: s is the point in the unit disc (the outline normalised to a circle), z the dome's height there.
  vec2 s = p / R;
  s /= max(length(s), 1.0);
  float rs = length(s);
  vec2 dirS = s / max(rs, 0.0001);
  float z = sqrt(max(1.0 - rs * rs, 0.0));
  float edge = 1.0 - z;
  vec2 tangent = vec2(-dirS.y, dirS.x);
  // The deformed outline tilts the surface: where the radius changes round the rim, the normal leans along it.
  vec2 tilt = tangent * (-slope / R) * rs;
  vec3 n = normalize(vec3(s + tilt, z));
  // Refraction: content seen through a point comes from further out along the normal, ever more steeply toward the rim.
  vec2 refr = n.xy / (n.z + 0.35);
  vec2 view = uLight * 0.25 * edge;

  // The content behind the glass: the lens, the thick spot, then the swirl (strongest in the middle).
  vec2 q = s + uFlow.w * refr + view;
  vec2 bd = q - uBlob.xy;
  vec2 blob = -bd * uBlob.z * exp(-dot(bd, bd) / (uBlob.w * uBlob.w));
  q += blob;
  float vort = uFlow.z * exp(-dot(q, q) * 1.2);
  mat2 turn = turn0 * mat2(cos(vort), sin(vort), -sin(vort), cos(vort));

  // The dye: noise warped by noise warped by noise, each layer drifting on its own slow loop.
  vec2 c = turn * q * FREQ;
  vec2 a = vec2(fbm(c + uDriftA.xy), fbm(c + uDriftA.zw));
  vec2 b = vec2(fbm(c + 1.7 * a + uDriftB.xy), fbm(c + 1.7 * a + uDriftB.zw));
  vec2 wq = c + 2.0 * b + uDriftC.xy;
  // Dispersion: the field at three wavelengths (red end, middle, violet end), shifted along the lens and a prism.
  vec2 D = turn * (-uDisp.x * uFlow.w * refr + vec2(0.8, -0.6) * uDisp.z) * FREQ;
  float f0 = fbm(wq);
  float fr = fbm(wq + 0.5 * D);
  float fv = fbm(wq - 0.5 * D);
  float f1 = fr - fv;
  float f2 = 2.0 * (fr + fv - 2.0 * f0);
  // Where the dye gathers (the first warp's own slow field), and its colour, running between the accent colours.
  float gather = uFluid.w + (1.0 - uFluid.w) * smoothstep(0.3, 0.6, a.x);
  vec3 col = mix(uColA, uColB, smoothstep(0.38, 0.66, b.y));
  col = mix(col, uColC, 0.6 * smoothstep(0.5, 0.72, a.y));

  // The spark sits deep in the glass: lensed more than the flow, carried by the thick spot, bent by the warp.
  float u = uSpark.z * uSparkLive.x;
  vec2 ps = s + uLens.x * uFlow.w * refr + view * 0.6 + blob * 1.3 + (b - vec2(0.5)) * uSparkLive.y;
  vec2 sv0 = ps - uSpark.xy;
  float twist = 0.16 * uFlow.z * (1.0 - exp(-dot(sv0, sv0) * 25.0));
  ps = uSpark.xy + mat2(cos(twist), sin(twist), -sin(twist), cos(twist)) * sv0;
  vec2 cB = uSpark.xy + vec2(8.5, -7.5) * u;
  vec4 sA = starField(ps, uSpark.xy, vec2(8.0, 9.0) * u);
  vec4 sB = starField(ps, cB, vec2(2.5, 3.0) * u);
  float rA = length(ps - uSpark.xy);
  float rB = length(ps - cB);

  // The caustic: light focused through the glass pooling at the lower inside, a crescent wider in its middle.
  vec2 cdir = vec2(cos(uCaustic.x), sin(uCaustic.x));
  float arcA = bump((1.0 - dot(dirS, cdir)) * uCaustic.y);
  float arcR = uCaustic.w + 0.02 * sin(2.0 * around + uShape.y);
  float arcW = 0.016 + 0.035 * arcA;

  // Wavelength sums (weights normalised on the CPU): the dye, the caustic, the rim line and the spark.
  vec2 prism = vec2(0.8, -0.6);
  vec2 dStar = -uDisp.x * uLens.x * uFlow.w * refr + prism * uDisp.z;
  float kA = dot(sA.zw, dStar);
  float kB = dot(sB.zw, dStar);
  float sw = aa + 0.011;
  vec3 spec = vec3(0.0);
  vec3 arcS = vec3(0.0);
  vec3 rimS = vec3(0.0);
  vec3 coreS = vec3(0.0);
  vec3 nearS = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float dt = (float(i) + 0.5) / float(SAMPLES) - 0.5;
    vec3 w = uWave[i];
    spec += w * dye(f0 + dt * f1 + dt * dt * f2);
    arcS += w * bump((rs - arcR - dt * 0.08) / arcW);
    rimS += w * bump((rs - 0.978 + dt * 0.028) / 0.014);
    float e = 1.0 + dt * uDisp.w;
    float dS = min(starDist(sA.x, sA.y, rA, e) + dt * kA, starDist(sB.x, sB.y, rB, e) + dt * kB);
    coreS += w * (1.0 - smoothstep(-sw, sw, dS));
    nearS += w * exp(-max(dS, 0.0) * 55.0);
  }

  float dr = rA;
  float beyond = max(min(starDist(sA.x, sA.y, rA, 1.0), starDist(sB.x, sB.y, rB, 1.0)), 0.0);
  // The flow dims a little round the spark so it stays the brightest light, and readable.
  float shade = (1.0 - uSparkP.w * bump(dr / (u * 13.0))) * gather;
  float I0 = dye(f0);
  float I = I0 * shade;
  vec3 fringe = max(spec - vec3(I0), 0.0) * uLens.y * shade;
  float hot = max(I - 1.0, 0.0);
  vec3 E = col * I + uCore * hot * hot * uLens.w + fringe + col * (0.35 + f0) * gather * uLens.z;
  // The caustic pools the light that reaches it, with a soft glow round its bright edge.
  vec3 pool = uCore * 0.5 + col * 0.5 + edgeLight * 0.6;
  E += (arcS + 0.25 * bump((rs - arcR + 0.06) / 0.09)) * arcA * uCaustic.z * uGlow * pool;
  E += rimS * (uCore * 0.06 + edgeLight * 1.6 + col * 0.25) * uGlass.z;

  // Bright flow passes in front of the spark: where it does, it veils the glow and tints it the flow's colour.
  float front = I * smoothstep(0.42, 0.6, a.y);
  float cover = 1.0 - exp(-front * 0.9);
  vec3 veil = mix(vec3(1.0), col / max(maxOf(col), 0.001), cover * 0.85) * (1.0 - 0.5 * cover);
  float near = max(1.0 - smoothstep(u * 7.0, u * 12.0, dr), 1.0 - smoothstep(u * 2.5, u * 5.0, rB));
  float hotMiddle = bump(dr / (u * 5.5));
  vec3 coreTint = mix(vec3(1.0), veil, 0.5);
  vec3 sparkHalo = (uCore * nearS * 0.7 * near
    + uSparkGlow * (exp(-beyond * uSparkP.y) * near * uSparkP.z + bump(dr / (u * 11.0)) * uSparkP.z * 0.12))
    * uGlow * veil;
  E += sparkHalo + mix(uSparkGlow * 1.3, uCore, 0.3 + 0.7 * hotMiddle) * coreS * uSparkP.x * coreTint * (1.0 - uTone.x);

  // A faint reflection of the spark on the inner surface: flipped, squeezed against the rim, sliding round it.
  vec2 dirR = vec2(cos(uSparkLive.z), sin(uSparkLive.z));
  vec2 rv = s - dirR * 0.8;
  vec2 lr = vec2(dot(rv, vec2(-dirR.y, dirR.x)) * 0.6, -dot(rv, dirR) * 3.2);
  vec4 sR = starField(lr, vec2(0.0), vec2(8.0, 9.0) * u * 0.45);
  float refl = exp(-max(sR.x - 0.4, 0.0) * 2.2) * smoothstep(0.6, 0.8, rs);
  E += (uCore * 0.6 + edgeLight * 0.8 + uSparkGlow * 0.3) * refl * uSparkLive.w * uGlow;

  // The glass: deeper toward the rim and away from the key light.
  vec2 key = normalize(vec2(-0.62, 0.78) + uLight * 0.6);
  float deep = clamp(pow(edge, 2.5) + 0.3 * (0.5 - 0.5 * dot(s, key)), 0.0, 1.0);
  vec3 body = mix(uBody, uBodyRim, deep);

  // Dark: light added to the dark glass and tone mapped. Light: the light tints the frosted body.
  vec3 darkCol = 1.0 - exp(-(body + E) * uTone.y);
  float m = maxOf(E);
  vec3 tint = pow(E / max(m, 0.0001), vec3(uTone.w)) * uTone.y;
  vec3 lightCol = mix(body, tint, 1.0 - exp(-m * uTone.z));
  lightCol = mix(lightCol, uCore, smoothstep(2.0, 3.6, I));
  lightCol = mix(lightCol, uSparkGlow * veil, clamp(exp(-beyond * uSparkP.y) * near * 0.85 * uGlow, 0.0, 1.0));
  lightCol = mix(lightCol, mix(uSparkGlow, uCore, 0.85 + 0.15 * hotMiddle) * coreTint, clamp(coreS * 2.5, 0.0, 1.0));
  vec3 col3 = mix(darkCol, lightCol, uTone.x);

  // Reflections on the surface, found by the reflected view ray (so they curve and slide with the surface): a dim
  // room at grazing angles (Fresnel; brighter above) and a window up and to the left, a soft pane with one mullion.
  vec3 refl3 = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
  vec2 st = refl3.xy / max(1.0 + refl3.z, 0.25);
  vec2 wc = vec2(-0.56, 0.6) + uDriftC.zw - uLight * 0.25;
  vec2 wv = st - wc;
  vec2 wd = abs(wv) - vec2(0.15, 0.2);
  float win = 1.0 - smoothstep(-0.05, 0.04, max(wd.x, wd.y));
  vec2 wm = abs(wv);
  win *= 1.0 - 0.45 * (1.0 - smoothstep(0.006, 0.02, wm.x));
  win *= 0.55 + 0.45 * smoothstep(-0.17, 0.17, wv.y);
  float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 4.0);
  float room = 0.35 + 0.65 * smoothstep(-0.7, 0.8, n.y);
  vec3 sheen = uRoom * fres * room * uGlass.y + uSpec * win * uGlass.x;
  col3 = mix(col3, uSpec, clamp(maxOf(sheen), 0.0, 1.0) * uTone.x) + sheen * (1.0 - uTone.x);

  vec3 orb = pow(max(col3, 0.0), vec3(1.0 / 2.2));
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  orb = clamp(orb + (dn - 0.5) / 255.0, 0.0, 1.0);

  gl_FragColor = vec4(orb, 1.0) * inside + outside * (1.0 - inside);
}`;

/** The moment shown under reduced motion (and the first frame otherwise). */
const STILL_FLOW = 9;
const STILL_BREATH = 1.5;
/** Hover multiplies the flow's speed by up to 1 + HOVER_BOOST. */
const HOVER_BOOST = 1.2;
/** One slow breath (size, lens, glow and the spark) every this many seconds. */
const BREATH_SECONDS = 6.5;
/**
 * The outline's four terms (k = 1…4 lobes round the rim), in orb radii: k = 1 leans it like a droplet, k = 2 stretches
 * it, k = 3 and 4 add a soft asymmetry. Each amplitude swells and fades slowly (SHAPE_SWELL, radians per second), so
 * the outline departs about 4–7% from a circle; hover raises them by HOVER_SHAPE.
 */
const SHAPE_AMPS = [0.016, 0.028, 0.018, 0.006];
const SHAPE_RATES = [0.13, -0.09, 0.07, -0.05];
const SHAPE_SWELL = [0.031, 0.043, 0.057, 0.071];
const HOVER_SHAPE = 0.3;
/** The lens's strength (how far content is pushed out along the surface normal), its breath, and hover's addition. */
const LENS = 0.32;
const LENS_BREATH = 0.03;
const HOVER_LENS = 0.08;
/** How far the view leans toward the pointer. */
const LEAN = 0.3;
/** The spark's height as a share of the orb's diameter (AiMark's main star is 18 of its 24 units tall). */
const SPARK_SHARE = 0.34;
const FRAME_MS = 1000 / 30;
const MAX_DPR = 2;
/** The lighter path's pixel density cap. */
const LITE_DPR = 1.5;
const TAU = Math.PI * 2;
/** The flow's slow turn (radians per second) and how far the swirl in the middle swings either way (radians). */
const TURN_RATE = 0.06;
const SWIRL = 1.3;
/**
 * The dye's drifts: each noise layer's offset circles a fixed point (centre, radius, radians per second), so the
 * field keeps morphing without ever reaching a large coordinate. Two for the first warp, two for the second, one for
 * the final field.
 */
const DRIFTS: { centre: Vec2; radius: number; rate: number; phase: number }[] = [
  { centre: [0.0, 0.0], radius: 0.7, rate: 0.07, phase: 0.0 },
  { centre: [5.2, 1.3], radius: 0.7, rate: -0.06, phase: 1.3 },
  { centre: [1.7, 9.2], radius: 0.9, rate: 0.09, phase: 2.6 },
  { centre: [8.3, 2.8], radius: 0.9, rate: -0.08, phase: 4.1 },
  { centre: [3.1, 6.4], radius: 0.6, rate: 0.05, phase: 0.7 },
];
/** Orb radii per AiMark viewBox unit (the main star's centre is one unit left of and above the middle). */
const SPARK_UNIT = (SPARK_SHARE * 2 * (24 / 18)) / 24;

const bump = (x: number) => Math.exp(-x * x);
/** A smooth visible spectrum: t = 0 is violet, t = 1 is red. */
const spectrum = (t: number): Vec3 => [
  bump((t - 0.82) / 0.2) + 0.3 * bump(t / 0.1),
  bump((t - 0.52) / 0.19),
  bump((t - 0.2) / 0.2),
];
/** The shader's wavelength weights: `samples` spectrum colours, each channel normalised to sum to 1 (so white stays white). */
const waves = (samples: number) => {
  const list = Array.from({ length: samples }, (_, i) => spectrum((i + 0.5) / samples));
  const total = list.reduce<Vec3>((sum, c) => [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]], [0, 0, 0]);
  return new Float32Array(list.flatMap((c) => [c[0] / total[0], c[1] / total[1], c[2] / total[2]]));
};

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const toLinear = (c: Vec3): Vec3 => [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];
const luma = (c: Vec3) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const grey = (c: Vec3): Vec3 => [luma(c), luma(c), luma(c)];
const scale3 = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
/** Push a colour away from its own grey by `amount` (1 = unchanged), clamped to 0–1. */
const saturate = (c: Vec3, amount: number): Vec3 => {
  const g = luma(c);
  return c.map((v) => Math.min(1, Math.max(0, g + (v - g) * amount))) as Vec3;
};
/** Turn a colour's hue by `degrees` round the grey axis (keeps its lightness roughly), clamped to 0–1. */
const rotateHue = (c: Vec3, degrees: number): Vec3 => {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const k = (1 - cos) / 3;
  const r3 = Math.sqrt(1 / 3) * sin;
  const m = [cos + k, k - r3, k + r3, k + r3, cos + k, k - r3, k - r3, k + r3, cos + k];
  return [0, 1, 2].map((i) =>
    Math.min(1, Math.max(0, m[i * 3] * c[0] + m[i * 3 + 1] * c[1] + m[i * 3 + 2] * c[2])),
  ) as Vec3;
};
const chroma = (c: Vec3) => Math.max(...c) - Math.min(...c);
/**
 * A colour as light: in linear light, its brightest channel at 1 and the others pushed down (`depth` > 1), so it
 * stays vivid until it is bright enough to turn white.
 */
const vivid = (c: Vec3, depth: number): Vec3 => {
  const linear = toLinear(c);
  const top = Math.max(...linear, 0.0001);
  return linear.map((v) => (v / top) ** depth) as Vec3;
};
const approach = (from: number, to: number, k: number) => from + (to - from) * k;

/** Resolve a colour custom property to 0–1 sRGB channels by painting it on a 1×1 2D canvas (any CSS colour syntax). */
function readColor(style: CSSStyleDeclaration, name: string, probe: CanvasRenderingContext2D): Vec3 | null {
  const value = style.getPropertyValue(name).trim();
  if (!value) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "transparent";
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return a === 0 ? null : [r / 255, g / 255, b / 255];
}

interface Palette {
  /** The flow's colours, the glass (centre and rim), the spark's core and glow, reflections, the room: linear light. */
  colA: Vec3;
  colB: Vec3;
  colC: Vec3;
  body: Vec3;
  bodyRim: Vec3;
  core: Vec3;
  sparkGlow: Vec3;
  spec: Vec3;
  room: Vec3;
  /** The ring of dots, sRGB (composited by the page). */
  dot: Vec3;
  /** The dye's brightness, the field's dark and bright thresholds, the light left where the dye doesn't gather. */
  fluid: Vec4;
  /** How much more the spark is lensed than the flow (it sits deeper), fringe strength, haze, white in the hottest light. */
  lens: Vec4;
  /** Dispersion of the lens, the dye's thin threads (not dispersion), sideways dispersion (prism), the spark's. */
  disp: Vec4;
  /** Light theme (0/1), exposure (dark) or tint brightness (light), coverage (light), tint depth (light). */
  tone: Vec4;
  /** Window reflection, Fresnel sheen, rim line, bloom. */
  glass: Vec4;
  /** Spark core, glow sharpness, glow strength, how much the flow dims round it. */
  sparkP: Vec4;
  /** Caustic strength, the spark's reflection on the inner rim, how far the warp bends the spark, the dots' opacity. */
  caustic: number;
  reflection: number;
  bend: number;
  dots: number;
}

function readPalette(host: HTMLElement, probe: CanvasRenderingContext2D): Palette | null {
  const style = getComputedStyle(host);
  const accent = readColor(style, "--main-accent", probe);
  const alt = readColor(style, "--main-accent-alt", probe) ?? accent;
  const ai = readColor(style, "--main-ai-accent", probe) ?? accent;
  const bg = readColor(style, "--main-bg", probe);
  const fg = readColor(style, "--main-fg", probe);
  if (!accent || !alt || !ai || !bg || !fg) return null;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  // A neutral accent (graphite) gets cool silver light: the AI accent, mostly drained of colour.
  const neutral = chroma(accent) < 0.15;
  const cool = mix(grey(ai), ai, 0.4);
  return dark
    ? // Dark: clear, dark glass; vivid light inside it (the accent, the AI accent and the accent turned toward magenta).
      {
        colA: neutral ? toLinear(mix(accent, cool, 0.35)) : vivid(accent, 2.2),
        colB: neutral ? toLinear(cool) : vivid(ai, 1.6),
        colC: neutral ? toLinear(mix(fg, cool, 0.6)) : vivid(rotateHue(accent, 40), 1.8),
        body: scale3(toLinear(bg), 0.35),
        bodyRim: scale3(toLinear(mix(bg, accent, 0.08)), 0.9),
        core: toLinear(fg),
        sparkGlow: toLinear(saturate(mix(alt, fg, 0.2), 1.6)),
        spec: toLinear(fg),
        room: toLinear(mix(fg, neutral ? cool : alt, 0.3)),
        dot: mix(fg, accent, 0.45),
        fluid: [3.2, 0.48, 0.72, 0.06],
        lens: [1.35, 0.5, 0.02, 0.4],
        disp: [0.22, 0.1, 0.12, 0.45],
        tone: [0, 1, 0, 1],
        glass: [0.16, 0.5, 1, 0.5],
        sparkP: [4, 18, 1.3, 0.2],
        caustic: 1.1,
        reflection: 0.3,
        bend: 0.06,
        dots: 0.22,
      }
    : // Light: pale frosted glass; the same light, as colour.
      {
        colA: toLinear(neutral ? mix(cool, accent, 0.3) : accent),
        colB: toLinear(neutral ? cool : ai),
        colC: toLinear(neutral ? mix(cool, ai, 0.3) : rotateHue(accent, 40)),
        body: toLinear(mix(bg, neutral ? cool : accent, 0.05)),
        bodyRim: toLinear(mix(bg, neutral ? cool : alt, 0.24)),
        core: toLinear(bg),
        sparkGlow: toLinear(neutral ? cool : accent),
        spec: toLinear(bg),
        room: toLinear(bg),
        dot: alt,
        fluid: [1.8, 0.54, 0.8, 0.04],
        lens: [1.35, 0.6, 0.06, 0.1],
        disp: [0.22, 0.1, 0.12, 0.4],
        tone: [1, neutral ? 0.82 : 1, 2.4, 1.4],
        glass: [0.5, 0.5, 1.6, 0.5],
        sparkP: [4, 13, 1.8, 0.2],
        caustic: 0.9,
        reflection: 0.35,
        bend: 0.06,
        dots: 0.26,
      };
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

const UNIFORMS = [
  "uScale",
  "uPx",
  "uCss",
  "uRadius",
  "uShape",
  "uShapeAmp",
  "uFlow",
  "uDriftA",
  "uDriftB",
  "uDriftC",
  "uBlob",
  "uCaustic",
  "uDots",
  "uLight",
  "uGlow",
  "uSpark",
  "uSparkLive",
  "uWave",
  "uColA",
  "uColB",
  "uColC",
  "uBody",
  "uBodyRim",
  "uCore",
  "uSparkGlow",
  "uSpec",
  "uRoom",
  "uDot",
  "uFluid",
  "uLens",
  "uDisp",
  "uTone",
  "uGlass",
  "uSparkP",
] as const;

/** Mount the orb canvas in `host` and run it; returns the cleanup. Does nothing (CSS fallback) without WebGL. */
function startOrb(host: HTMLElement): () => void {
  // A fresh canvas per mount: a canvas whose context was lost on unmount can't hand out a new one (StrictMode remounts).
  const canvas = document.createElement("canvas");
  canvas.className = "hero-mark-canvas";
  // Transparent and premultiplied: the shader writes premultiplied colour, so the anti-aliased outline, the bloom and
  // the dots composite cleanly over light and dark backgrounds.
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!gl || !probe) return () => {};
  probe.canvas.width = probe.canvas.height = 1;

  // Small devices get fewer octaves and wavelength samples, and a lower pixel density.
  const lite = (navigator.hardwareConcurrency || 8) <= 4 || window.matchMedia(MOBILE_QUERY).matches;
  const detail = lite ? DETAIL.lite : DETAIL.full;
  const maxDpr = lite ? LITE_DPR : MAX_DPR;

  let uniforms: Partial<Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>> = {};
  let palette: Palette | null = null;
  let lost = false;

  const init = (): boolean => {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment(detail.octaves, detail.samples));
    const program = gl.createProgram();
    if (!vs || !fs || !program) return false;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle that covers the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]));
    // Constant for the program's life: the wavelength weights and the spark's place and unit.
    gl.uniform3fv(uniforms.uWave!, waves(detail.samples));
    gl.uniform3f(uniforms.uSpark!, -SPARK_UNIT, SPARK_UNIT, SPARK_UNIT);
    return true;
  };

  // The canvas is larger than the orb (CSS bleeds it past the host on every side) so the bloom and the dots have room;
  // the shader works in orb radii, so it needs the ratio and the size of one device pixel and one CSS pixel in those units.
  let scale = 1;
  let pixel = 0.02;
  let cssPixel = 0.04;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const cssWidth = canvas.clientWidth || host.clientWidth;
    const cssHeight = canvas.clientHeight || host.clientHeight;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    scale = host.clientWidth > 0 ? cssWidth / host.clientWidth : 1;
    pixel = (2 * scale) / width;
    cssPixel = (2 * scale) / Math.max(1, cssWidth);
    gl.viewport(0, 0, width, height);
  };

  // Clocks, in seconds (double precision; only wrapped phases and positions reach the GPU). `flow` runs faster on hover.
  let flow = STILL_FLOW;
  let breath = STILL_BREATH;
  let boost = 0;
  let leanX = 0;
  let leanY = 0;
  let hovering = false;
  let pointerX = 0;
  let pointerY = 0;

  const phase = (rate: number, offset = 0) => (flow * rate + offset) % TAU;
  const drift = (i: number): Vec2 => {
    const d = DRIFTS[i];
    const angle = phase(d.rate, d.phase);
    return [d.centre[0] + d.radius * Math.cos(angle), d.centre[1] + d.radius * Math.sin(angle)];
  };
  const draw = () => {
    if (lost || !palette) return;
    const pulse = Math.sin(((breath % BREATH_SECONDS) / BREATH_SECONDS) * TAU);
    const glow = 0.9 + 0.1 * pulse + 0.12 * boost;
    const shape = 1 + HOVER_SHAPE * boost;
    const turn = phase(TURN_RATE);
    // The swirl swings one way and back (two incommensurate sines), never winding up.
    const swirl = SWIRL * (0.75 * Math.sin(flow * 0.061 + 0.6) + 0.25 * Math.sin(flow * 0.137 + 2.0));
    const shapeAmps = SHAPE_AMPS.map((a, i) => a * shape * (0.7 + 0.3 * Math.sin(flow * SHAPE_SWELL[i] + i * 1.7)));
    const shapePhases = [phase(SHAPE_RATES[0], 0.3), phase(SHAPE_RATES[1], 2.1), phase(SHAPE_RATES[2], 4.0), phase(SHAPE_RATES[3], 1.2)];
    gl.uniform1f(uniforms.uScale!, scale);
    gl.uniform1f(uniforms.uPx!, pixel);
    gl.uniform1f(uniforms.uCss!, cssPixel);
    gl.uniform1f(uniforms.uRadius!, 0.955 + 0.008 * pulse);
    gl.uniform4fv(uniforms.uShape!, shapePhases);
    gl.uniform4fv(uniforms.uShapeAmp!, shapeAmps);
    gl.uniform4f(uniforms.uFlow!, Math.cos(turn), Math.sin(turn), swirl, LENS + LENS_BREATH * pulse + HOVER_LENS * boost);
    gl.uniform4fv(uniforms.uDriftA!, [...drift(0), ...drift(1)]);
    gl.uniform4fv(uniforms.uDriftB!, [...drift(2), ...drift(3)]);
    // The window's reflection slides with the drop's lean and stretch (its first two outline terms).
    const sway: Vec2 = [
      -2.2 * shapeAmps[0] * Math.cos(shapePhases[0]) - 1.2 * shapeAmps[1] * Math.cos(shapePhases[1]),
      -2.2 * shapeAmps[0] * Math.sin(shapePhases[0]) - 1.2 * shapeAmps[1] * Math.sin(shapePhases[1]),
    ];
    gl.uniform4fv(uniforms.uDriftC!, [...drift(4), ...sway]);
    // The thick spot wanders round the middle (passing over the spark now and then), swelling and fading.
    const blobAngle = flow * 0.11 + 1.0;
    const blobRadius = 0.3 + 0.18 * Math.sin(flow * 0.077 + 0.5);
    gl.uniform4f(
      uniforms.uBlob!,
      Math.cos(blobAngle) * blobRadius,
      Math.sin(blobAngle) * blobRadius,
      0.18 + 0.07 * Math.sin(flow * 0.05 + 1.3) + 0.06 * boost,
      0.42,
    );
    // The caustic pools at the lower inside, opposite the key light, swaying a little with the lean.
    const causticAngle = -1.75 + 0.25 * Math.sin(flow * 0.083) - 0.4 * leanX;
    gl.uniform4f(uniforms.uCaustic!, causticAngle, 2.6, palette.caustic, 0.9 + 0.012 * pulse);
    // The dot rings turn (two directions) and twinkle; each phase is wrapped here.
    gl.uniform4f(uniforms.uDots!, phase(0.04), phase(0.9), palette.dots, phase(0.03));
    gl.uniform2f(uniforms.uLight!, leanX, leanY);
    gl.uniform1f(uniforms.uGlow!, glow);
    // The spark breathes with the orb and bends in the flow; its reflection slides round the lower left of the rim
    // (and away from the pointer), brightening and fading.
    gl.uniform4f(
      uniforms.uSparkLive!,
      1 + 0.035 * pulse,
      palette.bend,
      (-2.2 + 0.5 * Math.sin(flow * 0.07) - leanX + TAU) % TAU,
      palette.reflection * (0.75 + 0.25 * Math.sin(flow * 0.19)),
    );
    gl.uniform3fv(uniforms.uColA!, palette.colA);
    gl.uniform3fv(uniforms.uColB!, palette.colB);
    gl.uniform3fv(uniforms.uColC!, palette.colC);
    gl.uniform3fv(uniforms.uBody!, palette.body);
    gl.uniform3fv(uniforms.uBodyRim!, palette.bodyRim);
    gl.uniform3fv(uniforms.uCore!, palette.core);
    gl.uniform3fv(uniforms.uSparkGlow!, palette.sparkGlow);
    gl.uniform3fv(uniforms.uSpec!, palette.spec);
    gl.uniform3fv(uniforms.uRoom!, palette.room);
    gl.uniform3fv(uniforms.uDot!, palette.dot);
    gl.uniform4fv(uniforms.uFluid!, [palette.fluid[0] * glow, palette.fluid[1], palette.fluid[2], palette.fluid[3]]);
    gl.uniform4fv(uniforms.uLens!, palette.lens);
    gl.uniform4fv(uniforms.uDisp!, palette.disp);
    gl.uniform4fv(uniforms.uTone!, palette.tone);
    gl.uniform4fv(uniforms.uGlass!, palette.glass);
    gl.uniform4fv(uniforms.uSparkP!, palette.sparkP);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let onScreen = true;
  let raf = 0;
  let last = 0;
  let sinceDraw = 0;

  const frame = (now: number) => {
    raf = 0;
    if (!shouldRun()) return;
    // Clamp the step so a stalled tab resumes where it left off rather than jumping ahead.
    const step = last ? Math.min(now - last, 100) : 0;
    last = now;
    sinceDraw += step;
    if (sinceDraw >= FRAME_MS) {
      const seconds = sinceDraw / 1000;
      sinceDraw = 0;
      // Ease hover in and out (about a third of a second), so nothing snaps.
      const k = 1 - Math.exp(-seconds * 3);
      boost = approach(boost, hovering ? 1 : 0, k);
      leanX = approach(leanX, hovering ? pointerX * LEAN : 0, k);
      leanY = approach(leanY, hovering ? pointerY * LEAN : 0, k);
      flow += seconds * (1 + HOVER_BOOST * boost);
      breath += seconds;
      draw();
    }
    raf = requestAnimationFrame(frame);
  };
  const shouldRun = () => !lost && onScreen && !document.hidden && !reducedMotion.matches;
  const update = () => {
    if (shouldRun()) {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const recolor = () => {
    palette = readPalette(host, probe);
    draw();
  };

  palette = init() ? readPalette(host, probe) : null;
  if (!palette) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return () => {};
  }
  host.prepend(canvas);
  resize();
  draw();
  // Fades the CSS fallback (gradients and SVG spark) out as the canvas fades in.
  host.setAttribute("data-live", "");
  update();

  const resizeObserver = new ResizeObserver(() => {
    resize();
    draw();
  });
  resizeObserver.observe(host);
  const visibility = new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
    update();
  });
  visibility.observe(host);
  // Theme and accent are attributes on <html> (utils/theme.ts); re-read the tokens whenever they change.
  const themeObserver = new MutationObserver(recolor);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
  document.addEventListener("visibilitychange", update);
  reducedMotion.addEventListener("change", update);

  // Hover: the pointer's position over the orb, -1…1 with y up. Only read by the running loop.
  const onPointerMove = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    hovering = true;
    pointerX = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    pointerY = Math.max(-1, Math.min(1, 1 - ((event.clientY - rect.top) / rect.height) * 2));
  };
  const onPointerLeave = () => {
    hovering = false;
  };
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerleave", onPointerLeave);

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    update();
    canvas.hidden = true;
    host.removeAttribute("data-live");
  };
  const onRestored = () => {
    lost = false;
    if (!init()) return;
    canvas.hidden = false;
    resize();
    recolor();
    host.setAttribute("data-live", "");
    update();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lost = true;
    resizeObserver.disconnect();
    visibility.disconnect();
    themeObserver.disconnect();
    document.removeEventListener("visibilitychange", update);
    reducedMotion.removeEventListener("change", update);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
    host.removeAttribute("data-live");
  };
}
