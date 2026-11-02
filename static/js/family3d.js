/* Task families (#families): click a reference on the coverage map and the viewer plays that
   kinematic reference. Each [data-family3d] viewer reads its folder in static/family3d/
   (website/tools/export_family3d.py, export_family3d_blend.py): family.json (references,
   their pixels on the map image, table), int16 motion per reference, object.glb, and the
   shared robot.glb and skeleton.json. The page runs forward kinematics on the skeleton.
   Needs http(s); opened from disk, the fallback video stays in place. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const BASE = new URL('../family3d/', import.meta.url);
const SELECT = '#2a78d6';
const HOLD_END = 1.2;   // seconds on the last frame before the loop restarts
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const gltf = new GLTFLoader();
const once = new Map();
const cached = (key, make) => (once.has(key) ? once.get(key) : once.set(key, make()).get(key));
const json = url => fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.json(); });
const glb = url => gltf.loadAsync(url.href || url);

/* ---------------- skeleton ---------------- */
function makeSkeleton(spec) {
  return spec.bodies.map(b => ({
    name: b.name, parent: b.parent,
    pos: new THREE.Vector3(...b.pos),
    quat: new THREE.Quaternion(b.quat[1], b.quat[2], b.quat[3], b.quat[0]),
    joint: b.joint ?? -1,
    axis: b.axis ? new THREE.Vector3(...b.axis).normalize() : null,
    anchor: new THREE.Vector3(...(b.anchor || [0, 0, 0])),
  }));
}

const _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _v = new THREE.Vector3(), _a = new THREE.Vector3();
// world poses into nodes[i].position / quaternion (nodes sit directly under the scene root)
function forward(skel, nodes, rootPos, rootQuat, q) {
  skel.forEach((b, i) => {
    const n = nodes[i];
    if (b.parent < 0) { n.position.copy(rootPos); n.quaternion.copy(rootQuat); return; }
    const p = nodes[b.parent];
    n.quaternion.copy(p.quaternion).multiply(b.quat);
    n.position.copy(b.pos).applyQuaternion(p.quaternion).add(p.position);
    if (b.joint >= 0) {
      _r.setFromAxisAngle(b.axis, q[b.joint]);
      _a.copy(b.anchor).applyQuaternion(_r);
      _v.copy(b.anchor).sub(_a).applyQuaternion(n.quaternion);
      n.position.add(_v);
      n.quaternion.multiply(_r);
    }
  });
}

/* ---------------- one family viewer ---------------- */
class Viewer {
  constructor(host, map) {
    this.host = host; this.map = map;
    this.dir = new URL(host.dataset.family3d.replace(/\/?$/, '/'), document.baseURI);
    this.label = host.querySelector('[data-f3d-label]');
    this.playBtn = host.querySelector('[data-f3d-play]');
    this.scrub = host.querySelector('[data-f3d-scrub]');
    this.motions = new Map();
    this.t = 0; this.playing = !reduceMotion; this.visible = false;
  }

  async init() {
    const [skel, fam, robot, object] = await Promise.all([
      cached('skeleton', () => json(new URL('skeleton.json', BASE))),
      json(new URL('family.json', this.dir)),
      cached('robot', () => glb(new URL('robot.glb', BASE))),
      glb(new URL('object.glb', this.dir)),
    ]);
    this.fam = fam;
    this.skel = cached('skel', () => makeSkeleton(skel));
    this.scene3d(robot, object);
    this.mapLayer();
    await this.select(fam.source);
    this.host.classList.add('f3d-ready');
    this.host.closest('.pair')?.classList.add('f3d-on');
    this.host.querySelectorAll('video').forEach(v => { v.pause(); v.remove(); });
    new ResizeObserver(() => this.resize()).observe(this.host);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible) { this.draw(); this.loop(); } }, { threshold: 0.05 }).observe(this.host);
    this.resize();
  }

  scene3d(robotGltf, objectGltf) {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.domElement.className = 'f3d-canvas';
    this.host.prepend(r.domElement);

    const scene = this.scene = new THREE.Scene();
    scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.85;
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc4c9cf, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(1.6, -1.2, 3.4); sun.target.position.set(0.4, 0, 0.7);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 5; sun.shadow.bias = -0.0005;
    Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 8 });
    scene.add(sun, sun.target);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: 0.1 }));
    floor.receiveShadow = true; scene.add(floor);
    this.table();

    // robot: one node per reference body, already in the body frame
    const robot = robotGltf.scene.clone(true);
    this.nodes = this.skel.map(b => {
      const n = robot.getObjectByName(b.name);
      if (!n) throw new Error('robot.glb lacks ' + b.name);
      return n;
    });
    robot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(robot);
    this.object = objectGltf.scene;
    this.object.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(this.object);

    // camera of the family videos (render_t3_refs.py): orthographic, 1.62 m wide
    this.target = new THREE.Vector3(0.32, -0.12, 0.98);
    const cam = this.camera = new THREE.OrthographicCamera(-0.81, 0.81, 0.5, -0.5, 0.1, 30);
    cam.up.set(0, 0, 1);
    cam.position.copy(this.target).add(new THREE.Vector3(2.6, -4.2, 4.2).normalize().multiplyScalar(7));
    const c = this.controls = new OrbitControls(cam, r.domElement);
    Object.assign(c, { enableDamping: false, enablePan: false, minZoom: 0.7, maxZoom: 3, rotateSpeed: 0.7 });
    c.target.copy(this.target);
    c.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };   // one finger keeps scrolling the page
    r.domElement.style.touchAction = 'pan-y';
    c.addEventListener('change', () => this.draw());
    c.update();
  }

  table() {
    const { center, half } = this.fam.table, top = this.fam.table_top;
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.85 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * half[0], 2 * half[1], 2 * half[2]), mat);
    slab.position.set(...center); slab.receiveShadow = true; slab.castShadow = true;
    this.scene.add(slab);
    const legH = top - 2 * half[2], legMat = new THREE.MeshStandardMaterial({ color: 0xaeb5bd, metalness: 0.4, roughness: 0.45 });
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.028, legH), legMat);
      leg.position.set(center[0] + sx * (half[0] - 0.04), center[1] + sy * (half[1] - 0.04), legH / 2);
      leg.castShadow = true; this.scene.add(leg);
    }
    // every reference's object start as a dot on the tabletop; the selected one gets a ring
    const refs = this.fam.refs;
    const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(0.0045, 14), new THREE.MeshBasicMaterial({ color: 0x5b636d }), refs.length);
    const m = new THREE.Matrix4();
    refs.forEach((ref, i) => dots.setMatrixAt(i, m.makeTranslation(ref.xy[0], ref.xy[1], top + 0.0006)));
    this.scene.add(dots);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.006, 10, 48), new THREE.MeshBasicMaterial({ color: SELECT }));
    this.scene.add(this.ring);
  }

  /* ---------- the coverage map ---------- */
  mapLayer() {
    if (!this.map) return;
    const [W, H] = this.fam.image.size, refs = this.fam.refs;
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'f3d-svg', tabindex: 0, role: 'application',
      'aria-label': `Reference map: click a reference, or use the arrow keys, to play it at the left` }, this.map);
    this.hover = el('circle', { r: 12, class: 'f3d-hover' }, svg);
    this.mark = el('g', {}, svg);
    el('circle', { r: 13, class: 'f3d-halo' }, this.mark);
    el('circle', { r: 13, class: 'f3d-sel' }, this.mark);
    // reach = 1.6 x the median spacing between neighbouring references
    const nn = refs.map((a, i) => Math.min(...refs.map((b, j) => (i === j ? Infinity : Math.hypot(a.px[0] - b.px[0], a.px[1] - b.px[1])))));
    const reach = 1.6 * nn.sort((a, b) => a - b)[nn.length >> 1];
    const pick = e => {
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      let best = -1, d = reach;
      refs.forEach((r, i) => { const di = Math.hypot(r.px[0] - p.x, r.px[1] - p.y); if (di < d) { d = di; best = i; } });
      return best;
    };
    svg.addEventListener('pointermove', e => {
      const i = pick(e);
      svg.classList.toggle('near', i >= 0);
      this.hover.style.display = i >= 0 && i !== this.index ? '' : 'none';
      if (i >= 0) { this.hover.setAttribute('cx', refs[i].px[0]); this.hover.setAttribute('cy', refs[i].px[1]); }
    });
    svg.addEventListener('pointerleave', () => { this.hover.style.display = 'none'; });
    svg.addEventListener('click', e => { const i = pick(e); if (i >= 0) this.select(i, true); });
    svg.addEventListener('keydown', e => {
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir) return;
      e.preventDefault();
      const a = refs[this.index].px;
      let best = -1, score = Infinity;
      refs.forEach((r, i) => {
        const dx = r.px[0] - a[0], dy = r.px[1] - a[1], along = dx * dir[0] + dy * dir[1];
        if (i === this.index || along <= 0) return;
        const s = along + 2.5 * Math.abs(dx * dir[1] - dy * dir[0]);
        if (s < score) { score = s; best = i; }
      });
      if (best >= 0) this.select(best, true);
    });
    this.hover.style.display = 'none';
    // rings keep their on-screen size whatever the map's display width
    new ResizeObserver(() => {
      const k = W / (svg.clientWidth || W);
      this.hover.setAttribute('r', 7 * k);
      this.mark.querySelectorAll('circle').forEach(c => c.setAttribute('r', 8 * k));
    }).observe(svg);
  }

  async motion(i) {
    if (!this.motions.has(i)) {
      this.motions.set(i, fetch(new URL(`${String(i).padStart(4, '0')}.bin`, this.dir))
        .then(r => { if (!r.ok) throw new Error('motion ' + i); return r.arrayBuffer(); })
        .then(b => new Int16Array(b)));
    }
    return this.motions.get(i);
  }

  async select(i, user) {
    this.index = i;
    const ref = this.fam.refs[i];
    if (this.mark) this.mark.setAttribute('transform', `translate(${ref.px[0]} ${ref.px[1]})`);
    if (this.hover) this.hover.style.display = 'none';
    this.host.classList.add('f3d-loading');
    const data = await this.motion(i);
    if (this.index !== i) return;   // a later click won
    this.host.classList.remove('f3d-loading');
    this.data = data; this.frames = ref.frames;
    this.duration = (this.frames - 1) / this.fam.fps;
    this.ring.position.set(ref.xy[0], ref.xy[1], this.fam.table_top + 0.002);
    const fmt = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
    if (this.label) this.label.textContent = `(${fmt(ref.xy[0])}, ${fmt(ref.xy[1])}) m`;
    this.t = 0;
    if (user && !reduceMotion) this.playing = true;
    if (!this.playing && reduceMotion) this.t = this.duration * 0.6;   // a held pose instead of motion
    this.syncButton();
    this.pose();
    this.loop();
  }

  // pose at this.t, interpolated between the 25 Hz frames
  pose() {
    const { pos, angle, quat } = this.fam.scale, D = this.data, N = 49;
    const f = Math.min(this.t * this.fam.fps, this.frames - 1), i = Math.floor(f), j = Math.min(i + 1, this.frames - 1), u = f - i;
    const at = (k, s) => (D[i * N + k] + (D[j * N + k] - D[i * N + k]) * u) / s;
    const q4 = (k, out) => {
      const a = new THREE.Quaternion(D[i * N + k + 1], D[i * N + k + 2], D[i * N + k + 3], D[i * N + k]);
      const b = new THREE.Quaternion(D[j * N + k + 1], D[j * N + k + 2], D[j * N + k + 3], D[j * N + k]);
      return out.slerpQuaternions(a.normalize(), b.normalize(), u);
    };
    const q = new Float32Array(35);
    for (let k = 0; k < 35; k++) q[k] = at(7 + k, angle);
    forward(this.skel, this.nodes, new THREE.Vector3(at(0, pos), at(1, pos), at(2, pos)), q4(3, _q), q);
    this.object.position.set(at(42, pos), at(43, pos), at(44, pos));
    q4(45, this.object.quaternion);
    if (this.scrub && document.activeElement !== this.scrub) this.scrub.value = Math.round(1000 * this.t / this.duration);
    this.draw();
  }

  loop() {
    if (this.raf || !this.visible || !this.data) return;
    let last = performance.now();
    const tick = now => {
      this.raf = 0;
      if (!this.visible) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.playing) {
        this.t += dt;
        if (this.t > this.duration + HOLD_END) this.t = 0;
        this.pose();
      }
      if (this.playing) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  syncButton() {
    if (!this.playBtn) return;
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    this.playBtn.dataset.state = this.playing ? 'playing' : 'paused';
  }

  bindControls() {
    this.playBtn?.addEventListener('click', () => {
      this.playing = !this.playing;
      if (this.playing && this.t >= this.duration) this.t = 0;
      this.syncButton(); this.loop();
    });
    this.scrub?.addEventListener('input', () => {
      this.playing = false; this.syncButton();
      this.t = this.duration * this.scrub.value / 1000;
      this.pose();
    });
    this.syncButton();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const cam = this.camera, half = 0.81;
    Object.assign(cam, { left: -half, right: half, top: half * h / w, bottom: -half * h / w });
    cam.updateProjectionMatrix();
    this.draw();
  }

  draw() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }
}

/* ---------------- boot: each viewer when it first comes into view ---------------- */
document.querySelectorAll('[data-family3d]').forEach(host => {
  const map = host.closest('.pair')?.querySelector('.f3d-map');
  const start = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    start.disconnect();
    const v = new Viewer(host, map);
    v.init().then(() => v.bindControls()).catch(err => {
      console.warn('family viewer unavailable, keeping the video:', err);
      host.classList.remove('f3d-loading');
      host.classList.add('f3d-failed');
    });
  }, { rootMargin: '300px' });
  start.observe(host);
});
