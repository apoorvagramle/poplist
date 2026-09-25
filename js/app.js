import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import qrcode from './vendor/qrcode.mjs';
import { firebaseConfig } from '../firebase-config.js';

/* =========================================================
   Constants
   ========================================================= */
const PLATFORMS = ['Netflix', 'Prime Video', 'JioHotstar', 'SonyLIV', 'ZEE5', 'Apple TV+', 'YouTube', 'Theatre'];
const GENRES = ['Action', 'Comedy', 'Drama', 'Thriller', 'Romance', 'Horror', 'Sci-fi', 'Fantasy', 'Crime', 'Mystery', 'Animation', 'Documentary', 'Family', 'Feel-good'];
const DURATIONS = [
  { id: 'short',  label: 'Short',  movie: 'under 1h 30m', series: '1 season' },
  { id: 'medium', label: 'Medium', movie: '1h 30m to 2h 30m', series: '2 to 3 seasons' },
  { id: 'long',   label: 'Long',   movie: 'over 2h 30m', series: '4+ seasons' },
];
const KIND_LABEL = { movie: 'Movie', series: 'Web series' };
const LOCAL_KEY = 'popcorn-bucket-v1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOTION = reducedMotion ? 0.35 : 1;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/* =========================================================
   Data store
   With Firebase configured: each list lives online under a private
   code carried in the page link (#code), so the same link shows the
   same list on any device. Without it: this browser only.
   ========================================================= */
let items = [];
let backend = 'pending';
let sampleApi = null;          // Claude auto-fill only exists inside Claude; hidden here
let fb = null;                 // { db, fns, code }
let unsubscribe = null;
let freshCode = false;
const CODE_KEY = 'popcorn-bucket-code';
const CODE_RE = /^[A-Za-z0-9]{16,40}$/;
const FIREBASE_VERSION = '10.12.2';

function cleanItem(id, raw){
  const r = raw || {};
  return {
    id,
    name: String(r.name || '').slice(0, 120),
    kind: r.kind === 'series' ? 'series' : 'movie',
    platform: typeof r.platform === 'string' ? r.platform.slice(0, 40) : '',
    duration: ['short', 'medium', 'long'].includes(r.duration) ? r.duration : '',
    genres: Array.isArray(r.genres) ? r.genres.filter(g => typeof g === 'string').slice(0, 8) : [],
    status: r.status === 'watched' ? 'watched' : 'bucket',
    rewatch: !!r.rewatch,
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : '',
    watchedAt: typeof r.watchedAt === 'string' ? r.watchedAt : '',
    timesWatched: Number.isFinite(r.timesWatched) ? Math.round(r.timesWatched) : 0,
  };
}
function toDoc(it){
  const { id, ...rest } = it;
  return { ...rest, genres: [...it.genres] };
}
function loadLocal(){
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(r => cleanItem(r.id, r)).filter(r => r.id && r.name) : [];
  } catch (e) { return []; }
}
function saveLocal(){
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(items)); } catch (e) { /* storage unavailable */ }
}
function newId(){ return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function newCode(){
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint32Array(20);
  crypto.getRandomValues(buf);
  return Array.from(buf, n => alphabet[n % alphabet.length]).join('');
}
function readCode(){
  const fromHash = location.hash.replace(/^#/, '');
  if (CODE_RE.test(fromHash)){
    try { localStorage.setItem(CODE_KEY, fromHash); } catch (e) { /* ignore */ }
    return fromHash;
  }
  let code = null;
  try { code = localStorage.getItem(CODE_KEY); } catch (e) { /* ignore */ }
  if (!code || !CODE_RE.test(code)){
    code = newCode();
    freshCode = true;
    try { localStorage.setItem(CODE_KEY, code); } catch (e) { /* ignore */ }
  }
  history.replaceState(null, '', location.pathname + location.search + '#' + code);
  return code;
}
function myLink(){ return fb ? location.origin + location.pathname + '#' + fb.code : ''; }
const titleRef = (id) => fb.fns.doc(fb.db, 'buckets', fb.code, 'titles', id);

function writeErrorMessage(e){
  if (e && e.code === 'permission-denied') return "That change wasn't accepted. Try again, or reload the page.";
  if (e && e.code === 'resource-exhausted') return "The popcorn machine is busy today. Try again tomorrow.";
  return "Couldn't save that change. Check your connection and try again.";
}

async function addItem(it){
  if (backend === 'firebase'){
    try { await fb.fns.setDoc(titleRef(it.id), toDoc(it)); }
    catch (e){ toast(writeErrorMessage(e)); }
  } else {
    items = [...items, it]; saveLocal(); onItemsChanged();
  }
}
async function updateItem(id, patch){
  if (backend === 'firebase'){
    try { await fb.fns.updateDoc(titleRef(id), patch); }
    catch (e){ toast(writeErrorMessage(e)); }
  } else {
    items = items.map(x => x.id === id ? cleanItem(id, { ...x, ...patch }) : x); saveLocal(); onItemsChanged();
  }
}
async function deleteItem(id){
  if (backend === 'firebase'){
    try { await fb.fns.deleteDoc(titleRef(id)); }
    catch (e){ toast(writeErrorMessage(e)); }
  } else {
    items = items.filter(x => x.id !== id); saveLocal(); onItemsChanged();
  }
}

function subscribe(){
  if (unsubscribe) unsubscribe();
  const { fns, db, code } = fb;
  unsubscribe = fns.onSnapshot(
    fns.collection(db, 'buckets', code, 'titles'),
    (snap) => {
      items = snap.docs.map(d => cleanItem(d.id, d.data())).filter(x => x.name);
      onItemsChanged();
    },
    () => toast("Couldn't reach your bucket. Check your connection.")
  );
}

async function initStore(){
  if (firebaseConfig && firebaseConfig.projectId){
    try {
      const base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';
      const appMod = await import(base + 'firebase-app.js');
      const fs = await import(base + 'firebase-firestore.js');
      const fbApp = appMod.initializeApp(firebaseConfig);
      let db;
      try { db = fs.initializeFirestore(fbApp, { localCache: fs.persistentLocalCache() }); }
      catch (e) { db = fs.getFirestore(fbApp); }
      fb = { db, fns: fs, code: readCode() };
      backend = 'firebase';
      subscribe();
      window.addEventListener('hashchange', () => {
        const h = location.hash.replace(/^#/, '');
        if (!CODE_RE.test(h) || h === fb.code) return;
        fb.code = h;
        try { localStorage.setItem(CODE_KEY, h); } catch (e) { /* ignore */ }
        items = [];
        onItemsChanged();
        subscribe();
      });
      if (freshCode) setTimeout(() => toast('Your list has its own private link. Find it under Your list.'), 1200);
      return;
    } catch (e) {
      console.warn('Firebase unavailable, saving in this browser only.', e);
    }
  }
  backend = 'local';
  items = loadLocal();
  onItemsChanged();
}

const pool = () => items.filter(x => x.status === 'bucket');
const watchedList = () => items.filter(x => x.status === 'watched');

/* =========================================================
   Three.js scene
   ========================================================= */
const stageEl = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.setClearColor(0x0c0907, 1);
stageEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
const FOCUS = new THREE.Vector3(0, 0.4, 0);
camera.position.set(0, 1.9, 8);
camera.lookAt(FOCUS);
const focusPlane = new THREE.Plane();
{
  const n = new THREE.Vector3(); camera.getWorldDirection(n); n.negate();
  focusPlane.setFromNormalAndCoplanarPoint(n, FOCUS);
}

let viewW = 1, viewH = 1;
function resize(){
  viewW = stageEl.clientWidth || window.innerWidth;
  viewH = stageEl.clientHeight || window.innerHeight;
  renderer.setSize(viewW, viewH);
  camera.aspect = viewW / viewH;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function screenToWorld(x, y, out = new THREE.Vector3()){
  ndc.set((x / viewW) * 2 - 1, -(y / viewH) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  raycaster.ray.intersectPlane(focusPlane, out);
  return out;
}
function slotInfo(node){
  const r = node.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const s = stageEl.getBoundingClientRect();
  const cx = r.left - s.left + r.width / 2;
  const top = screenToWorld(cx, r.top - s.top);
  const bottom = screenToWorld(cx, r.bottom - s.top);
  const center = screenToWorld(cx, r.top - s.top + r.height / 2);
  const left = screenToWorld(r.left - s.left, r.top - s.top + r.height / 2);
  const right = screenToWorld(r.right - s.left, r.top - s.top + r.height / 2);
  return { top, bottom, center, h: top.distanceTo(bottom), w: left.distanceTo(right) };
}

/* lights */
scene.add(new THREE.HemisphereLight(0x6a5842, 0x080504, 0.8));
const keyLight = new THREE.SpotLight(0xffd9a0, 140, 0, 0.5, 0.65, 2);
keyLight.position.set(1.2, 7, 3.5);
scene.add(keyLight);
scene.add(keyLight.target);
const fill = new THREE.DirectionalLight(0xffe7c4, 1.1);
fill.position.set(-2, 2, 6);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x8fb4ff, 0.9);
rim.position.set(-3, 2.5, -4);
scene.add(rim);
const flash = new THREE.PointLight(0xffcf8a, 0, 8, 2);
const slotLight = new THREE.PointLight(0xfff0d8, 0, 6, 2);
scene.add(slotLight);
scene.add(flash);

/* soft textures */
function radialTexture(stops){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const sparkTex = radialTexture([[0, 'rgba(255,240,205,1)'], [0.35, 'rgba(255,205,120,0.85)'], [1, 'rgba(255,205,120,0)']]);
const poolTex = radialTexture([[0, 'rgba(255,196,110,0.55)'], [0.45, 'rgba(255,170,80,0.18)'], [1, 'rgba(255,170,80,0)']]);

/* bucket rig: bucket + light pool + beam + dust */
const rig = new THREE.Group();
scene.add(rig);
const bucketGroup = new THREE.Group();
rig.add(bucketGroup);
let BUCKET_H = 0, BUCKET_W = 1;
let bucketScale = 0.001;
let bucketReady = false;

const lightPool = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
);
lightPool.rotation.x = -Math.PI / 2;
rig.add(lightPool);

const beamMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color(0xffd08a) }, uOpacity: { value: 0.09 } },
  vertexShader: `
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main(){
      vUv = uv;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uOpacity;
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main(){
      float facing = abs(dot(vN, vV));
      float a = uOpacity * pow(facing, 2.2) * (0.35 + 0.65 * vUv.y) * smoothstep(0.0, 0.18, vUv.y);
      gl_FragColor = vec4(uColor, a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const beam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 48, 1, true), beamMat);
rig.add(beam);

const DUST = reducedMotion ? 0 : 70;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(Math.max(DUST, 1) * 3);
const dustSeed = [];
for (let i = 0; i < DUST; i++){
  dustSeed.push({ a: Math.random() * Math.PI * 2, r: Math.sqrt(Math.random()), y: Math.random(), s: 0.02 + Math.random() * 0.05, w: Math.random() * 6 });
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ map: sparkTex, size: 0.05, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
rig.add(dust);

/* =========================================================
   Load models
   ========================================================= */
const loader = new GLTFLoader();
const loadGlb = (url) => loader.loadAsync(url);
const texLoader = new THREE.TextureLoader();
function fileTexture(url, srgb){
  const tex = texLoader.load(url);
  tex.flipY = false; // matches the glTF UV convention of this mesh
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

let kernelGeo = null, kernelOffset = new THREE.Vector3(), morphIdx = 0;
const KERNEL_SIZE = 1.06; // popped size in model units

Promise.all([loadGlb('assets/kernel.glb'), loadGlb('assets/bucket.glb')]).then(([kg, bg]) => {
  const km = kg.scene.getObjectByProperty('type', 'Mesh') || kg.scene.children[0];
  kernelGeo = km.geometry;
  kernelGeo.computeBoundingBox();
  kernelGeo.boundingBox.getCenter(kernelOffset).negate();
  morphIdx = (km.morphTargetDictionary && 'popped' in km.morphTargetDictionary) ? km.morphTargetDictionary.popped : 0;

  const model = bg.scene;
  model.updateMatrixWorld(true); // the file's node transform already stands it upright
  const box = new THREE.Box3().setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  model.position.set(-c.x, -box.min.y, -c.z);
  BUCKET_H = size.y; BUCKET_W = Math.max(size.x, size.z);

  const bucketBaseTex = fileTexture('assets/bucket-base.jpg', true);
  const bucketNormalTex = fileTexture('assets/bucket-normal.jpg', false);

  model.traverse(o => {
    if (o.isMesh && o.material){
      o.material.map = bucketBaseTex;
      o.material.normalMap = bucketNormalTex;
      o.material.color.set(0xffffff);
      o.material.roughness = 0.7;
      o.material.metalness = 0;
      o.material.side = THREE.DoubleSide;
      o.material.envMapIntensity = 1;
      o.material.needsUpdate = true;
    }
  });
  const turn = new THREE.Group(); turn.rotation.y = -0.55; turn.add(model);
  bucketGroup.add(turn);
  bucketReady = true;
  $('loading').hidden = true;
  refreshControls();
}).catch(() => {
  $('loading').textContent = "The popcorn machine didn't start. Reload the page to try again.";
});

/* =========================================================
   Popcorn pieces
   ========================================================= */
const CORN = new THREE.Color(0xf4b845);
const CREAM = new THREE.Color(0xf0cc8a);
const pieces = new Set();
function makePopcorn(pop){
  const mat = new THREE.MeshPhysicalMaterial({ color: CORN.clone(), roughness: 0.32, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.25, sheen: 0.2, sheenColor: new THREE.Color(0xffdca0) });
  const mesh = new THREE.Mesh(kernelGeo, mat);
  mesh.position.copy(kernelOffset);
  const group = new THREE.Group(); group.add(mesh);
  group.scale.setScalar(0.0001);
  scene.add(group);
  const p = { group, mesh, mat, pop: 0, state: 'free', appear: 1, punch: 1, spin: Math.random() * 6, snapped: false };
  setPop(p, pop);
  pieces.add(p);
  return p;
}
function setPop(p, t){
  p.pop = t;
  if (p.mesh.morphTargetInfluences) p.mesh.morphTargetInfluences[morphIdx] = t;
  p.mat.color.copy(CORN).lerp(CREAM, t);
  p.mat.roughness = 0.32 + 0.46 * t;
  p.mat.clearcoat = 0.8 * (1 - t) + 0.04;
  p.mat.sheen = 0.2 + 0.4 * t;
}
function removePopcorn(p){ scene.remove(p.group); p.mat.dispose(); pieces.delete(p); }

/* bursts */
const bursts = new Set();
function burst(pos, count, size, speed, color){
  const geo = new THREE.BufferGeometry();
  const arr = new Float32Array(count * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.PointsMaterial({ map: sparkTex, size, color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(geo, mat);
  pts.position.copy(pos);
  scene.add(pts);
  const vel = [];
  for (let i = 0; i < count; i++){
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1), sp = speed * (0.5 + Math.random() * 0.8);
    vel.push(new THREE.Vector3(Math.sin(ph) * Math.cos(th) * sp, Math.abs(Math.sin(ph) * Math.sin(th)) * sp + speed * 0.4, Math.cos(ph) * sp));
  }
  bursts.add({ pts, geo, mat, vel, born: performance.now(), life: 750, g: speed * 1.8 });
}

/* =========================================================
   Tweens
   ========================================================= */
const tweens = new Set();
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInCubic = t => t * t * t;
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
function tween(ms, fn, ease = t => t){
  return new Promise(resolve => {
    tweens.add({ start: performance.now(), ms: Math.max(16, ms * MOTION), fn, ease, resolve });
  });
}
const wait = ms => tween(ms, () => {});
function bezier(a, b, c, t, out){
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    u * u * a.z + 2 * u * t * b.z + t * t * c.z
  );
  return out;
}

/* bucket helpers */
let jiggleAt = -1e9;
let shakeAmt = 0;
function bucketTopPoint(out = new THREE.Vector3()){
  out.set(0, BUCKET_H * 0.88, 0);
  return bucketGroup.localToWorld(out);
}
function bucketWorldH(){ return BUCKET_H * bucketScale; }
function smallScale(){ return bucketWorldH() * 0.15 / KERNEL_SIZE; }
function offTopPoint(fromX){
  const x = Math.min(Math.max((fromX != null ? fromX : viewW / 2), 40), viewW - 40);
  return screenToWorld(x, -viewH * 0.25);
}

/* =========================================================
   Animations built on the pieces
   ========================================================= */
/* =========================================================
   Sound: everything is synthesised with Web Audio (no files).
   Nothing plays until the viewer has clicked or tapped once.
   ========================================================= */
const Sound = (() => {
  const KEY = 'popcorn-bucket-muted';
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* ignore */ }
  const r = (x, y) => x + Math.random() * (y - x);

  function ready(){
    if (muted) return false;
    if (!ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.7;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master.connect(comp); comp.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx.state !== 'closed';
  }
  // one short burst of filtered noise
  function grain({ t = 0, dur = 0.02, freq = 3000, q = 1, gain = 0.2, type = 'bandpass', attack = 0.0008, to = null }){
    const t0 = ctx.currentTime + t;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0, r(0, 0.9)); src.stop(t0 + dur + 0.03);
  }
  function thump({ t = 0, dur = 0.08, freq = 140, to = 70, gain = 0.2 }){
    const t0 = ctx.currentTime + t;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  // a single kernel popping: sharp crack, hollow body, tiny thump
  function crack(t, gain){
    grain({ t, dur: 0.012, freq: 2400, type: 'highpass', q: 0.7, gain: gain });
    grain({ t: t + 0.001, dur: r(0.03, 0.05), freq: r(750, 1400), q: r(4, 7), gain: gain * 0.55 });
    thump({ t, dur: 0.05, freq: r(150, 210), to: 80, gain: gain * 0.35 });
  }
  // popcorn shifting against a paper tub: lots of dry little crackles
  function rustle(t, dur, perSec, gain, shape){
    const n = Math.max(3, Math.round(dur * perSec));
    for (let i = 0; i < n; i++){
      const u = Math.random();
      const k = shape ? shape(u) : 1;
      const at = t + u * dur;
      if (Math.random() < 0.8){
        grain({ t: at, dur: r(0.006, 0.025), freq: r(2500, 7000), q: r(0.8, 2.2), gain: gain * k * r(0.35, 1) });
      } else {
        grain({ t: at, dur: r(0.02, 0.05), freq: r(700, 1500), q: r(1.5, 3), gain: gain * k * r(0.4, 0.9) });
      }
    }
  }
  // the cardboard tub itself: a dull knock
  function tub(t, gain){
    grain({ t, dur: 0.07, freq: 320, type: 'lowpass', q: 0.7, gain: gain, attack: 0.002 });
    thump({ t, dur: 0.09, freq: 120, to: 65, gain: gain * 0.6 });
  }

  return {
    get muted(){ return muted; },
    setMuted(m){
      muted = m;
      try { localStorage.setItem(KEY, m ? '1' : '0'); } catch (e) { /* ignore */ }
      if (!m) ready();
    },
    // small dry tick for any button
    click(){
      if (!ready()) return;
      grain({ dur: 0.009, freq: 3200, type: 'highpass', q: 0.7, gain: 0.16 });
      grain({ dur: 0.02, freq: r(1600, 2000), q: 6, gain: 0.05 });
    },
    // the kernel popping into popcorn
    pop(){
      if (!ready()) return;
      crack(0, 0.95);
      crack(0.035, 0.25);
      rustle(0.02, 0.12, 60, 0.05);
    },
    // one small pop, for tossed pieces
    blip(){
      if (!ready()) return;
      crack(0, r(0.25, 0.4));
    },
    // popcorn landing on the heap in the tub
    land(){
      if (!ready()) return;
      tub(0, 0.22);
      rustle(0.005, 0.22, 80, 0.14, u => 1 - u);
    },
    // shaking the bucket: dense rustle that swells and fades, cardboard knocks on each stroke
    rattle(ms = 700){
      if (!ready()) return;
      const d = ms / 1000;
      rustle(0, d, 150, 0.2, u => Math.sin(Math.PI * u) * 0.85 + 0.15);
      const strokes = Math.max(2, Math.round(d / 0.14));
      for (let i = 0; i < strokes; i++) tub(i * d / strokes + r(0, 0.02), 0.08 + 0.1 * Math.sin(Math.PI * (i + 0.5) / strokes));
    },
    // a piece jumping out of the tub
    whoosh(){
      if (!ready()) return;
      crack(0, 0.45);
      rustle(0, 0.15, 60, 0.08, u => 1 - u);
    },
    // the pick is revealed: a bright double pop
    reveal(){
      if (!ready()) return;
      crack(0, 0.6);
      crack(0.09, 0.4);
    },
    // popcorn being eaten: two crunchy bites
    crunch(){
      if (!ready()) return;
      for (const b of [0, 0.16]){
        thump({ t: b, dur: 0.06, freq: 110, to: 60, gain: 0.25 });
        for (let i = 0; i < 9; i++) grain({ t: b + r(0, 0.09), dur: r(0.01, 0.035), freq: r(1200, 4500), q: r(0.6, 1.5), gain: r(0.15, 0.35) });
      }
    },
    // the social icons knocking the floor
    tap(strength){
      if (!ready()) return;
      const g = Math.min(0.14, 0.02 + strength / 10000);
      grain({ dur: 0.012, freq: 2600, type: 'highpass', q: 0.7, gain: g });
      thump({ dur: 0.05, freq: r(260, 340), to: 180, gain: g * 0.8 });
    },
  };
})();

// every button gets a soft click
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button, select, .toy');
  if (!b || b.disabled || b.id === 'soundBtn') return;
  Sound.click();
}, true);

function renderSoundBtn(){
  const on = !Sound.muted;
  const b = $('soundBtn');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
  b.title = on ? 'Sound on' : 'Sound off';
}
$('soundBtn').addEventListener('click', () => {
  Sound.setMuted(!Sound.muted);
  renderSoundBtn();
  if (!Sound.muted) Sound.blip();
});
renderSoundBtn();

async function popPiece(p){
  Sound.pop();
  flash.position.copy(p.group.position).add(new THREE.Vector3(0, 0.3, 1));
  flash.intensity = 6;
  burst(p.group.position, 26, 0.13, 1.4, 0xffe0a8);
  await Promise.all([
    tween(640, t => setPop(p, t), easeOutCubic),
    tween(560, t => { p.punch = 1 + 0.3 * Math.sin(Math.PI * t) * (1 - t * 0.6); }),
  ]);
  p.punch = 1;
}

async function flyIntoBucket(p, ms = 1000){
  p.state = 'flying';
  const start = p.group.position.clone();
  const s0 = p.group.scale.x;
  const rx = p.group.rotation.x, rz = p.group.rotation.z;
  const end = new THREE.Vector3(), mid = new THREE.Vector3();
  await tween(ms, t => {
    bucketTopPoint(end);
    mid.copy(start).lerp(end, 0.5);
    mid.y = Math.max(start.y, end.y) + start.distanceTo(end) * 0.4;
    bezier(start, mid, end, t, p.group.position);
    p.group.scale.setScalar(lerp(s0, smallScale(), t));
    p.group.rotation.x = rx + t * Math.PI * 3;
    p.group.rotation.z = rz + t * Math.PI * 1.2;
  }, easeInOutCubic);
  jiggleAt = performance.now();
  burst(bucketTopPoint(), 12, 0.06, 0.6, 0xfff0d0);
  Sound.land();
  const land = p.group.position.clone(); const s1 = p.group.scale.x;
  await tween(260, t => {
    p.group.position.set(land.x, land.y - t * bucketWorldH() * 0.12, land.z);
    p.group.scale.setScalar(s1 * (1 - t));
  });
  removePopcorn(p);
}

async function flyOutOfBucketToSlot(p, ms = 950){
  p.state = 'flying';
  const start = bucketTopPoint();
  const end = new THREE.Vector3(), mid = new THREE.Vector3();
  burst(start, 14, 0.07, 0.8, 0xffe7b8);
  Sound.whoosh();
  await tween(ms, t => {
    const si = slotInfo($('kernelSlot'));
    if (si) end.copy(si.center); else end.copy(start).add(new THREE.Vector3(0, 1, 0));
    mid.copy(start).lerp(end, 0.5);
    mid.y = Math.max(start.y, end.y) + start.distanceTo(end) * 0.45;
    bezier(start, mid, end, t, p.group.position);
    const target = si ? si.h * 0.7 / KERNEL_SIZE : smallScale();
    p.group.scale.setScalar(lerp(smallScale(), target, t));
    p.group.rotation.x = t * Math.PI * 4;
    p.group.rotation.y = p.spin + t * Math.PI * 2;
  }, easeOutCubic);
  p.group.rotation.x = 0;
  p.state = 'slot';
  p.snapped = true;
}

async function flyUpAndAway(p, ms = 850){
  p.state = 'flying';
  const start = p.group.position.clone();
  const s0 = p.group.scale.x;
  burst(start, 22, 0.09, 1.1, 0xfff0d0);
  Sound.crunch();
  flash.position.copy(start).add(new THREE.Vector3(0, 0.2, 1)); flash.intensity = 4;
  const drift = (Math.random() - 0.5) * 1.2;
  await tween(ms, t => {
    const top = offTopPoint();
    p.group.position.set(start.x + drift * t, lerp(start.y, top.y, t), start.z);
    p.group.scale.setScalar(s0 * (1 - 0.55 * t));
    p.group.rotation.y += 0.25;
    p.group.rotation.x += 0.12;
  }, easeInCubic);
  removePopcorn(p);
}

async function eatFromBucket(){
  if (!bucketReady) return;
  const p = makePopcorn(1);
  p.state = 'flying';
  p.group.position.copy(bucketTopPoint());
  p.group.scale.setScalar(smallScale() * 1.6);
  jiggleAt = performance.now();
  await flyUpAndAway(p, 900);
}
async function dropIntoBucket(){
  if (!bucketReady) return;
  const p = makePopcorn(1);
  p.state = 'flying';
  const top = offTopPoint();
  const end = bucketTopPoint();
  p.group.position.set(end.x, top.y, end.z);
  p.group.scale.setScalar(smallScale() * 1.6);
  await flyIntoBucket(p, 800);
}

/* =========================================================
   Render loop
   ========================================================= */
const tmpA = new THREE.Vector3();
let last = performance.now();
function tick(now){
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  for (const tw of tweens){
    const raw = Math.min(1, (now - tw.start) / tw.ms);
    tw.fn(tw.ease(raw), raw);
    if (raw >= 1){ tweens.delete(tw); tw.resolve(); }
  }

  // bucket follows its slot
  if (bucketReady){
    const bs = slotInfo($('bucketSlot'));
    if (bs){
      const targetScale = Math.min(bs.h * 0.76 / BUCKET_H, bs.w * 0.72 / BUCKET_W);
      tmpA.copy(bs.bottom).lerp(bs.top, 0.1);
      const k = rig.userData.placed ? 1 - Math.exp(-dt * 5) : 1;
      rig.position.lerp(tmpA, k);
      bucketScale += (targetScale - bucketScale) * k;
      rig.userData.placed = true;
    }
    const jt = (now - jiggleAt) / 1000;
    const sq = jt < 0.7 ? Math.sin(jt * 24) * Math.exp(-jt * 6) * 0.09 : 0;
    bucketGroup.scale.set(bucketScale * (1 + sq * 0.5), bucketScale * (1 - sq), bucketScale * (1 + sq * 0.5));
    bucketGroup.rotation.z = shakeAmt * Math.sin(now * 0.045);
    if (!drag){ userYaw += yawVel * dt; yawVel *= Math.exp(-dt * 3.5); }
    bucketGroup.rotation.y = (reducedMotion ? 0 : Math.sin(now * 0.00035) * 0.18) + userYaw;
    const ht = (now - hopAt) / 1000;
    const hop = ht < 1.1 ? Math.abs(Math.sin(ht * Math.PI * 2.6)) * Math.exp(-ht * 3.2) : 0;
    bucketGroup.position.y = hop * bucketWorldH() * 0.09;

    const bw = BUCKET_W * bucketScale;
    lightPool.scale.set(bw * 3.4, bw * 2.6, 1);
    lightPool.position.set(0, 0.002, 0);
    const beamH = Math.max(6, offTopPoint().y - rig.position.y + 1);
    beam.scale.set(bw * 1.05, beamH, bw * 1.05);
    beam.position.set(0, beamH / 2, 0);
    keyLight.target.position.copy(rig.position);
    keyLight.position.set(rig.position.x + 1.2, rig.position.y + 7, rig.position.z + 3.5);

    for (let i = 0; i < DUST; i++){
      const d = dustSeed[i];
      d.y += dt * d.s * 0.4;
      if (d.y > 1) d.y -= 1;
      const rr = d.r * bw * 1.1 * (0.5 + 0.5 * (1 - d.y));
      dustPos[i * 3] = Math.cos(d.a + now * 0.0001 * d.w) * rr;
      dustPos[i * 3 + 1] = d.y * bucketWorldH() * 2.6;
      dustPos[i * 3 + 2] = Math.sin(d.a + now * 0.0001 * d.w) * rr;
    }
    if (DUST) dustGeo.getAttribute('position').needsUpdate = true;
    dust.material.size = bw * 0.035;
  }

  // pieces sitting in the panel slot
  const ks = slotInfo($('kernelSlot'));
  slotLight.intensity += ((ks ? 7 : 0) - slotLight.intensity) * Math.min(1, dt * 6);
  if (ks) slotLight.position.set(ks.center.x + 0.6, ks.center.y + 0.8, ks.center.z + 1.6);
  for (const p of pieces){
    if (p.state !== 'slot' || !ks) continue;
    const target = ks.center.clone();
    target.y += reducedMotion ? 0 : Math.sin(now * 0.0022) * ks.h * 0.035;
    const k = p.snapped ? 1 - Math.exp(-dt * 12) : 1;
    p.group.position.lerp(target, k);
    p.snapped = true;
    p.group.scale.setScalar(Math.max(0.0001, ks.h * 0.7 / KERNEL_SIZE * p.appear * p.punch));
    if (!reducedMotion) p.group.rotation.y += dt * 0.7;
  }

  if (flash.intensity > 0) flash.intensity = Math.max(0, flash.intensity - dt * 14);

  for (const b of bursts){
    const age = (now - b.born) / b.life;
    if (age >= 1){ scene.remove(b.pts); b.geo.dispose(); b.mat.dispose(); bursts.delete(b); continue; }
    const secs = (now - b.born) / 1000;
    const pa = b.geo.getAttribute('position');
    for (let i = 0; i < b.vel.length; i++){
      const v = b.vel[i];
      pa.setXYZ(i, v.x * secs, v.y * secs - 0.5 * b.g * secs * secs, v.z * secs);
    }
    pa.needsUpdate = true;
    b.mat.opacity = 1 - age;
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(tick);

/* =========================================================
   Bucket interaction: drag to spin, tap to toss the popcorn
   ========================================================= */
let drag = null;
let userYaw = 0, yawVel = 0;
let hopAt = -1e9;
const canvasEl = renderer.domElement;

function hitsBucket(clientX, clientY){
  if (!bucketReady) return false;
  const r = stageEl.getBoundingClientRect();
  ndc.set(((clientX - r.left) / viewW) * 2 - 1, -((clientY - r.top) / viewH) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObject(bucketGroup, true).length > 0;
}

canvasEl.addEventListener('pointerdown', (e) => {
  drag = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastT: performance.now(), moved: false };
  yawVel = 0;
  try { canvasEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});
let hoverQueued = false;
canvasEl.addEventListener('pointermove', (e) => {
  if (drag){
    const now = performance.now();
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6){ drag.moved = true; canvasEl.style.cursor = 'grabbing'; }
    if (drag.moved){
      const dx = e.clientX - drag.lastX;
      const step = dx * 0.011;
      userYaw += step;
      const dtm = Math.max(16, now - drag.lastT) / 1000;
      yawVel = step / dtm;
    }
    drag.lastX = e.clientX; drag.lastT = now;
    return;
  }
  if (e.pointerType !== 'mouse' || hoverQueued) return;
  hoverQueued = true;
  const x = e.clientX, y = e.clientY;
  requestAnimationFrame(() => { hoverQueued = false; canvasEl.style.cursor = hitsBucket(x, y) ? 'grab' : ''; });
});
function endDrag(e){
  if (!drag) return;
  const wasTap = !drag.moved;
  if (performance.now() - drag.lastT > 90) yawVel = 0; // released while holding still
  drag = null;
  canvasEl.style.cursor = '';
  if (wasTap && e.type === 'pointerup' && hitsBucket(e.clientX, e.clientY)) tossPopcorn();
}
canvasEl.addEventListener('pointerup', endDrag);
canvasEl.addEventListener('pointercancel', endDrag);

function tossPopcorn(){
  const now = performance.now();
  if (now - hopAt < 700) return;
  hopAt = now;
  setTimeout(() => { jiggleAt = performance.now(); }, 380 * MOTION);
  Sound.rattle(260);
  if (reducedMotion) return;
  const count = 7;
  for (let i = 0; i < count; i++) setTimeout(() => { flingOne(); if (i % 2 === 0) Sound.blip(); }, i * 55);
  setTimeout(() => Sound.land(), 700);
}

function flingOne(){
  const p = makePopcorn(1);
  p.state = 'flying';
  const H = bucketWorldH();
  const s = smallScale() * (0.9 + Math.random() * 0.5);
  const vy = H * (1.5 + Math.random() * 0.9);
  const g = H * 5.2;
  const ang = Math.random() * Math.PI * 2;
  const spread = H * (0.12 + Math.random() * 0.22);
  const vx = Math.cos(ang) * spread, vz = Math.sin(ang) * spread * 0.6;
  const start = new THREE.Vector3((Math.random() - 0.5) * BUCKET_W * bucketScale * 0.5, 0, (Math.random() - 0.5) * BUCKET_W * bucketScale * 0.3);
  const flight = (2 * vy / g) * 1000;
  const spinX = (Math.random() - 0.5) * 12, spinY = (Math.random() - 0.5) * 10;
  const top = new THREE.Vector3();
  p.group.scale.setScalar(s);
  tween(flight, (t, raw) => {
    const secs = raw * flight / 1000;
    bucketTopPoint(top);
    // drift out, then back toward the middle so it lands in the bucket
    p.group.position.set(
      top.x + start.x + vx * secs * (1 - raw),
      top.y + vy * secs - 0.5 * g * secs * secs,
      top.z + start.z + vz * secs * (1 - raw)
    );
    p.group.rotation.set(spinX * secs, spinY * secs, 0);
  }).then(() => tween(200, t => { p.group.scale.setScalar(s * (1 - t)); p.group.position.y -= H * 0.004; }))
    .then(() => removePopcorn(p));
}

/* =========================================================
   UI state
   ========================================================= */
const layoutEl = $('layout');
const panelEl = $('panel');
const cardEl = $('card');
let mode = 'idle';
let busy = false;
let hero = null;          // the kernel in the add form
let current = null;       // { item, piece } for the picked title

function setMode(m){
  mode = m;
  layoutEl.dataset.mode = m;
  cardEl.classList.remove('sending');
  $('composeView').hidden = m !== 'compose';
  $('resultView').hidden = m !== 'result';
  $('dock').hidden = m !== 'idle';
  document.querySelectorAll('.card-body').forEach(b => { b.scrollTop = 0; });
}
function refreshControls(){
  $('addBtn').disabled = busy || !bucketReady;
  $('pickBtn').disabled = busy || !bucketReady;
}
function setBusy(b){ busy = b; refreshControls(); }

let toastTimer = 0;
function toast(msg){
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function durationText(it){
  const d = DURATIONS.find(x => x.id === it.duration);
  if (!d) return '';
  return d.label + ' (' + (it.kind === 'series' ? d.series : d.movie) + ')';
}
function metaLine(it){
  return [KIND_LABEL[it.kind], it.platform, durationText(it)].filter(Boolean).join(' \u00b7 ');
}

function onItemsChanged(){
  const b = pool().length, w = watchedList().length;
  $('tally').textContent = b + ' in the bucket \u00b7 ' + w + ' watched';
  $('tabBucket').textContent = 'In the bucket (' + b + ')';
  $('tabWatched').textContent = 'Watched (' + w + ')';
  const hint = $('dockHint');
  if (backend !== 'pending' && b === 0){
    hint.hidden = false;
    hint.textContent = w ? 'Everything in the bucket is watched. Add something new, or mark an old favourite for a rewatch.' : 'Your bucket is empty. Add the first thing you want to watch.';
  } else if (backend !== 'pending'){
    hint.hidden = false;
    hint.textContent = 'Drag to spin the bucket \u00b7 tap it for a toss';
  } else hint.hidden = true;
  if (!$('drawer').hidden) renderRows();
  if (mode === 'result') renderQuick();
}

/* ---------- chips ---------- */
function keepFocus(fn){
  const a = document.activeElement;
  const k = a && a.dataset ? a.dataset.key : null;
  fn();
  if (k){ const n = document.querySelector('[data-key="' + CSS.escape(k) + '"]'); if (n) n.focus({ preventScroll: true }); }
}
function chip(label, pressed, onClick, sub, key){
  const b = el('button', 'chip');
  b.type = 'button';
  if (key) b.dataset.key = key;
  b.textContent = label;
  if (sub){ b.classList.add('dur'); b.append(el('small', null, sub)); }
  b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  b.addEventListener('click', onClick);
  return b;
}

/* =========================================================
   Add flow
   ========================================================= */
const form = { kind: '', platform: '', duration: '', genres: new Set() };

function renderComposeChips(){ keepFocus(renderComposeChipsInner); }
function renderComposeChipsInner(){
  const sel = $('platformSelect');
  if (!sel.options.length){
    sel.append(new Option('Not sure yet', ''));
    PLATFORMS.forEach(p => sel.append(new Option(p, p)));
    sel.append(new Option('Somewhere else...', '__other'));
  }
  if (form.platform && PLATFORMS.includes(form.platform)){ sel.value = form.platform; $('platformOther').hidden = true; }
  else if (!$('platformOther').hidden){ sel.value = '__other'; }
  else sel.value = '';
  const dc = $('durationChips'); dc.replaceChildren();
  DURATIONS.forEach(d => dc.append(chip(d.label, form.duration === d.id, () => {
    form.duration = form.duration === d.id ? '' : d.id; renderComposeChips();
  }, null, 'd:' + d.id)));
  const dur = DURATIONS.find(d => d.id === form.duration);
  $('durationHint').textContent = dur
    ? (form.kind === 'series' ? dur.series : form.kind === 'movie' ? dur.movie : dur.movie + ' for a movie, ' + dur.series + ' for a series')
    : (form.kind === 'series' ? 'Short 1 season \u00b7 Medium 2-3 \u00b7 Long 4+' : 'Short under 1h 30m \u00b7 Medium to 2h 30m \u00b7 Long beyond');
  const gc = $('genreChips'); gc.replaceChildren();
  GENRES.forEach(g => gc.append(chip(g, form.genres.has(g), () => {
    form.genres.has(g) ? form.genres.delete(g) : form.genres.add(g); renderComposeChips();
  }, null, 'g:' + g)));
  $('kindMovie').setAttribute('aria-checked', form.kind === 'movie' ? 'true' : 'false');
  $('kindSeries').setAttribute('aria-checked', form.kind === 'series' ? 'true' : 'false');
}
$('kindSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  form.kind = b.dataset.kind; $('formError').textContent = ''; renderComposeChips();
});
$('platformSelect').addEventListener('change', () => {
  const v = $('platformSelect').value;
  const other = $('platformOther');
  if (v === '__other'){ form.platform = ''; other.hidden = false; other.focus({ preventScroll: true }); }
  else { form.platform = v; other.hidden = true; other.value = ''; }
});

function openCompose(){
  if (busy || !bucketReady) return;
  form.kind = ''; form.platform = ''; form.duration = ''; form.genres = new Set();
  $('nameInput').value = ''; $('platformOther').value = ''; $('platformOther').hidden = true;
  $('formError').textContent = ''; $('autofillNote').hidden = true;
  cardEl.classList.remove('sending');
  renderComposeChips();
  setMode('compose');
  hero = makePopcorn(0);
  hero.state = 'slot';
  hero.appear = 0;
  tween(520, t => { if (hero) hero.appear = t; }, easeOutBack);
  setTimeout(() => $('nameInput').focus({ preventScroll: true }), 60);
}
async function closeCompose(){
  if (busy) return;
  const h = hero; hero = null;
  setMode('idle');
  if (h){ await tween(220, t => { h.appear = 1 - t; }); removePopcorn(h); }
}

function normalisePlatform(v){
  const s = v.trim().slice(0, 40);
  const hit = PLATFORMS.find(p => p.toLowerCase() === s.toLowerCase());
  return hit || s;
}

$('composeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || !hero) return;
  const name = $('nameInput').value.trim().replace(/\s+/g, ' ');
  const err = $('formError');
  if (!form.kind || !name){
    err.textContent = !form.kind && !name ? 'Pick movie or web series, and give it a name.' : (!form.kind ? 'Is it a movie or a web series?' : 'Give it a name first.');
    cardEl.classList.remove('shake'); void cardEl.offsetWidth; cardEl.classList.add('shake');
    return;
  }
  const dupe = items.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (dupe){
    err.textContent = dupe.status === 'bucket' ? "That's already in your bucket." : "You've watched that one. Open Your list and hit Rewatch to put it back.";
    return;
  }
  err.textContent = '';
  const other = $('platformOther').hidden ? '' : $('platformOther').value;
  const item = cleanItem(newId(), {
    name, kind: form.kind,
    platform: form.platform || normalisePlatform(other),
    duration: form.duration,
    genres: [...form.genres],
    status: 'bucket', rewatch: false,
    addedAt: new Date().toISOString(), watchedAt: '', timesWatched: 0,
  });
  setBusy(true);
  cardEl.classList.add('sending');
  addItem(item);
  const p = hero; hero = null;
  await popPiece(p);
  await wait(240);
  setMode('idle');
  await flyIntoBucket(p);
  setBusy(false);
  toast(name + ' is in the bucket');
});

/* auto-fill with Claude */
$('autofillBtn').addEventListener('click', async () => {
  if (!sampleApi) return;
  const name = $('nameInput').value.trim();
  const note = $('autofillNote');
  if (!name){ $('formError').textContent = 'Type the name first, then auto-fill.'; return; }
  const btn = $('autofillBtn');
  btn.disabled = true; btn.textContent = 'Asking Claude...';
  const kindHint = form.kind ? ' It is a ' + (form.kind === 'series' ? 'web series' : 'movie') + '.' : '';
  const prompt = 'You help fill in a watchlist entry. The title is ' + JSON.stringify(name) + '.' + kindHint + '\n' +
    'Reply with only a JSON object like {"known":true,"kind":"movie","platform":"Netflix","duration":"medium","genres":["Drama","Thriller"]}.\n' +
    'Rules:\n' +
    '- known: false if you do not recognise this exact title; then leave the other fields empty.\n' +
    '- kind: "movie" or "series".\n' +
    '- platform: where it most likely streams in India, exactly one of ' + PLATFORMS.join(', ') + ', or "" if unsure.\n' +
    '- duration: movies "short" (under 90 min), "medium" (90 to 150 min), "long" (over 150 min); series "short" (1 season), "medium" (2 to 3 seasons), "long" (4 or more seasons); "" if unsure.\n' +
    '- genres: 1 to 3, only from: ' + GENRES.join(', ') + '.';
  try {
    const r = await sampleApi.json(prompt, { modelTier: 'quick' });
    if (!r || typeof r !== 'object' || r.known === false){
      note.hidden = false; note.textContent = "Claude doesn't recognise that title. Fill the rest in yourself.";
    } else {
      const filled = [];
      if (!form.kind && (r.kind === 'movie' || r.kind === 'series')){ form.kind = r.kind; filled.push('kindSeg'); }
      if (!form.platform && $('platformOther').hidden && typeof r.platform === 'string' && PLATFORMS.includes(r.platform)){ form.platform = r.platform; filled.push('platformSelect'); }
      if (!form.duration && ['short', 'medium', 'long'].includes(r.duration)){ form.duration = r.duration; filled.push('durationChips'); }
      if (!form.genres.size && Array.isArray(r.genres)){
        r.genres.filter(g => GENRES.includes(g)).slice(0, 3).forEach(g => form.genres.add(g));
        if (form.genres.size) filled.push('genreChips');
      }
      renderComposeChips();
      filled.forEach(id => { const n = $(id); n.classList.remove('filled'); void n.offsetWidth; n.classList.add('filled'); });
      note.hidden = false;
      note.textContent = filled.length ? "Claude's best guess. Double-check the platform, availability changes." : 'Nothing new to fill in.';
    }
  } catch (e){
    const code = e && e.code;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)){
      btn.hidden = true; sampleApi = null;
    } else if (code === 'rate_limited'){
      note.hidden = false; note.textContent = 'Claude needs a breather. Try auto-fill again in a bit.';
    } else if (code !== 'cancelled'){
      note.hidden = false; note.textContent = "Couldn't auto-fill that one. Try again, or fill it in yourself.";
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Auto-fill';
  }
});

/* =========================================================
   Pick flow
   ========================================================= */
const filters = { kind: new Set(), platform: new Set(), duration: new Set(), genre: new Set() };
function matchesFilters(it){
  if (filters.kind.size && !filters.kind.has(it.kind)) return false;
  if (filters.platform.size && !filters.platform.has(it.platform)) return false;
  if (filters.duration.size && !filters.duration.has(it.duration)) return false;
  if (filters.genre.size && !it.genres.some(g => filters.genre.has(g))) return false;
  return true;
}
const matches = () => pool().filter(matchesFilters);

const anyFilter = () => !!(filters.kind.size || filters.platform.size || filters.duration.size || filters.genre.size);

function quickChip(label, set, value, key){
  return chip(label, set.has(value), () => {
    set.has(value) ? set.delete(value) : set.add(value);
    renderQuick();
  }, null, key);
}
function renderQuick(){ keepFocus(renderQuickInner); }
function renderQuickInner(){
  const p = pool();
  const platforms = [...new Set(p.map(x => x.platform).filter(Boolean))].sort((a, b) => {
    const ia = PLATFORMS.indexOf(a), ib = PLATFORMS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const genres = GENRES.filter(g => p.some(x => x.genres.includes(g)))
    .concat([...new Set(p.flatMap(x => x.genres))].filter(g => !GENRES.includes(g)));
  [...filters.platform].forEach(v => { if (!platforms.includes(v)) filters.platform.delete(v); });
  [...filters.genre].forEach(v => { if (!genres.includes(v)) filters.genre.delete(v); });

  const box = $('quickFilters'); box.replaceChildren();
  const sep = () => el('span', 'chip-sep');
  box.append(quickChip('Movie', filters.kind, 'movie', 'q:k:movie'), quickChip('Series', filters.kind, 'series', 'q:k:series'), sep());
  DURATIONS.forEach(d => box.append(quickChip(d.label, filters.duration, d.id, 'q:d:' + d.id)));
  if (genres.length){ box.append(sep()); genres.forEach(g => box.append(quickChip(g, filters.genre, g, 'q:g:' + g))); }
  if (platforms.length){ box.append(sep()); platforms.forEach(pl => box.append(quickChip(pl, filters.platform, pl, 'q:p:' + pl))); }

  const m = matches(), total = p.length;
  const mc = $('matchCount'); mc.replaceChildren();
  if (!m.length){
    mc.textContent = 'Nothing in the bucket fits that. Loosen one.';
  } else {
    mc.append(el('strong', null, String(m.length)), document.createTextNode(anyFilter() ? ' of ' + total + ' fit' : ' in the bucket, all fair game'));
  }
  if (anyFilter()){
    const c = el('button', 'link', 'Clear'); c.type = 'button';
    c.addEventListener('click', () => { Object.values(filters).forEach(x => x.clear()); renderQuick(); });
    mc.append(c);
  }
  const onlyCurrent = current && m.length === 1 && m[0].id === current.item.id;
  $('againBtn').disabled = busy || !m.length || onlyCurrent;
}
function openMood(open){
  $('quickBox').hidden = !open;
  $('moodBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('moodBtn').addEventListener('click', () => {
  openMood($('quickBox').hidden);
  renderQuick();
});

function startPick(){
  if (busy || !bucketReady) return;
  if (!pool().length){ toast('Your bucket is empty. Add a title first.'); return; }
  openMood(anyFilter());
  shake(null);
}

function showNoMatch(){
  $('resultEyebrow').textContent = 'Nothing to pick';
  $('pickName').textContent = 'No match';
  $('pickMeta').textContent = 'Nothing in the bucket fits these filters.';
  $('pickTags').replaceChildren();
  $('eatBtn').disabled = true;
  openMood(true);
  renderQuick();
}

async function shake(excludeId){
  const m = matches();
  setMode('result');
  if (!m.length){ showNoMatch(); return; }
  const cands = (m.length > 1 && excludeId) ? m.filter(x => x.id !== excludeId) : m;
  const choice = cands[Math.floor(Math.random() * cands.length)];
  setBusy(true);
  const nameEl = $('pickName');
  $('resultEyebrow').textContent = 'Shaking the bucket...';
  $('pickMeta').textContent = '';
  $('pickTags').replaceChildren();
  ['eatBtn', 'againBtn', 'resultClose', 'moodBtn'].forEach(id => { $(id).disabled = true; });
  nameEl.classList.remove('reveal');
  nameEl.classList.add('cycling');
  const names = m.map(x => x.name);
  let cyc = 0;
  const cycler = setInterval(() => { nameEl.textContent = names[(cyc++ + Math.floor(Math.random() * names.length)) % names.length]; }, 85);
  nameEl.textContent = names[0];

  Sound.rattle(700 * MOTION);
  await tween(700, t => { shakeAmt = Math.sin(Math.PI * t) * 0.1; });
  shakeAmt = 0;
  jiggleAt = performance.now();
  const p = makePopcorn(1);
  p.group.position.copy(bucketTopPoint());
  p.group.scale.setScalar(smallScale());
  await flyOutOfBucketToSlot(p);

  clearInterval(cycler);
  nameEl.classList.remove('cycling');
  nameEl.textContent = choice.name;
  void nameEl.offsetWidth;
  nameEl.classList.add('reveal');
  $('resultEyebrow').textContent = choice.rewatch ? 'Tonight, a rewatch' : "Tonight's pick";
  $('pickMeta').textContent = metaLine(choice);
  const tags = $('pickTags');
  if (choice.rewatch) tags.append(el('span', 'tag rewatch', 'Rewatch'));
  choice.genres.forEach(g => tags.append(el('span', 'tag', g)));
  ['eatBtn', 'resultClose', 'moodBtn'].forEach(id => { $(id).disabled = false; });
  Sound.reveal();
  current = { item: choice, piece: p };
  setBusy(false);
  renderQuick();
  $('eatBtn').focus({ preventScroll: true });
}

async function putPickBack(nextMode){
  const c = current; current = null;
  if (nextMode === 'idle') openMood(false);
  setMode(nextMode);
  if (c) await flyIntoBucket(c.piece, 750);
}

$('againBtn').addEventListener('click', async () => {
  if (busy || !matches().length) return;
  const prev = current ? current.item.id : null;
  if (current){
    setBusy(true);
    await putPickBack('result');
    setBusy(false);
  }
  shake(prev);
});
$('resultClose').addEventListener('click', () => { if (!busy) putPickBack('idle'); });
$('eatBtn').addEventListener('click', async () => {
  if (busy || !current) return;
  const c = current; current = null;
  setBusy(true);
  updateItem(c.item.id, { status: 'watched', rewatch: false, watchedAt: new Date().toISOString(), timesWatched: (c.item.timesWatched || 0) + 1 });
  setMode('idle');
  await flyUpAndAway(c.piece);
  setBusy(false);
  toast('Enjoy ' + c.item.name + '. Moved to Watched.');
});

/* =========================================================
   List drawer
   ========================================================= */
let tab = 'bucket';
const pendingDelete = new Map();
function fmtDate(iso){
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function renderRows(){
  const list = (tab === 'bucket' ? pool() : watchedList()).slice().sort((a, b) =>
    tab === 'bucket' ? (b.addedAt || '').localeCompare(a.addedAt || '') : (b.watchedAt || '').localeCompare(a.watchedAt || ''));
  const ul = $('rows'); ul.replaceChildren();
  if (!list.length){
    ul.append(el('li', 'rows-empty', tab === 'bucket'
      ? 'Nothing in the bucket yet. Close this and hit Add a title.'
      : 'Nothing watched yet. Pick something from the bucket and hit Watched it when you are done.'));
  }
  list.forEach(it => {
    const li = el('li', 'row');
    const top = el('div', 'row-top');
    top.append(el('span', 'row-name', it.name), el('span', 'pill micro', KIND_LABEL[it.kind]));
    if (it.rewatch && it.status === 'bucket') top.append(el('span', 'pill micro rewatch', 'Rewatch'));
    const bits = [it.platform, durationText(it), it.genres.join(', ')];
    if (tab === 'watched'){
      const when = fmtDate(it.watchedAt);
      if (when) bits.unshift('Watched ' + when + (it.timesWatched > 1 ? ' (' + it.timesWatched + ' times)' : ''));
    }
    const meta = el('div', 'row-meta', bits.filter(Boolean).join(' \u00b7 ') || 'No details added');
    const actions = el('div', 'row-actions');
    if (tab === 'bucket'){
      const w = el('button', 'primary micro', 'Mark watched'); w.type = 'button';
      w.addEventListener('click', () => {
        updateItem(it.id, { status: 'watched', rewatch: false, watchedAt: new Date().toISOString(), timesWatched: (it.timesWatched || 0) + 1 });
        eatFromBucket();
        toast(it.name + ' moved to Watched');
      });
      actions.append(w);
    } else {
      const r = el('button', 'primary micro', 'Rewatch'); r.type = 'button';
      r.addEventListener('click', () => {
        updateItem(it.id, { status: 'bucket', rewatch: true });
        dropIntoBucket();
        toast(it.name + ' is back in the bucket for a rewatch');
      });
      actions.append(r);
    }
    const del = el('button', 'micro' + (pendingDelete.has(it.id) ? ' danger' : ''), pendingDelete.has(it.id) ? 'Remove for good?' : 'Remove');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (pendingDelete.has(it.id)){
        clearTimeout(pendingDelete.get(it.id)); pendingDelete.delete(it.id);
        deleteItem(it.id);
        toast(it.name + ' removed');
      } else {
        pendingDelete.set(it.id, setTimeout(() => { pendingDelete.delete(it.id); renderRows(); }, 3500));
        renderRows();
      }
    });
    actions.append(del);
    li.append(top, meta, actions);
    ul.append(li);
  });
  $('tabBucket').setAttribute('aria-selected', tab === 'bucket' ? 'true' : 'false');
  $('tabWatched').setAttribute('aria-selected', tab === 'watched' ? 'true' : 'false');
  renderShare();
}
/* =========================================================
   Credits: social icons that fall, stack and can be thrown
   Fill in the links below. An icon with an empty href still shows, and tells the visitor it isn't set up yet.
   ========================================================= */
const SOCIAL_LINKS = [
  { id: 'instagram', label: 'Instagram', href: '' },   // 'https://instagram.com/yourhandle'
  { id: 'github',    label: 'GitHub',    href: 'https://github.com/apoorvagramle' },
  { id: 'linkedin',  label: 'LinkedIn',  href: '' },   // 'https://www.linkedin.com/in/yourname'
  { id: 'email',     label: 'Email',     href: '' },   // 'mailto:you@example.com'
];
// Icon paths from Font Awesome Free (CC BY 4.0), https://fontawesome.com
const SOCIAL_ICONS = {"github":{"w":512,"h":512,"d":"M216.5 362.5c-66-8-112.5-55.5-112.5-117 0-25 9-52 24-70-6.5-16.5-5.5-51.5 2-66 20-2.5 47 8 63 22.5 19-6 39-9 63.5-9s44.5 3 62.5 8.5c15.5-14 43-24.5 63-22 7 13.5 8 48.5 1.5 65.5 16 19 24.5 44.5 24.5 70.5 0 61.5-46.5 108-113.5 116.5 17 11 28.5 35 28.5 62.5l0 52C323 491.5 335.5 500 350.5 494 441 459.5 512 369 512 257 512 115.5 397 0 255.5 0S0 115.5 0 257c0 111 70.5 203 165.5 237.5 13.5 5 26.5-4 26.5-17.5l0-40c-7 3-16 5-24 5-33 0-52.5-18-66.5-51.5-5.5-13.5-11.5-21.5-23-23-6-.5-8-3-8-6 0-6 10-10.5 20-10.5 14.5 0 27 9 40 27.5 10 14.5 20.5 21 33 21s20.5-4.5 32-16c8.5-8.5 15-16 21-21z"},"instagram":{"w":448,"h":512,"d":"M224.3 141a115 115 0 1 0 -.6 230 115 115 0 1 0 .6-230zm-.6 40.4a74.6 74.6 0 1 1 .6 149.2 74.6 74.6 0 1 1 -.6-149.2zm93.4-45.1a26.8 26.8 0 1 1 53.6 0 26.8 26.8 0 1 1 -53.6 0zm129.7 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM399 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z"},"linkedin":{"w":448,"h":512,"d":"M100.3 448l-92.9 0 0-299.1 92.9 0 0 299.1zM53.8 108.1C24.1 108.1 0 83.5 0 53.8 0 39.5 5.7 25.9 15.8 15.8s23.8-15.8 38-15.8 27.9 5.7 38 15.8 15.8 23.8 15.8 38c0 29.7-24.1 54.3-53.8 54.3zM447.9 448l-92.7 0 0-145.6c0-34.7-.7-79.2-48.3-79.2-48.3 0-55.7 37.7-55.7 76.7l0 148.1-92.8 0 0-299.1 89.1 0 0 40.8 1.3 0c12.4-23.5 42.7-48.3 87.9-48.3 94 0 111.3 61.9 111.3 142.3l0 164.3-.1 0z"},"email":{"w":512,"h":512,"d":"M61.4 64C27.5 64 0 91.5 0 125.4 0 126.3 0 127.1 .1 128L0 128 0 384c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-256-.1 0c0-.9 .1-1.7 .1-2.6 0-33.9-27.5-61.4-61.4-61.4L61.4 64zM464 192.3L464 384c0 8.8-7.2 16-16 16L64 400c-8.8 0-16-7.2-16-16l0-191.7 154.8 117.4c31.4 23.9 74.9 23.9 106.4 0L464 192.3zM48 125.4C48 118 54 112 61.4 112l389.2 0c7.4 0 13.4 6 13.4 13.4 0 4.2-2 8.2-5.3 10.7L280.2 271.5c-14.3 10.8-34.1 10.8-48.4 0L53.3 136.1c-3.3-2.5-5.3-6.5-5.3-10.7z"}};

const toys = [];
const TOY_R = 19;
const TOY_G = 1900;
const TOY_E = 0.42;
let toyRAF = 0, toyLast = 0;
const toybox = $('toybox');

function placeToy(t){
  t.el.style.transform = 'translate(' + (t.x - TOY_R).toFixed(1) + 'px,' + (t.y - TOY_R).toFixed(1) + 'px) rotate(' + t.ang.toFixed(3) + 'rad)';
}
function buildToys(){
  toybox.replaceChildren();
  toys.length = 0;
  SOCIAL_LINKS.forEach((s) => {
    const ic = SOCIAL_ICONS[s.id];
    if (!ic) return;
    const a = document.createElement('a');
    a.className = 'toy';
    a.href = s.href || '#';
    a.title = s.label;
    a.setAttribute('aria-label', s.label);
    a.draggable = false;
    if (s.href && !s.href.startsWith('mailto:')){ a.target = '_blank'; a.rel = 'noopener'; }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + ic.w + ' ' + ic.h);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ic.d);
    svg.append(path);
    a.append(svg);
    toybox.append(a);
    const t = { el: a, link: s, x: 0, y: 0, vx: 0, vy: 0, ang: 0, drag: null, justDragged: false };
    toys.push(t);
    wireToy(t);
  });
  toybox.parentElement.hidden = toys.length === 0;
  restToys();
}
function restToys(){
  // a tidy row on the floor: the starting point, and the only state with reduced motion
  const W = toybox.clientWidth || 176, H = toybox.clientHeight || 86;
  toys.forEach((t, i) => {
    t.x = TOY_R + 4 + i * (TOY_R * 2 + 6); t.y = H - TOY_R; t.vx = 0; t.vy = 0; t.ang = 0;
    placeToy(t);
  });
}
function dropToys(){
  if (reducedMotion){ restToys(); return; }
  const W = toybox.clientWidth || 176;
  toys.forEach((t, i) => {
    t.x = TOY_R + (W - 2 * TOY_R) * (i + 0.5) / toys.length + (Math.random() - 0.5) * 10;
    t.y = -TOY_R - 30 - i * 34;
    t.vx = (Math.random() - 0.5) * 80;
    t.vy = 0;
    t.ang = (Math.random() - 0.5) * 1.2;
    placeToy(t);
  });
  wakeToys();
}
function wakeToys(){
  if (reducedMotion || toyRAF) return;
  toyLast = performance.now();
  toyRAF = requestAnimationFrame(stepToys);
}
function stepToys(now){
  const dt = Math.min(0.033, (now - toyLast) / 1000);
  toyLast = now;
  const W = toybox.clientWidth, H = toybox.clientHeight, CEIL = -150;
  const SUB = 3, h = dt / SUB;
  for (let s = 0; s < SUB; s++){
    for (const t of toys){
      if (t.drag) continue;
      t.vy += TOY_G * h;
      t.x += t.vx * h;
      t.y += t.vy * h;
      if (t.y > H - TOY_R){
        t.y = H - TOY_R;
        if (t.vy > 260 && performance.now() - (t.lastTap || 0) > 90){ Sound.tap(t.vy); t.lastTap = performance.now(); }
        if (t.vy > 0) t.vy = Math.abs(t.vy) < 60 ? 0 : -t.vy * TOY_E;
        t.vx *= Math.exp(-h * 5);
      }
      if (t.y < CEIL + TOY_R){ t.y = CEIL + TOY_R; t.vy = Math.abs(t.vy) * 0.4; }
      if (t.x < TOY_R){ t.x = TOY_R; t.vx = Math.abs(t.vx) * 0.5; }
      if (t.x > W - TOY_R){ t.x = W - TOY_R; t.vx = -Math.abs(t.vx) * 0.5; }
    }
    for (let i = 0; i < toys.length; i++){
      for (let j = i + 1; j < toys.length; j++){
        const a = toys[i], b = toys[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const overlap = TOY_R * 2 - d;
        if (overlap <= 0) continue;
        const aFixed = !!a.drag, bFixed = !!b.drag;
        if (aFixed && bFixed) continue;
        const nx = dx / d, ny = dy / d;
        const wa = aFixed ? 0 : (bFixed ? 1 : 0.5), wb = bFixed ? 0 : (aFixed ? 1 : 0.5);
        a.x -= nx * overlap * wa; a.y -= ny * overlap * wa;
        b.x += nx * overlap * wb; b.y += ny * overlap * wb;
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0){
          const imp = -(1 + TOY_E) * rv * (aFixed || bFixed ? 1 : 0.5);
          if (!aFixed){ a.vx -= imp * nx; a.vy -= imp * ny; }
          if (!bFixed){ b.vx += imp * nx; b.vy += imp * ny; }
        }
      }
    }
  }
  let moving = false;
  for (const t of toys){
    if (!t.drag) t.ang += t.vx * dt / TOY_R;
    placeToy(t);
    const resting = t.y >= H - TOY_R - 0.5 && Math.abs(t.vy) < 1 && Math.abs(t.vx) < 4;
    if (t.drag || !resting) moving = true;
  }
  toyRAF = moving ? requestAnimationFrame(stepToys) : 0;
}
function wireToy(t){
  const a = t.el;
  a.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    if (reducedMotion) return;
    const r = toybox.getBoundingClientRect();
    t.drag = { ox: e.clientX - r.left - t.x, oy: e.clientY - r.top - t.y, sx: e.clientX, sy: e.clientY, moved: false, lastT: performance.now() };
    t.vx = 0; t.vy = 0;
    try { a.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    wakeToys();
  });
  a.addEventListener('pointermove', (e) => {
    if (!t.drag) return;
    const r = toybox.getBoundingClientRect();
    const now = performance.now();
    const nx = Math.min(Math.max(e.clientX - r.left - t.drag.ox, TOY_R), r.width - TOY_R);
    const ny = Math.min(Math.max(e.clientY - r.top - t.drag.oy, -150 + TOY_R), r.height - TOY_R);
    if (!t.drag.moved && Math.hypot(e.clientX - t.drag.sx, e.clientY - t.drag.sy) > 5){
      t.drag.moved = true;
      a.classList.add('dragging');
    }
    const dtm = Math.max(8, now - t.drag.lastT) / 1000;
    t.vx = t.vx * 0.4 + ((nx - t.x) / dtm) * 0.6;
    t.vy = t.vy * 0.4 + ((ny - t.y) / dtm) * 0.6;
    t.ang += (nx - t.x) / TOY_R;
    t.x = nx; t.y = ny;
    t.drag.lastT = now;
  });
  const release = () => {
    if (!t.drag) return;
    t.justDragged = t.drag.moved;
    if (performance.now() - t.drag.lastT > 90){ t.vx = 0; t.vy = 0; }
    const cap = 1600;
    t.vx = Math.max(-cap, Math.min(cap, t.vx));
    t.vy = Math.max(-cap, Math.min(cap, t.vy));
    t.drag = null;
    a.classList.remove('dragging');
    wakeToys();
  };
  a.addEventListener('pointerup', release);
  a.addEventListener('pointercancel', release);
  a.addEventListener('click', (e) => {
    if (t.justDragged){ e.preventDefault(); t.justDragged = false; return; }
    if (!t.link.href){ e.preventDefault(); toast(t.link.label + " link isn't set up yet."); }
  });
}
buildToys();

function renderShare(){
  const online = backend === 'firebase';
  $('shareBox').hidden = !online;
  $('drawerFoot').textContent = backend === 'local' ? 'Saved in this browser only.' : '';
  if (online) $('shareLink').value = myLink();
}
$('copyLink').addEventListener('click', async () => {
  const link = myLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied. Open it on your other device.');
  } catch (e) {
    const input = $('shareLink'); input.focus(); input.select();
    toast('Press Ctrl+C or long-press to copy it.');
  }
});
let newListArmed = 0;
$('newListBtn').addEventListener('click', () => {
  const btn = $('newListBtn');
  if (!fb) return;
  if (!newListArmed){
    btn.textContent = 'Tap again to start fresh. Copy your link first if you want this list back.';
    newListArmed = setTimeout(() => { newListArmed = 0; btn.textContent = 'Start a new list'; }, 5000);
    return;
  }
  clearTimeout(newListArmed); newListArmed = 0;
  btn.textContent = 'Start a new list';
  const code = newCode();
  try { localStorage.setItem(CODE_KEY, code); } catch (e) { /* ignore */ }
  fb.code = code;
  history.replaceState(null, '', location.pathname + location.search + '#' + code);
  items = [];
  onItemsChanged();
  subscribe();
  $('qrBox').hidden = true;
  $('qrToggle').textContent = 'Show QR code for your phone';
  renderShare();
  toast('New list started. Your old list still opens from its link.');
});
$('qrToggle').addEventListener('click', () => {
  const box = $('qrBox');
  box.hidden = !box.hidden;
  $('qrToggle').textContent = box.hidden ? 'Show QR code for your phone' : 'Hide QR code';
  if (!box.hidden){
    const qr = qrcode(0, 'M');
    qr.addData(myLink());
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
});
function openDrawer(){ $('drawer').hidden = false; $('backdrop').hidden = false; renderRows(); $('drawerClose').focus({ preventScroll: true }); requestAnimationFrame(dropToys); }
function closeDrawer(){ $('drawer').hidden = true; $('backdrop').hidden = true; }
$('listBtn').addEventListener('click', openDrawer);
$('drawerClose').addEventListener('click', closeDrawer);
$('backdrop').addEventListener('click', closeDrawer);
$('tabBucket').addEventListener('click', () => { tab = 'bucket'; renderRows(); });
$('tabWatched').addEventListener('click', () => { tab = 'watched'; renderRows(); });

/* =========================================================
   Wiring
   ========================================================= */
$('addBtn').addEventListener('click', openCompose);
$('pickBtn').addEventListener('click', startPick);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
  if (mode === 'compose') closeCompose();
}));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('drawer').hidden){ closeDrawer(); return; }
  if (busy) return;
  if (mode === 'compose') closeCompose();
  else if (mode === 'result') putPickBack('idle');
});

setMode('idle');
refreshControls();
initStore();
if (window.liquidGlass){
  liquidGlass($('card'), { scale: -70, chroma: 4, blur: 6, border: 0.05 });
  liquidGlass($('dockBar'), { scale: -60, chroma: 4, blur: 4 });
  liquidGlass($('listBtn'), { scale: -40, chroma: 3, blur: 4 });
  liquidGlass($('soundBtn'), { scale: -30, chroma: 2, blur: 4 });
  liquidGlass($('toast'), { scale: -40, chroma: 3, blur: 6 });
}
