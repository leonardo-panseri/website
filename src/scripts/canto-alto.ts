import * as THREE from "three";

/* ---------- small helpers ---------- */
function rng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeOutBack = (x: number, s = 1.70158) =>
  1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
function easeOutBounce(x: number) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x - 1.5 / d1) ** 2 + 0.75;
  if (x < 2.5 / d1) return n1 * (x - 2.25 / d1) ** 2 + 0.9375;
  return n1 * (x - 2.625 / d1) ** 2 + 0.984375;
}
function vary(hex: string, d: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + d)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
// Tiny canvas textures with nearest-neighbour filtering give the chunky pixel look.
function pixelTexture(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  if (g) draw(g, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const lambert = (
  color: THREE.ColorRepresentation,
  extra: THREE.MeshLambertMaterialParameters = {},
) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
// Smooth 2D value noise in [0, 1].
function valueNoise(seed: number) {
  const r = rng(seed);
  const table = Array.from({ length: 256 }, () => r());
  const at = (x: number, z: number) =>
    table[(Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) & 255];
  return (x: number, z: number) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = zf * zf * (3 - 2 * zf);
    const a = at(xi, zi);
    const b = at(xi + 1, zi);
    const c = at(xi, zi + 1);
    const d = at(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function pick<T>(list: T[], r: () => number) {
  return list[Math.floor(r() * list.length)];
}
// A thin cylinder spanning two points.
function strut(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  mat: THREE.Material,
) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 4),
    mat,
  );
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    b.clone().sub(a).normalize(),
  );
  return m;
}

type AnimKind = "drop" | "pop" | "growY" | "growX";
interface Anim {
  obj: THREE.Object3D;
  start: number;
  dur: number;
  kind: AnimKind;
  height?: number;
  overshoot?: number;
  basePos: THREE.Vector3;
  baseScale: THREE.Vector3;
}

/* ---------- terrain shape ----------
 * Canto Alto is the last hump of the ridge between the Brembo and Serio
 * valleys: a long wooded crest rising from Canto Basso to a small grassy summit
 * with a round viewing platform and a lattice cross. Woods come right up to the
 * platform on the north side; the south side is an open grassy slope with
 * limestone outcrops and a rocky trail. */
const S = 4;
const HALF = S / 2;
const BASE_Y = -1.3;
const GRID = 48; // terrain cells per side, also skirt texels per side
const PX = GRID / S; // texels per world unit
const PEAK = { x: 0.2, z: -0.15 };
const RIDGE = 0.55; // ridge heading, radians
const PLATEAU = 1.45;
const noise = valueNoise(7);
const fbm = (x: number, z: number) =>
  noise(x, z) * 0.6 +
  noise(x * 2.1 + 5.3, z * 2.1 - 1.7) * 0.3 +
  noise(x * 4.3 - 2, z * 4.3 + 8) * 0.1;

// Coordinates along (u) and across (v) the ridge, relative to the summit.
// Negative u runs down the crest towards Canto Basso; positive v is the wooded north side.
function ridgeCoords(x: number, z: number) {
  const dx = x - PEAK.x;
  const dz = z - PEAK.z;
  const c = Math.cos(RIDGE);
  const s = Math.sin(RIDGE);
  return { u: dx * c + dz * s, v: -dx * s + dz * c };
}
function fromRidge(u: number, v: number) {
  const c = Math.cos(RIDGE);
  const s = Math.sin(RIDGE);
  return { x: PEAK.x + u * c - v * s, z: PEAK.z + u * s + v * c };
}
// Rotation about y that turns local +x (or +z) to point along a ridge-space direction.
function ridgeDir(du: number, dv: number) {
  const c = Math.cos(RIDGE);
  const s = Math.sin(RIDGE);
  return { x: du * c - dv * s, z: du * s + dv * c };
}
const yawX = (du: number, dv: number) => {
  const d = ridgeDir(du, dv);
  return Math.atan2(-d.z, d.x);
};
const yawZ = (du: number, dv: number) => {
  const d = ridgeDir(du, dv);
  return Math.atan2(d.x, d.z);
};
// Where things stand on the summit, in ridge coordinates: the belvedere on the north
// edge, the signpost by the crest trail, and the cross (our flagpole) between them
// where the two trails meet.
const DECK = { u: 0.05, v: 0.13 };
const SIGN = { u: -0.56, v: 0.03 };
const MAST = { u: -0.32, v: -0.04 };

// The crest trail comes up from Canto Basso (v as a function of u) and finishes at
// the foot of the cross.
const pathV = (u: number) =>
  0.07 * Math.sin(u * 3.2) - 0.02 * u - 0.22 * clamp01(1 + u / 0.7);
const crestEnd = MAST.u - 0.09;
// Where the traced traverse trail sets off across the grass, below the summit.
const TRAVERSE_START = { u: -0.01, v: -0.42 };

function height(x: number, z: number) {
  const { u, v } = ridgeCoords(x, z);
  const sv = v > 0 ? 0.68 : 1.05;
  const su = u > 0 ? 1.0 : 1.9;
  const dome = Math.exp(-(u * u) / (su * su) - (v * v) / (sv * sv));
  let h = 1.65 * dome;
  h += 0.14 * Math.exp(-(v * v) / 0.35) * clamp01(1 + u / 3);
  const calm = clamp01(Math.hypot(u, v) / 0.7);
  h += (fbm(x * 1.4 + 3, z * 1.4 + 3) - 0.5) * 0.4 * (0.35 + dome) * calm;
  if (h > PLATEAU) h = PLATEAU + (h - PLATEAU) * 0.12;
  // A little shoulder of level ground carries the belvedere at the north edge.
  const dd = Math.hypot(u - DECK.u, v - DECK.v);
  const shoulder = clamp01((0.5 - dd) / 0.2);
  h += (PLATEAU + 0.03 - h) * shoulder * shoulder * (3 - 2 * shoulder);
  return Math.max(0.04, h + 0.06);
}

// The other trail leaves the foot of the cross and traverses the open grassy slope
// at an easy grade before dropping into the woods. It is traced across the terrain,
// each step picking the heading whose grade is closest to TRAIL_GRADE.
const TRAIL_GRADE = -0.3;
const traverse: { u: number; v: number }[] = [];
{
  const heightUV = (u: number, v: number) => {
    const p = fromRidge(u, v);
    return height(p.x, p.z);
  };
  const STEP = 0.03;
  let u = TRAVERSE_START.u;
  let v = TRAVERSE_START.v;
  let heading = Math.atan2(-1, 0.4);
  traverse.push({ u: crestEnd, v: pathV(crestEnd) }, { u, v });
  for (let i = 0; i < 200; i++) {
    const want = i < 4 ? Math.atan2(-1, 0.4) : Math.atan2(-0.75, 1);
    let best = heading;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let d = -0.2; d <= 0.2; d += 0.05) {
      const a = heading + d;
      const nu = u + Math.cos(a) * STEP;
      const nv = v + Math.sin(a) * STEP;
      // Stay on the grassy south side once clear of the summit.
      if (i > 4 && nv > -0.3) continue;
      const grade = (heightUV(nu, nv) - heightUV(u, v)) / STEP;
      let off = Math.abs(a - want) % (Math.PI * 2);
      if (off > Math.PI) off = Math.PI * 2 - off;
      const score = Math.abs(grade - TRAIL_GRADE) + 0.35 * off;
      if (score < bestScore) {
        bestScore = score;
        best = a;
      }
    }
    heading = best;
    u += Math.cos(heading) * STEP;
    v += Math.sin(heading) * STEP;
    const p = fromRidge(u, v);
    if (Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) break;
    traverse.push({ u, v });
    // Fade out once well inside the woods.
    if (height(p.x, p.z) < 0.5) break;
  }
}
function distToTraverse(u: number, v: number) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < traverse.length; i++) {
    const a = traverse[i - 1];
    const b = traverse[i];
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const t = clamp01(((u - a.u) * du + (v - a.v) * dv) / (du * du + dv * dv));
    best = Math.min(best, Math.hypot(u - a.u - du * t, v - a.v - dv * t));
  }
  return best;
}
const onTrail = (u: number, v: number, w: number) =>
  (u < crestEnd && u > -2.6 && Math.abs(v - pathV(u)) < w) ||
  distToTraverse(u, v) < w;
// The wedge of slope between the two trails, below the summit.
const betweenTrails = (u: number, v: number) =>
  v < pathV(u) - 0.1 && u < TRAVERSE_START.u + 0.06 && v > -1.1;

/* ---------- palettes ---------- */
const ROCK = ["#bdb8ab", "#aaa598", "#c9c5b9", "#9a9589"];
const GRASS = ["#a98b5b", "#9d7f50", "#b4976a", "#91744a"];
const FOREST = ["#6f5b45", "#7a654c", "#62503d", "#86704f"];
const PATH = ["#e0dbcc", "#d3cdbb"];
const CROWNS = ["#7d6a5f", "#8a766a", "#6f5d55", "#94806f", "#7a6f66"];

export function mountCantoAlto(root: HTMLElement) {
  const canvas = root.querySelector("canvas");
  if (!canvas) return;
  const hint = root.querySelector<HTMLElement>("[data-hint]");

  /* ---------- renderer, scene, camera ---------- */
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
    });
  } catch (e) {
    canvas.remove();
    const f = document.createElement("div");
    f.className = "fallback";
    f.textContent =
      "This needs WebGL to draw the 3D scene. Turn on hardware acceleration in your browser settings, then reload.";
    root.appendChild(f);
    throw e;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const camDir = new THREE.Vector3(0, 0.55, 1).normalize();
  const camTarget = new THREE.Vector3(0, 0.3, 0);

  const hemi = new THREE.HemisphereLight(0xdff1ff, 0x8a7f70, 1.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(5, 9, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -4,
    right: 4,
    top: 4,
    bottom: -4,
    near: 1,
    far: 25,
  });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const diorama = new THREE.Group();
  scene.add(diorama);

  /* ---------- entrance animation registry ---------- */
  const anims: Anim[] = [];
  function addAnim<T extends THREE.Object3D>(
    obj: T,
    start: number,
    dur: number,
    kind: AnimKind,
    opts: { height?: number; overshoot?: number } = {},
  ) {
    anims.push({
      obj,
      start,
      dur,
      kind,
      ...opts,
      basePos: obj.position.clone(),
      baseScale: obj.scale.clone(),
    });
    return obj;
  }
  function applyAnims(t: number) {
    for (const a of anims) {
      const p = (t - a.start) / a.dur;
      if (p <= 0) {
        a.obj.visible = false;
        continue;
      }
      a.obj.visible = true;
      const q = Math.min(p, 1);
      const o = a.obj;
      if (a.kind === "drop") {
        o.position.y = a.basePos.y + (1 - easeOutBounce(q)) * (a.height ?? 3.5);
      } else if (a.kind === "pop") {
        o.scale
          .copy(a.baseScale)
          .multiplyScalar(Math.max(0.001, easeOutBack(q, a.overshoot ?? 2)));
      } else if (a.kind === "growY") {
        o.scale.set(
          a.baseScale.x,
          a.baseScale.y * Math.max(0.001, easeOutBack(q, 1.2)),
          a.baseScale.z,
        );
      } else if (a.kind === "growX") {
        o.scale.set(
          a.baseScale.x * Math.max(0.001, easeOutBack(q, 1.6)),
          a.baseScale.y,
          a.baseScale.z,
        );
      }
    }
  }

  /* ---------- bedrock: layered limestone slabs ---------- */
  function rockSideTexture(base: string, seed: number, rows: number) {
    const r = rng(seed);
    return pixelTexture(GRID, rows, (g, w, h) => {
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < w * h * 0.35; i++) {
        const len = 2 + Math.floor(r() * 9);
        g.fillStyle = vary(base, (r() - 0.5) * 24);
        g.fillRect(Math.floor(r() * w), Math.floor(r() * h), len, 1);
      }
      for (let i = 0; i < 5; i++) {
        g.fillStyle = r() < 0.5 ? "#d9d5c9" : "#9d998d";
        g.fillRect(
          Math.floor(r() * w),
          Math.floor(r() * h),
          3 + Math.floor(r() * 7),
          1,
        );
      }
    });
  }
  const strata = ["#5d5a52", "#6b675e", "#7b776c", "#8b867a"];
  const strataH = -BASE_Y / strata.length;
  const bedrock = new THREE.Group();
  diorama.add(bedrock);
  strata.forEach((color, i) => {
    const rows = Math.max(1, Math.round(strataH * PX));
    const sides = [0, 1, 2, 3].map(
      (k) =>
        new THREE.MeshLambertMaterial({
          map: rockSideTexture(color, 10 * i + k + 1, rows),
        }),
    );
    const top = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(S, strataH, S), [
      sides[0],
      sides[1],
      top,
      top,
      sides[2],
      sides[3],
    ]);
    mesh.position.y = BASE_Y + strataH * (i + 0.5);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    bedrock.add(mesh);
  });
  addAnim(bedrock, 0, 0.9, "drop", { height: 3.5 });

  /* ---------- the mountain ---------- */
  const terrain = new THREE.Group();
  diorama.add(terrain);
  const step = S / GRID;
  const hs: number[] = [];
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      hs.push(height(-HALF + i * step, -HALF + j * step));
    }
  }
  const hAt = (i: number, j: number) => hs[j * (GRID + 1) + i];

  {
    const r = rng(11);
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const n = new THREE.Vector3();
    const tri = (pts: [number, number, number][]) => {
      va.set(...pts[0]);
      vb.set(...pts[1]);
      vc.set(...pts[2]);
      n.subVectors(vb, va).cross(vc.clone().sub(va)).normalize();
      const cx = (va.x + vb.x + vc.x) / 3;
      const cz = (va.z + vb.z + vc.z) / 3;
      const ch = (va.y + vb.y + vc.y) / 3;
      const { u, v } = ridgeCoords(cx, cz);
      const blotch = noise(cx * 3.1 + 11, cz * 3.1 - 4);
      // Open grass on the south slope; on the north side the woods reach the top.
      const grassLine =
        v > 0.1 ? 1.42 : 0.8 + (noise(cx * 2 - 7, cz * 2 + 2) - 0.5) * 0.45;
      let palette = FOREST;
      if (onTrail(u, v, 0.065) && ch > 0.2) {
        palette = PATH;
      } else if (betweenTrails(u, v) && ch > 0.55 && blotch > 0.62) {
        palette = ROCK;
      } else if (ch > grassLine) {
        palette = GRASS;
      }
      c.set(pick(palette, r));
      for (const p of pts) {
        pos.push(...p);
        col.push(c.r, c.g, c.b);
      }
    };
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const x0 = -HALF + i * step;
        const z0 = -HALF + j * step;
        const a: [number, number, number] = [x0, hAt(i, j), z0];
        const b: [number, number, number] = [x0 + step, hAt(i + 1, j), z0];
        const cc: [number, number, number] = [x0, hAt(i, j + 1), z0 + step];
        const d: [number, number, number] = [
          x0 + step,
          hAt(i + 1, j + 1),
          z0 + step,
        ];
        tri([a, cc, b]);
        tri([b, cc, d]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const surface = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    );
    surface.receiveShadow = true;
    surface.castShadow = true;
    terrain.add(surface);
  }

  // Skirts close the mountain off along the four cut edges of the diorama.
  // Each texture column knows its terrain height, so the soil band follows the profile.
  const edges: [number, number][][] = [
    Array.from({ length: GRID + 1 }, (_, i) => [i, GRID]),
    Array.from({ length: GRID + 1 }, (_, i) => [GRID, GRID - i]),
    Array.from({ length: GRID + 1 }, (_, i) => [GRID - i, 0]),
    Array.from({ length: GRID + 1 }, (_, i) => [0, i]),
  ];
  edges.forEach((edge, k) => {
    const tops = edge.map(([i, j]) => hAt(i, j));
    const rows = Math.ceil(Math.max(...tops) * PX) + 1;
    const r = rng(300 + k);
    const tex = pixelTexture(GRID, rows, (g, w, h) => {
      g.fillStyle = FOREST[0];
      g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        const top = (tops[x] + tops[x + 1]) / 2;
        const rock = Math.round(top * PX) - 2;
        for (let y = 0; y < rock; y++) {
          g.fillStyle = vary(
            "#958f82",
            (r() - 0.5) * 22 + (y % 3 === 0 ? -8 : 0),
          );
          g.fillRect(x, h - 1 - y, 1, 1);
        }
        g.fillStyle = top > 0.95 ? pick(GRASS, r) : pick(FOREST, r);
        g.fillRect(x, h - 1 - Math.max(0, rock) - 1, 1, 2);
      }
    });
    const pos: number[] = [];
    const uv: number[] = [];
    const vMax = rows / PX;
    for (let i = 0; i < GRID; i++) {
      const [i0, j0] = edge[i];
      const [i1, j1] = edge[i + 1];
      const x0 = -HALF + i0 * step;
      const z0 = -HALF + j0 * step;
      const x1 = -HALF + i1 * step;
      const z1 = -HALF + j1 * step;
      const t0 = tops[i];
      const t1 = tops[i + 1];
      pos.push(
        x0,
        0,
        z0,
        x1,
        0,
        z1,
        x1,
        t1,
        z1,
        x0,
        0,
        z0,
        x1,
        t1,
        z1,
        x0,
        t0,
        z0,
      );
      const u0 = i / GRID;
      const u1 = (i + 1) / GRID;
      uv.push(u0, 0, u1, 0, u1, t1 / vMax, u0, 0, u1, t1 / vMax, u0, t0 / vMax);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const skirt = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    skirt.receiveShadow = true;
    terrain.add(skirt);
  });
  // The mountain rises out of the bedrock once it has landed.
  addAnim(terrain, 0.85, 0.9, "growY");

  /* ---------- props ---------- */
  const castAll = (g: THREE.Object3D) =>
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && !o.userData.noShadow) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  function place<T extends THREE.Object3D>(
    obj: T,
    x: number,
    z: number,
    sink = 0,
  ) {
    obj.position.set(x, height(x, z) - sink, z);
    diorama.add(obj);
    return obj;
  }
  // Rifugio degli Alpini: just inside the woods, below the traverse trail.
  const hutAt =
    traverse.find((p) => {
      const q = fromRidge(p.u, p.v);
      return height(q.x, q.z) < 0.72;
    }) ?? traverse[traverse.length - 1];
  const hutSpot = fromRidge(hutAt.u, hutAt.v - 0.3);
  const hutFacing = yawZ(0, 1);
  // The belvedere sits on the north edge of the summit, the cross just south of it,
  // and the signpost on the platform side of the trail junction.
  const DECK_R = 0.27;
  const deckSpot = fromRidge(DECK.u, DECK.v);
  const mastSpot = fromRidge(MAST.u, MAST.v);
  const signSpot = fromRidge(SIGN.u, SIGN.v);

  // Bare beeches and hornbeams in their winter colours, with a few evergreens.
  const TREES = 150;
  const trunkGeo = new THREE.CylinderGeometry(0.022, 0.032, 0.26, 5);
  trunkGeo.translate(0, 0.13, 0);
  const crownGeo = new THREE.IcosahedronGeometry(0.15, 0);
  crownGeo.scale(1, 1.15, 1);
  crownGeo.translate(0, 0.33, 0);
  const pineGeo = new THREE.ConeGeometry(0.13, 0.42, 6);
  pineGeo.translate(0, 0.34, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, lambert(0x5b4636), TREES);
  const crowns = new THREE.InstancedMesh(crownGeo, lambert(0xffffff), TREES);
  const pines = new THREE.InstancedMesh(pineGeo, lambert(0x3c5443), TREES);
  interface TreeSpot {
    pos: THREE.Vector3;
    scale: number;
    rot: number;
    delay: number;
    pine: boolean;
  }
  const treeSpots: TreeSpot[] = [];
  {
    const r = rng(23);
    const c = new THREE.Color();
    let tries = 0;
    while (treeSpots.length < TREES && tries++ < 6000) {
      const x = (r() * 2 - 1) * (HALF - 0.12);
      const z = (r() * 2 - 1) * (HALF - 0.12);
      const h = height(x, z);
      const { u, v } = ridgeCoords(x, z);
      const slope =
        Math.hypot(
          height(x + 0.05, z) - height(x - 0.05, z),
          height(x, z + 0.05) - height(x, z - 0.05),
        ) / 0.1;
      if (slope > 2.4) continue;
      if (Math.hypot(u, v) < 0.5) continue;
      if (Math.hypot(x - deckSpot.x, z - deckSpot.z) < DECK_R + 0.1) continue;
      if (Math.hypot(x - signSpot.x, z - signSpot.z) < 0.12) continue;
      if (onTrail(u, v, 0.12)) continue;
      if (Math.hypot(x - hutSpot.x, z - hutSpot.z) < 0.32) continue;
      if (v < 0.1 && h > 0.85 && r() > 0.08) continue;
      if (treeSpots.some((t) => Math.hypot(t.pos.x - x, t.pos.z - z) < 0.12))
        continue;
      const pine = r() < 0.14;
      treeSpots.push({
        pos: new THREE.Vector3(x, h - 0.02, z),
        scale: (h > 0.85 ? 0.5 : 0.65) + r() * 0.35,
        rot: r() * Math.PI * 2,
        delay: 1.65 + (1 - clamp01(h / 1.1)) * 0.5 + r() * 0.8,
        pine,
      });
      c.set(pick(CROWNS, r)).multiplyScalar(0.9 + r() * 0.2);
      crowns.setColorAt(treeSpots.length - 1, c);
    }
  }
  for (const m of [trunks, crowns, pines]) {
    m.count = treeSpots.length;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    diorama.add(m);
  }
  const TREES_DONE = Math.max(...treeSpots.map((t) => t.delay)) + 0.6;
  const tm = new THREE.Matrix4();
  const tq = new THREE.Quaternion();
  const ts = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  function updateTrees(t: number) {
    treeSpots.forEach((spot, i) => {
      const k = Math.max(0, easeOutBack(clamp01((t - spot.delay) / 0.5), 2.2));
      tq.setFromAxisAngle(yAxis, spot.rot);
      ts.setScalar(Math.max(0.0001, spot.scale * k));
      tm.compose(spot.pos, tq, ts);
      trunks.setMatrixAt(i, tm);
      crowns.setMatrixAt(i, spot.pine ? hidden : tm);
      pines.setMatrixAt(i, spot.pine ? tm : hidden);
    });
    for (const m of [trunks, crowns, pines])
      m.instanceMatrix.needsUpdate = true;
  }

  // Summit flag: the lattice mast of the real cross, flying the tricolore instead of the arms.
  const mastGroup = place(new THREE.Group(), mastSpot.x, mastSpot.z, 0.01);
  mastGroup.rotation.y = -RIDGE;
  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.14, 0.22),
    lambert(0xa8a397),
  );
  plinth.position.y = 0;
  mastGroup.add(plinth);
  addAnim(plinth, 2.6, 0.35, "pop");
  const mast = new THREE.Group();
  mast.position.y = 0.07;
  mastGroup.add(mast);
  const MAST_H = 1.15;
  const steel = lambert(0xd3d7da);
  const corner = (k: number, y: number) => {
    const w = 0.08 + (0.028 - 0.08) * (y / MAST_H);
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    return new THREE.Vector3(Math.cos(a) * w, y, Math.sin(a) * w);
  };
  for (let k = 0; k < 4; k++) {
    mast.add(strut(corner(k, 0), corner(k, MAST_H), 0.009, steel));
  }
  const brace: THREE.Vector3[] = [];
  const LEVELS = 8;
  for (let l = 0; l < LEVELS; l++) {
    const y0 = (l / LEVELS) * MAST_H;
    const y1 = ((l + 1) / LEVELS) * MAST_H;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      brace.push(corner(k, y1), corner(k1, y1));
      brace.push(corner(k, l % 2 ? y0 : y1), corner(k1, l % 2 ? y1 : y0));
    }
  }
  for (let i = 0; i < brace.length; i += 2) {
    mast.add(strut(brace[i], brace[i + 1], 0.004, steel));
  }
  const POLE_H = 0.55;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.016, POLE_H, 6),
    steel,
  );
  pole.position.y = MAST_H + POLE_H / 2;
  mast.add(pole);
  castAll(mast);
  addAnim(mast, 2.8, 0.7, "growY");
  // Red obstruction light on top, blinking.
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
  const beacon = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.03, 0),
    beaconMat,
  );
  beacon.position.y = 0.07 + MAST_H + POLE_H + 0.02;
  mastGroup.add(beacon);
  addAnim(beacon, 3.4, 0.35, "pop");
  // Italian flag, 3:2, vertical green / white / red bands.
  const flagTex = pixelTexture(36, 24, (g) => {
    g.fillStyle = "#009246";
    g.fillRect(0, 0, 12, 24);
    g.fillStyle = "#f4f5f0";
    g.fillRect(12, 0, 12, 24);
    g.fillStyle = "#ce2b37";
    g.fillRect(24, 0, 12, 24);
  });
  const flagW = 0.5;
  const flagH = 0.33;
  const flagGeo = new THREE.PlaneGeometry(flagW, flagH, 14, 6);
  flagGeo.translate(flagW / 2, 0, 0);
  const flagRest = flagGeo.attributes.position.array.slice();
  const flag = new THREE.Mesh(
    flagGeo,
    new THREE.MeshLambertMaterial({ map: flagTex, side: THREE.DoubleSide }),
  );
  flag.position.set(0.015, 0.07 + MAST_H + POLE_H - flagH / 2 - 0.02, 0);
  flag.castShadow = true;
  mastGroup.add(flag);
  addAnim(flag, 3.5, 0.7, "growX");

  // Signpost at the junction, a CAI red-white-red arrow pointing down each trail.
  const sign = place(new THREE.Group(), signSpot.x, signSpot.z, 0.01);
  const signPost = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.012, 0.24, 5),
    lambert(0x6b4a33),
  );
  signPost.position.y = 0.12;
  sign.add(signPost);
  const BLADE_L = 0.13;
  const BLADE_H = 0.016;
  const caiTex = pixelTexture(6, 1, (g) => {
    g.fillStyle = "#d8262e";
    g.fillRect(0, 0, 6, 1);
    g.fillStyle = "#ffffff";
    g.fillRect(2, 0, 2, 1);
  });
  // Extrude UVs are shape coordinates; map the blade's length and height onto the texture.
  caiTex.repeat.set(1 / BLADE_L, 1 / (BLADE_H * 2));
  caiTex.offset.set(0, 0.5);
  const arrowShape = new THREE.Shape([
    new THREE.Vector2(0, -BLADE_H),
    new THREE.Vector2(BLADE_L - 0.025, -BLADE_H),
    new THREE.Vector2(BLADE_L, 0),
    new THREE.Vector2(BLADE_L - 0.025, BLADE_H),
    new THREE.Vector2(0, BLADE_H),
  ]);
  const bladeGeo = new THREE.ExtrudeGeometry(arrowShape, {
    depth: 0.008,
    bevelEnabled: false,
  });
  bladeGeo.translate(0, 0, -0.004);
  const bladeMats = [
    new THREE.MeshLambertMaterial({ map: caiTex }),
    lambert(0xd8262e),
  ];
  // Upper blade: along the crest towards Canto Basso. Lower blade: down the south slope.
  [
    { y: 0.21, du: -1, dv: 0 },
    { y: 0.16, du: 1, dv: -0.7 },
  ].forEach(({ y, du, dv }) => {
    const blade = new THREE.Mesh(bladeGeo, bladeMats);
    blade.position.y = y;
    blade.rotation.y = yawX(du, dv);
    sign.add(blade);
  });
  castAll(sign);
  addAnim(sign, 3.2, 0.4, "pop");

  // The round belvedere. Its slab reaches down to the lowest ground under the rim, so
  // it stands a little proud on the downhill side but sits on the hill all the way round.
  let deckLow = Number.POSITIVE_INFINITY;
  let deckHigh = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    for (const k of [0.5, 1]) {
      const g = height(
        deckSpot.x + Math.cos(a) * DECK_R * k,
        deckSpot.z + Math.sin(a) * DECK_R * k,
      );
      deckLow = Math.min(deckLow, g);
      deckHigh = Math.max(deckHigh, g);
    }
  }
  const deckY = deckHigh + 0.03;
  const deck = new THREE.Group();
  deck.position.set(deckSpot.x, deckY, deckSpot.z);
  // Railed towards the woods, open towards the summit.
  deck.rotation.y = yawZ(0, 1);
  diorama.add(deck);
  const concrete = lambert(0xbab5a9);
  const slabH = deckY - deckLow + 0.06;
  const slab = new THREE.Mesh(
    new THREE.CylinderGeometry(DECK_R, DECK_R, slabH, 18),
    concrete,
  );
  slab.position.y = 0.025 - slabH / 2;
  deck.add(slab);
  const railMat = lambert(0x8a6e4b);
  const RAIL_ARC = Math.PI * 1.45;
  // Railed all round except on the local -z side.
  const railStart = Math.PI * 0.5 - RAIL_ARC / 2;
  for (let i = 0; i <= 12; i++) {
    const a = railStart + (i / 12) * RAIL_ARC;
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.11, 0.012),
      railMat,
    );
    post.position.set(Math.cos(a) * 0.245, 0.08, Math.sin(a) * 0.245);
    deck.add(post);
  }
  const rail = new THREE.Mesh(
    new THREE.TorusGeometry(0.245, 0.008, 4, 28, RAIL_ARC),
    railMat,
  );
  rail.rotation.set(Math.PI / 2, 0, railStart);
  rail.position.y = 0.135;
  deck.add(rail);
  castAll(deck);
  addAnim(deck, 2.45, 0.5, "pop", { overshoot: 1.8 });

  // Hikers in bright jackets: two on the belvedere, one by the flag, one on each trail.
  const people: THREE.Group[] = [];
  function hiker(color: number) {
    const g = new THREE.Group();
    const legs = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, 0.05, 0.022),
      lambert(0x3b3f4a),
    );
    legs.position.y = 0.025;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.046, 0.055, 0.03),
      lambert(color),
    );
    body.position.y = 0.078;
    const pack = new THREE.Mesh(
      new THREE.BoxGeometry(0.034, 0.04, 0.018),
      lambert(0x4b5a3a),
    );
    pack.position.set(0, 0.08, -0.022);
    const head = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.017, 0),
      lambert(0xf0c8a0),
    );
    head.position.y = 0.122;
    g.add(legs, body, pack, head);
    g.scale.setScalar(0.8);
    castAll(g);
    return g;
  }
  const hikerSpots: [number, number, number, number][] = [
    [-0.03, 0.23, 0xe94b6a, 1.4],
    [0.15, 0.17, 0x2f7de1, 2.2],
    [-0.12, -0.3, 0xf2c230, -0.6],
    [-0.75, pathV(-0.75), 0x3aa76d, -RIDGE + Math.PI / 2],
    [traverse[24].u, traverse[24].v, 0xff8a2a, -RIDGE],
  ];
  hikerSpots.forEach(([u, v, color, rot], i) => {
    const p = fromRidge(u, v);
    const g = hiker(color);
    const onDeck = Math.hypot(p.x - deckSpot.x, p.z - deckSpot.z) < 0.25;
    g.position.set(p.x, onDeck ? deckY + 0.025 : height(p.x, p.z) - 0.005, p.z);
    g.rotation.y = rot;
    diorama.add(g);
    people.push(g);
    addAnim(g, 3.8 + i * 0.12, 0.6, "drop", { height: 1.2 });
  });

  // Rifugio degli Alpini, a little stone hut in the woods beside the south trail.
  const hut = new THREE.Group();
  {
    const r = rng(41);
    let ground = Number.POSITIVE_INFINITY;
    for (const [dx, dz] of [
      [-0.2, -0.16],
      [0.2, -0.16],
      [-0.2, 0.16],
      [0.2, 0.16],
      [0, 0],
    ]) {
      ground = Math.min(ground, height(hutSpot.x + dx, hutSpot.z + dz));
    }
    hut.position.set(hutSpot.x, ground, hutSpot.z);
    // Door faces up to the trail.
    hut.rotation.y = hutFacing;
    const stoneTex = pixelTexture(12, 6, (g, w, h) => {
      g.fillStyle = "#8f8a7f";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = (y % 2) * 1; x < w; x += 2) {
          g.fillStyle = vary("#a8a296", (r() - 0.5) * 30);
          g.fillRect(x, y, 1 + Math.round(r()), 1);
        }
      }
    });
    const foundation = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.3, 0.3),
      lambert(0x77736a),
    );
    foundation.position.y = -0.14;
    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.18, 0.26),
      new THREE.MeshLambertMaterial({ map: stoneTex }),
    );
    walls.position.y = 0.09;
    const roofShape = new THREE.Shape([
      new THREE.Vector2(-0.16, 0),
      new THREE.Vector2(0.16, 0),
      new THREE.Vector2(0, 0.13),
    ]);
    const roofGeo = new THREE.ExtrudeGeometry(roofShape, {
      depth: 0.42,
      bevelEnabled: false,
    });
    roofGeo.translate(0, 0, -0.21);
    roofGeo.rotateY(Math.PI / 2);
    const roof = new THREE.Mesh(roofGeo, lambert(0x6e3626));
    roof.position.y = 0.18;
    const chimney = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.12, 0.04),
      lambert(0x7d786e),
    );
    chimney.position.set(0.11, 0.28, 0.05);
    const door = new THREE.Mesh(
      new THREE.PlaneGeometry(0.06, 0.1),
      lambert(0x4a3526),
    );
    door.position.set(-0.08, 0.05, 0.131);
    hut.add(foundation, walls, roof, chimney, door);
    castAll(hut);
  }
  const windowMat = new THREE.MeshBasicMaterial({ color: 0x3a3a38 });
  const hutWindow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.06, 0.05),
    windowMat,
  );
  hutWindow.position.set(0.07, 0.1, 0.131);
  hut.add(hutWindow);
  diorama.add(hut);
  addAnim(hut, 2.2, 0.55, "pop", { overshoot: 1.8 });
  const chimneyTop = new THREE.Vector3(0.11, 0.35, 0.05);

  const smokeGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  const smoke = Array.from({ length: 14 }, () => {
    const m = new THREE.Mesh(
      smokeGeo,
      new THREE.MeshBasicMaterial({
        color: 0xb7bec2,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    m.visible = false;
    m.userData = { life: 0, max: 1, seed: 0 };
    hut.add(m);
    return m;
  });
  let smokeTimer = 0;
  let smokeIdx = 0;
  const SMOKE_ON = 2.9;

  /* ---------- drifting clouds (world space, do not spin) ---------- */
  const cloudMat = lambert(0xffffff, { transparent: true, opacity: 0.92 });
  const clouds = [
    { x: -3.5, y: 2.2, z: -3.2, s: 1 },
    { x: 1.8, y: 2.6, z: -3.8, s: 0.8 },
    { x: 5.2, y: 1.8, z: -2.6, s: 0.65 },
  ].map(({ x, y, z, s }, i) => {
    const r = rng(70 + i);
    const g = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const w = 0.35 + r() * 0.35;
      const puff = new THREE.Mesh(
        new THREE.BoxGeometry(w, w * 0.6, w * 0.8),
        cloudMat,
      );
      puff.position.set(
        (k - 2) * 0.25 + (r() - 0.5) * 0.1,
        r() * 0.12 - Math.abs(k - 2) * 0.05,
        (r() - 0.5) * 0.2,
      );
      g.add(puff);
    }
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    scene.add(g);
    return g;
  });

  /* ---------- theme ---------- */
  const darkMQ = matchMedia("(prefers-color-scheme: dark)");
  const DAY = {
    hemi: new THREE.Color(0xdff1ff),
    sun: new THREE.Color(0xfff1dc),
    window: new THREE.Color(0x3a3a38),
  };
  const NIGHT = {
    hemi: new THREE.Color(0x8fa8d8),
    sun: new THREE.Color(0xa9c2ff),
    window: new THREE.Color(0xffc35a),
  };
  // 0 = day, 1 = night; faded toward the target in the main loop.
  let nightMix = -1;
  let nightTarget = 0;
  function setNightMix(m: number) {
    nightMix = m;
    hemi.intensity = THREE.MathUtils.lerp(1.9, 0.55, m);
    hemi.color.lerpColors(DAY.hemi, NIGHT.hemi, m);
    sun.intensity = THREE.MathUtils.lerp(2.4, 0.7, m);
    sun.color.lerpColors(DAY.sun, NIGHT.sun, m);
    windowMat.color.lerpColors(DAY.window, NIGHT.window, m);
    cloudMat.opacity = THREE.MathUtils.lerp(0.92, 0.55, m);
  }
  function applyTheme() {
    const forced = document.documentElement.dataset.theme;
    nightTarget = (forced ? forced === "dark" : darkMQ.matches) ? 1 : 0;
    // Snap on first load; later changes fade in the main loop.
    if (nightMix < 0) setNightMix(nightTarget);
  }
  darkMQ.addEventListener("change", applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  applyTheme();

  /* ---------- sizing & pixel size ---------- */
  let pixelSize = Number(root.dataset.pixels) || 3;
  function fit() {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(
      pixelSize === 1 ? Math.min(window.devicePixelRatio, 2) : 1 / pixelSize,
    );
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const v = THREE.MathUtils.degToRad(camera.fov) / 2;
    const hz = Math.atan(Math.tan(v) * camera.aspect);
    const dist = Math.max(3.75 / Math.sin(v), 3.4 / Math.sin(hz));
    camera.position.copy(camDir).multiplyScalar(dist).add(camTarget);
    camera.lookAt(camTarget);
    camera.updateProjectionMatrix();
    canvas?.classList.toggle("smooth", pixelSize === 1);
  }
  new ResizeObserver(fit).observe(root);
  const pxButtons = root.querySelectorAll<HTMLButtonElement>("[data-px]");
  for (const btn of pxButtons) {
    btn.addEventListener("click", () => {
      pixelSize = Number(btn.dataset.px);
      for (const b of pxButtons)
        b.setAttribute("aria-pressed", String(b === btn));
      fit();
    });
  }
  fit();

  /* ---------- spin & drag ---------- */
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const AUTO_SPIN = reduceMotion ? 0.08 : 0.28;
  let spinVel = 0;
  let dragging = false;
  let lastX = 0;
  let lastT = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastT = performance.now();
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
    if (hint) hint.style.opacity = "0";
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const now = performance.now();
    const d = (e.clientX - lastX) * 0.01;
    diorama.rotation.y += d;
    spinVel = THREE.MathUtils.clamp(
      d / Math.max(0.016, (now - lastT) / 1000),
      -6,
      6,
    );
    lastX = e.clientX;
    lastT = now;
  });
  const endDrag = () => {
    dragging = false;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  /* ---------- intro control ---------- */
  let elapsed = 0;
  let introStart = 0;
  let treesSettled = false;
  function startIntro() {
    introStart = elapsed;
    spinVel = reduceMotion ? AUTO_SPIN : 2.6;
    diorama.rotation.y = -0.9;
    treesSettled = false;
    for (const s of smoke) s.visible = false;
    if (reduceMotion) introStart = elapsed - 10; // skip straight to the finished scene
  }
  root.querySelector("[data-replay]")?.addEventListener("click", startIntro);
  startIntro();

  /* ---------- main loop ---------- */
  const timer = new THREE.Timer();
  const THEME_FADE = 0.6; // seconds, matches the page's CSS transition
  const flagPos = flagGeo.attributes.position;
  function frame(time: number) {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.05);
    elapsed += dt;
    if (nightMix !== nightTarget) {
      const step = dt / THEME_FADE;
      setNightMix(
        nightTarget > nightMix
          ? Math.min(nightMix + step, nightTarget)
          : Math.max(nightMix - step, nightTarget),
      );
    }
    const t = elapsed - introStart;
    applyAnims(t);
    if (!treesSettled) {
      updateTrees(t);
      treesSettled = t > TREES_DONE;
    }

    if (!dragging) {
      const introBoost = reduceMotion
        ? 0
        : 2.3 * (1 - easeOutCubic(clamp01(t / 2.8)));
      spinVel += (AUTO_SPIN + introBoost - spinVel) * (1 - Math.exp(-dt * 2.2));
      diorama.rotation.y += spinVel * dt;
    }

    // waving flag
    for (let i = 0; i < flagPos.count; i++) {
      const ox = flagRest[i * 3];
      const oy = flagRest[i * 3 + 1];
      const k = ox / flagW;
      flagPos.setZ(
        i,
        (Math.sin(ox * 7 - elapsed * 5 + oy * 2) * 0.06 +
          Math.sin(ox * 13 - elapsed * 8) * 0.013) *
          k,
      );
      flagPos.setY(i, oy - k * k * 0.035);
    }
    flagPos.needsUpdate = true;
    flagGeo.computeVertexNormals();

    // blinking obstruction light
    const blink = Math.sin(elapsed * 3.2) > 0.2 ? 1 : 0.25;
    beaconMat.color.setRGB(blink, blink * 0.23, blink * 0.19);

    // hikers fidget a little
    people.forEach((p, i) => {
      if (t < 4.6) return;
      p.rotation.y = hikerSpots[i][3] + Math.sin(elapsed * 0.6 + i * 2) * 0.35;
    });

    // chimney smoke
    if (t > SMOKE_ON) {
      smokeTimer -= dt;
      if (smokeTimer <= 0) {
        smokeTimer = 0.3;
        const s = smoke[smokeIdx++ % smoke.length];
        s.visible = true;
        s.position.copy(chimneyTop);
        s.userData = {
          life: 0,
          max: 2.4 + Math.random(),
          seed: Math.random() * 10,
        };
      }
    }
    for (const s of smoke) {
      if (!s.visible) continue;
      const u = s.userData;
      u.life += dt;
      const k = u.life / u.max;
      if (k >= 1) {
        s.visible = false;
        continue;
      }
      s.position.y += dt * 0.32;
      s.position.x += Math.sin(u.life * 2.5 + u.seed) * dt * 0.08;
      s.position.z += Math.cos(u.life * 2 + u.seed) * dt * 0.06;
      s.scale.setScalar(1 + k * 1.6);
      (s.material as THREE.MeshBasicMaterial).opacity =
        0.5 * (1 - k) * Math.min(1, u.life * 4);
    }

    // clouds drift across the back
    clouds.forEach((c, i) => {
      c.position.x += dt * (0.1 + i * 0.03);
      if (c.position.x > 7) c.position.x = -7;
    });

    renderer.render(scene, camera);
  }

  // Only animate while the diorama is on screen.
  new IntersectionObserver(([entry]) => {
    renderer.setAnimationLoop(entry.isIntersecting ? frame : null);
  }).observe(root);
}
