/**
 * Wyzia scroll cube
 *
 * A full-width, scroll-scrubbed 3D sequence:
 *   1. A field of slabs rises from the bottom, outer slabs first, until a single
 *      silver cube stands in the centre.
 *   2. The whole structure rotates and the camera pushes in to one face of the
 *      cube to reveal a line of copy. This repeats for each item.
 *   3. The section then releases into normal page scroll.
 *
 * Everything is a pure function of scroll progress, so it plays in reverse too.
 *
 *   createWyziaCube('#wyzia-cube', { items: [{ text, icon }, ...] })
 *
 * Needs `three` (import map / bundler) and GSAP + ScrollTrigger (globals, or pass
 * `gsap` / `ScrollTrigger` in the options).
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ helpers */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rad = (d) => (d * Math.PI) / 180;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function merge(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    const v = extra[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

const DEFAULTS = {
  /** [{ text: string, icon: svgString }]. Up to 4, one per cube side. */
  items: [],
  gsap: null,
  ScrollTrigger: null,

  background: '#0d0d0f',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  faceColor: '#dedee2',
  faceInk: '#242830',
  cubeTint: 0xb2b2b8, // multiplies the face colour; lower = darker silver

  grid: 19, // odd number of slabs per side (slabs outside the view are skipped)
  tileSize: 2.34,
  tilePitch: 2.4,
  cubeSize: 1.3,
  stepHeight: 0.4, // each ring of slabs sits this much lower than the ring inside it
  isoPitch: 35.264, // true isometric camera elevation (degrees); the camera never moves
  seed: 11,
  damping: 7, // higher = tighter follow of the scroll position

  reveal: {
    fill: 0.62, // share of viewport height the cube fills while reading
    pullback: 0.5, // extra zoom-out between faces
  },
  /** Scroll distance of each beat, in viewport heights. */
  timeline: { rise: 1.8, settle: 0.45, turn: 0.85, hold: 0.85, lastHold: 0.9 },
};

/* ------------------------------------------------------------ canvas assets */

function svgToImage(svg, px, fill) {
  const src = svg
    .replace(/#1F2937/gi, fill)
    .replace(/width="16"/, `width="${px}"`)
    .replace(/height="16"/, `height="${px}"`);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
  });
}

function wrapLines(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function makeGrainCanvas(size, rng, lo, hi) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = lo + rng() * (hi - lo);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* --------------------------------------------------------------- component */

export function createWyziaCube(target, userOptions = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) throw new Error('[wyzia-cube] target element not found');
  const opts = merge(DEFAULTS, userOptions);
  const gsap = opts.gsap || window.gsap;
  const ScrollTrigger = opts.ScrollTrigger || window.ScrollTrigger;
  const items = opts.items.slice(0, 4);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- DOM ---- */
  el.classList.add('wyzia-cube');
  el.style.setProperty('--wyzia-cube-bg', opts.background);
  el.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'wyzia-cube__stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'wyzia-cube__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const vignette = document.createElement('div');
  vignette.className = 'wyzia-cube__vignette';
  const list = document.createElement('ul');
  list.className = 'wyzia-cube__copy';
  for (const it of items) {
    const li = document.createElement('li');
    const ic = document.createElement('span');
    ic.className = 'wyzia-cube__copy-icon';
    ic.setAttribute('aria-hidden', 'true');
    ic.innerHTML = it.icon.replace(/#1F2937/gi, 'currentColor');
    const tx = document.createElement('span');
    tx.textContent = it.text;
    li.append(ic, tx);
    list.append(li);
  }
  stage.append(canvas, vignette, list);
  el.append(stage);

  const T = opts.timeline;
  const segs = [{ kind: 'rise', len: T.rise }, { kind: 'hold', from: -1, len: T.settle }];
  items.forEach((_, k) => {
    segs.push({ kind: 'turn', from: k - 1, to: k, len: T.turn });
    segs.push({ kind: 'hold', from: k, len: k === items.length - 1 ? T.lastHold : T.hold });
  });
  const totalLen = segs.reduce((s, x) => s + x.len, 0);
  el.style.setProperty('--wyzia-cube-length', String(totalLen + 1));

  /* ---- renderer (falls back to a static, readable list if WebGL is missing) ---- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[wyzia-cube] WebGL unavailable, using static fallback', err);
    el.classList.add('wyzia-cube--static', 'wyzia-cube--no-webgl');
    return { destroy() {}, jumpTo() {}, refresh() {} };
  }
  const isSmall = Math.min(window.innerWidth, window.innerHeight) < 700;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isSmall ? 1.75 : 2));
  renderer.setClearColor(new THREE.Color(opts.background), 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background);
  // Isometric = orthographic camera at 45° azimuth. It is fixed; "zoom" only changes the frustum.
  const CAM_DIST = 80;
  scene.fog = new THREE.Fog(opts.background, CAM_DIST - 3, CAM_DIST + 24);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 300);
  const ISO_PITCH = rad(opts.isoPitch);
  const cubeCenterY = opts.cubeSize / 2;
  camera.position.set(
    Math.sin(rad(45)) * Math.cos(ISO_PITCH) * CAM_DIST,
    cubeCenterY + Math.sin(ISO_PITCH) * CAM_DIST,
    Math.cos(rad(45)) * Math.cos(ISO_PITCH) * CAM_DIST
  );
  camera.lookAt(0, cubeCenterY, 0);

  /* ---- lights ---- */
  scene.add(new THREE.HemisphereLight(0xa4a8b8, 0x08080a, 0.9));

  const spot = new THREE.SpotLight(0xffffff, 6, 0, 0.62, 1, 0);
  spot.position.set(-6, 15, 9);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(isSmall ? 1024 : 2048, isSmall ? 1024 : 2048);
  spot.shadow.camera.near = 6;
  spot.shadow.camera.far = 40;
  spot.shadow.bias = -0.0004;
  spot.shadow.normalBias = 0.03;
  scene.add(spot, spot.target);

  const fill = new THREE.DirectionalLight(0xdfe3f2, 0.55);
  fill.position.set(8, 6, 14);
  scene.add(fill);

  /* ---- structure ---- */
  const structure = new THREE.Group();
  scene.add(structure);

  const rng = mulberry32(opts.seed);
  const slabNoise = new THREE.CanvasTexture(makeGrainCanvas(256, rng, 215, 255));
  slabNoise.wrapS = slabNoise.wrapT = THREE.RepeatWrapping;
  slabNoise.colorSpace = THREE.SRGBColorSpace;
  slabNoise.anisotropy = maxAniso;

  const slabMat = new THREE.MeshStandardMaterial({ color: '#2d2d30', roughness: 0.92, metalness: 0, map: slabNoise });

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const SLAB_THICK = 1.6; // every slab is a plate of this thickness
  const tiles = [];
  const half = (opts.grid - 1) / 2;
  const TILE_WINDOW = 0.42; // share of the rise a single slab spends moving
  for (let i = -half; i <= half; i++) {
    for (let j = -half; j <= half; j++) {
      // Concentric square rings around the cube. Each ring is one step lower than the one inside it,
      // so height climbs steadily toward the centre (diamond-shaped terraces in the isometric view).
      const ring = Math.max(Math.abs(i), Math.abs(j));
      const top = -ring * opts.stepHeight;
      const mesh = new THREE.Mesh(unitBox, slabMat);
      mesh.scale.set(opts.tileSize, SLAB_THICK, opts.tileSize);
      const baseY = top - SLAB_THICK / 2;
      mesh.position.set(i * opts.tilePitch, baseY, j * opts.tilePitch);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = false;
      structure.add(mesh);
      const dist = Math.hypot(i, j) * opts.tilePitch;
      // rise order: ring first, euclidean distance as a tie-break so corners lead their ring
      const key = ring + (Math.hypot(i, j) - ring) * 0.5;
      tiles.push({ mesh, baseY, dist, key, jitter: rng() - 0.5, start: 0, inRange: true, center: ring === 0 });
    }
  }
  const centerTile = tiles.find((t) => t.center);

  /* ---- cube: silver, engraved copy on its sides ---- */
  const blankFace = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    return c;
  })();
  const grain = makeGrainCanvas(256, mulberry32(opts.seed + 5), 226, 255);
  {
    const g = blankFace.getContext('2d');
    g.fillStyle = opts.faceColor;
    g.fillRect(0, 0, 1024, 1024);
    g.globalAlpha = 0.28;
    g.globalCompositeOperation = 'multiply';
    g.drawImage(grain, 0, 0, 1024, 1024);
  }
  const mkTex = (canvasEl, srgb) => {
    const t = new THREE.CanvasTexture(canvasEl);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = maxAniso;
    return t;
  };
  const blankMat = new THREE.MeshStandardMaterial({ map: mkTex(blankFace, true), roughness: 0.5, metalness: 0.05, color: opts.cubeTint });
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z. Copy goes on +z, -x, -z, +x.
  const SIDE_SLOT = [4, 1, 5, 0];
  const cubeMats = Array.from({ length: 6 }, () => blankMat);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(opts.cubeSize, opts.cubeSize, opts.cubeSize), cubeMats);
  cube.castShadow = cube.receiveShadow = true;
  cube.visible = false;
  structure.add(cube);

  async function buildFaces() {
    try {
      await Promise.race([
        document.fonts.load(`400 40px ${opts.fontFamily}`).then(() => document.fonts.ready),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch (e) { /* font API optional */ }
    const S = 1024;
    const pad = 92;
    for (let k = 0; k < items.length; k++) {
      const { text, icon } = items[k];
      const [iconInk, iconBump] = await Promise.all([svgToImage(icon, 128, opts.faceInk), svgToImage(icon, 128, '#000000')]);

      const color = document.createElement('canvas');
      color.width = color.height = S;
      const g = color.getContext('2d');
      g.drawImage(blankFace, 0, 0);

      const bump = document.createElement('canvas');
      bump.width = bump.height = S;
      const b = bump.getContext('2d');
      b.fillStyle = '#fff';
      b.fillRect(0, 0, S, S);

      // fit copy
      let fs = 88;
      let lines;
      for (;;) {
        g.font = `400 ${fs}px ${opts.fontFamily}`;
        lines = wrapLines(g, text, S - pad * 2);
        if (lines.length <= 6 || fs <= 40) break;
        fs -= 2;
      }
      const lh = fs * 1.2;
      const firstBaseline = S - pad - (lines.length - 1) * lh - fs * 0.18;

      for (const [ctx, ink, hi] of [[g, opts.faceInk, true], [b, '#000', false]]) {
        ctx.font = `400 ${fs}px ${opts.fontFamily}`;
        ctx.textBaseline = 'alphabetic';
        if (ctx === b) ctx.filter = 'blur(1.4px)';
        if (hi) {
          ctx.fillStyle = 'rgba(255,255,255,0.55)'; // lit lower lip of the engraving
          lines.forEach((ln, n) => ctx.fillText(ln, pad, firstBaseline + n * lh + 2));
          if (iconInk) ctx.drawImage(iconInk, pad, pad + 2, 128, 128);
        }
        ctx.fillStyle = ink;
        ctx.globalAlpha = hi ? 0.86 : 1;
        lines.forEach((ln, n) => ctx.fillText(ln, pad, firstBaseline + n * lh));
        const img = ctx === b ? iconBump : iconInk;
        if (img) ctx.drawImage(img, pad, pad, 128, 128);
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
      }

      const mat = new THREE.MeshStandardMaterial({
        map: mkTex(color, true),
        bumpMap: mkTex(bump, false),
        bumpScale: 2.2,
        roughness: 0.5,
        metalness: 0.05,
        color: opts.cubeTint,
      });
      cubeMats[SIDE_SLOT[k]] = mat;
    }
    cube.material = cubeMats.slice();
    needsRender = true;
  }
  buildFaces();

  /* ---- layout + poses ---- */
  let width = 1;
  let height = 1;
  let aspect = 1;
  let poses = [];
  let riseDepth = 40;

  function layout() {
    const r = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    aspect = width / height;
    renderer.setSize(width, height, false);

    // `v` below is the visible world height of the orthographic frustum (smaller = zoomed in).
    const halfW = lerp(4.6, 7.6, clamp((aspect - 0.5) / 1.0));
    const v0 = (halfW * 2) / aspect;
    const OVERSHOOT = 1.12; // the rise starts slightly zoomed out
    const sinP = Math.sin(ISO_PITCH);
    const cosP = Math.cos(ISO_PITCH);

    // Slabs farther out than any view can reach (including rotation) are never shown.
    const reachX = halfW * OVERSHOOT;
    const reachZ = (v0 / 2) * OVERSHOOT / sinP;
    const R = Math.hypot(reachX, reachZ) * 1.1 + opts.tileSize;
    let keyMax = 0;
    for (const t of tiles) {
      t.inRange = t.dist <= R;
      if (t.inRange) keyMax = Math.max(keyMax, t.key);
    }
    for (const t of tiles) {
      t.start = clamp((1 - t.key / keyMax) * (0.9 - TILE_WINDOW) + t.jitter * 0.04, 0, 1);
    }
    // enough drop that every slab starts below the bottom edge of the view
    riseDepth = (v0 * OVERSHOOT * 0.5 + R * sinP + 2) / cosP;

    // Reading size: a cube in true isometric is a hexagon 1.633 tall and 1.414 wide (in cube sides).
    const side = opts.cubeSize;
    const v1 = Math.max((1.633 * side) / opts.reveal.fill, (1.414 * side) / (0.74 * aspect));
    poses = [{ v: v0, rot: 0 }];
    // Each reveal turns the structure a quarter so the next side lands on the left face of the iso view.
    items.forEach((_, k) => poses.push({ v: v1, rot: k * (Math.PI / 2) }));
    lastRise = -1;
    needsRender = true;
  }

  /* ---- state as a pure function of progress ---- */
  function evaluate(p) {
    const t = clamp(p) * totalLen;
    let acc = 0;
    let seg = segs[segs.length - 1];
    let u = 1;
    for (const s of segs) {
      if (t <= acc + s.len) {
        seg = s;
        u = s.len ? clamp((t - acc) / s.len) : 1;
        break;
      }
      acc += s.len;
    }
    const ov = poses[0];
    if (seg.kind === 'rise') {
      const lead = 1 - easeOutCubic(u);
      return { rise: u, v: ov.v * (1 + 0.12 * lead), rot: ov.rot - 0.14 * lead };
    }
    if (seg.kind === 'hold') {
      const base = poses[seg.from + 1];
      return { rise: 1, v: base.v * (1 - 0.025 * Math.sin(Math.PI * u)), rot: base.rot };
    }
    const a = poses[seg.from + 1];
    const b = poses[seg.to + 1];
    const e = easeInOutCubic(u);
    let v = Math.exp(lerp(Math.log(a.v), Math.log(b.v), e));
    if (seg.from >= 0) v *= 1 + opts.reveal.pullback * Math.sin(Math.PI * u);
    return { rise: 1, v, rot: lerp(a.rot, b.rot, e) };
  }

  let lastRise = -1;
  function apply(s) {
    structure.rotation.y = s.rot;

    // zoom = frustum size; the cube stays dead centre because the camera always looks at it
    const halfH = s.v / 2;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.right = halfH * aspect;
    camera.left = -halfH * aspect;
    camera.updateProjectionMatrix();

    if (s.rise !== lastRise) {
      lastRise = s.rise;
      for (const t of tiles) {
        const e = easeOutCubic(clamp((s.rise - t.start) / TILE_WINDOW));
        t.mesh.visible = t.inRange && e > 0.0005;
        t.mesh.position.y = t.baseY - (1 - e) * riseDepth;
      }
      const eCenter = easeOutCubic(clamp((s.rise - centerTile.start) / TILE_WINDOW));
      const eCube = easeOutCubic(clamp((s.rise - 0.6) / 0.4));
      cube.visible = eCube > 0.0005;
      cube.position.y = cubeCenterY - (1 - eCube) * (opts.cubeSize + 0.04) - (1 - eCenter) * riseDepth;
    }
  }

  /* ---- loop: damped follow of scroll progress, render only when needed ---- */
  let goal = 0;
  let current = 0;
  let needsRender = true;
  let inView = true;
  let raf = 0;
  let prev = performance.now();
  let manual = false;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!inView) { prev = now; return; }
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    if (current !== goal) {
      current += (goal - current) * (1 - Math.exp(-dt * opts.damping));
      if (Math.abs(goal - current) < 0.00005) current = goal;
      needsRender = true;
    }
    if (needsRender) {
      needsRender = false;
      apply(evaluate(current));
      renderer.render(scene, camera);
    }
  }

  const io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) needsRender = true;
  }, { rootMargin: '150px 0px' });
  io.observe(el);

  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas);
  layout();

  /* ---- scroll wiring ---- */
  let st = null;
  const riseEndProgress = T.rise / totalLen;
  if (reducedMotion || !gsap || !ScrollTrigger) {
    // Static composition: finished cube, copy listed below as plain text.
    el.classList.add('wyzia-cube--static');
    goal = current = riseEndProgress;
    layout();
  } else {
    gsap.registerPlugin(ScrollTrigger);
    st = ScrollTrigger.create({
      trigger: el,
      start: 'top top',
      end: 'bottom bottom',
      onUpdate: (self) => { if (!manual) goal = self.progress; },
      onRefresh: (self) => { if (!manual) goal = self.progress; },
    });
    goal = current = st.progress;
  }
  raf = requestAnimationFrame(frame);

  return {
    /** Jump straight to a progress value (0..1), bypassing scroll. Handy for debugging. */
    jumpTo(p) {
      manual = p != null;
      if (manual) { goal = current = clamp(p); needsRender = true; } else if (st) goal = st.progress;
    },
    refresh() { layout(); st?.refresh(); },
    get totalLength() { return totalLen; },
    get _debug() { return { scene, camera, tiles, poses, current, aspect }; },
    destroy() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      st?.kill();
      renderer.dispose();
      el.innerHTML = '';
    },
  };
}
