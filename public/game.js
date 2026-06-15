// Echo Tag: Sonar — 3D client
import * as THREE from "three";

const socket = window.io();
const $ = (id) => document.getElementById(id);
const menu = $("menu"), lobby = $("lobby"), result = $("result");
const hud = $("hud"), touchControls = $("touchControls");
const isTouch = window.matchMedia("(pointer: coarse)").matches;

let myId = null;
let isHost = false;
let latest = null;
let world = { hx: 150, hz: 100 };

// remembered name + invite link (?room=CODE) for one-tap joins
const savedName = localStorage.getItem("echotag_name");
if (savedName) $("nameInput").value = savedName;
const inviteRoom = (new URLSearchParams(location.search).get("room") || "").toUpperCase().slice(0, 4);
if (inviteRoom) $("codeInput").value = inviteRoom;
let lastJoin = null; // {code, name} for reconnect

// ------------------------------------------------------------------- audio
let actx = null;
function initAudio() {
  if (actx) { if (actx.state === "suspended") actx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) actx = new AC();
}
function tone(freq, freq2, dur, type = "sine", gain = 0.18) {
  if (!actx) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freq2) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
const playPing = () => tone(880, 220, 0.5, "sine", 0.14);
const playWeb = () => tone(1200, 140, 0.16, "square", 0.12);
const playTag = () => { tone(420, 660, 0.12, "triangle", 0.18); setTimeout(() => tone(660, 880, 0.12, "triangle", 0.16), 70); };
function playSmooch() {
  tone(520, 1150, 0.1, "sine", 0.2);
  setTimeout(() => tone(900, 300, 0.13, "sine", 0.16), 80);
}
const playEmote = () => tone(680, 940, 0.08, "sine", 0.1);
const playHeart = (i) => tone(64, 50, 0.12, "sine", 0.06 + 0.12 * i); // tension thump
const SOUND = { ping: playPing, web: playWeb, tag: playTag, smooch: playSmooch, emote: playEmote };

// ---------------------------------------------------------------- THREE setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
$("scene").appendChild(renderer.domElement);

// per-map visual themes
const THEMES = {
  neon:  { bg: 0x05060b, ground: 0x0a0c16, grid: 0x2a3658, gridDim: 0x18203a, wall: 0x4a5f9e, fog: 0.0065 },
  void:  { bg: 0x07050d, ground: 0x0e0a18, grid: 0x3a2a58, gridDim: 0x201838, wall: 0x8a5fae, fog: 0.0072 },
  ice:   { bg: 0x050a0d, ground: 0x0a1016, grid: 0x2a4a58, gridDim: 0x183038, wall: 0x4f9eb6, fog: 0.0060 },
  amber: { bg: 0x0b0805, ground: 0x161009, grid: 0x584a2a, gridDim: 0x342a18, wall: 0xb6864f, fog: 0.0070 },
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(THEMES.neon.bg);
scene.fog = new THREE.FogExp2(THEMES.neon.bg, THEMES.neon.fog);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 120, 160);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0x223047, 0.6));
const hemi = new THREE.HemisphereLight(0x334466, 0x05060b, 0.5);
scene.add(hemi);
const selfLight = new THREE.PointLight(0x8fdfff, 1.1, 90, 1.6);
selfLight.position.set(0, 22, 0);
scene.add(selfLight);

const groundMat = new THREE.MeshStandardMaterial({ color: THEMES.neon.ground, roughness: 1, metalness: 0 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), groundMat);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

let grid = new THREE.GridHelper(2, 30, THEMES.neon.grid, THEMES.neon.gridDim);
grid.position.y = 0.05;
scene.add(grid);

const wallGroup = new THREE.Group();
scene.add(wallGroup);
const obstacleGroup = new THREE.Group();
scene.add(obstacleGroup);

let currentMapId = null;
let currentTheme = "neon";

// (re)build the entire arena from a map payload: size, theme, walls, obstacles
function applyMap(map) {
  world = { hx: map.hx, hz: map.hz };
  const th = THEMES[map.theme] || THEMES.neon;
  currentTheme = map.theme;

  scene.background.setHex(th.bg);
  scene.fog.color.setHex(th.bg);
  scene.fog.density = th.fog;
  groundMat.color.setHex(th.ground);

  ground.geometry.dispose();
  ground.geometry = new THREE.PlaneGeometry(world.hx * 2, world.hz * 2);

  scene.remove(grid);
  grid.geometry.dispose();
  grid = new THREE.GridHelper(Math.max(world.hx, world.hz) * 2, 34, th.grid, th.gridDim);
  grid.position.y = 0.05;
  scene.add(grid);

  // arena boundary walls
  wallGroup.clear();
  const h = 14;
  const wallMat = new THREE.MeshBasicMaterial({ color: th.wall, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: th.wall, transparent: true, opacity: 0.6 });
  const specs = [
    [world.hx * 2, h, 1, 0, h / 2, -world.hz], [world.hx * 2, h, 1, 0, h / 2, world.hz],
    [1, h, world.hz * 2, -world.hx, h / 2, 0], [1, h, world.hz * 2, world.hx, h / 2, 0],
  ];
  for (const [w, hh, d, x, y, z] of specs) {
    const geo = new THREE.BoxGeometry(w, hh, d);
    wallGroup.add(new THREE.Mesh(geo, wallMat).translateX(x).translateY(y).translateZ(z));
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    e.position.set(x, y, z);
    wallGroup.add(e);
  }

  // obstacles (real hiding spots)
  obstacleGroup.clear();
  const obMat = new THREE.MeshStandardMaterial({ color: th.ground, emissive: th.wall, emissiveIntensity: 0.12, roughness: 0.8 });
  const obEdge = new THREE.LineBasicMaterial({ color: th.wall, transparent: true, opacity: 0.85 });
  for (const b of map.obstacles) {
    const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
    const m = new THREE.Mesh(geo, obMat);
    m.position.set(b.x, b.h / 2, b.z);
    obstacleGroup.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), obEdge);
    e.position.set(b.x, b.h / 2, b.z);
    obstacleGroup.add(e);
  }
  currentMapId = map.id;
}

// ------------------------------------------------------- player models / pings
const playerMeshes = new Map(); // id -> { group, body, head, ring, target:{x,z}, headingTarget }
const pingMeshes = [];          // pool of { ring, dome }

// builds a limb that pivots from its top end (hip / shoulder)
function makeLimb(mat, radius, length) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), mat);
  mesh.position.y = -(length / 2 + radius); // hang below the pivot
  pivot.add(mesh);
  return pivot;
}

function makePlayer(color) {
  const c = new THREE.Color(color);
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: c, emissive: c, emissiveIntensity: 0.85, roughness: 0.5, transparent: true, opacity: 1,
  });

  // rig holds everything that bobs / leans (legs pivot from here, so the bob lifts the whole body)
  const rig = new THREE.Group();
  rig.position.y = 7; // hip height
  group.add(rig);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(2.6, 3.4, 6, 12), bodyMat);
  torso.position.y = 3;
  rig.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 16), bodyMat);
  head.position.y = 7.4;
  rig.add(head);

  // facing nub on the head so heading reads clearly
  const faceMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5, transparent: true, opacity: 1 });
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), faceMat);
  face.position.set(0, 7.6, -1.9);
  rig.add(face);

  const legL = makeLimb(bodyMat, 1.1, 4); legL.position.set(-1.4, 0, 0); rig.add(legL);
  const legR = makeLimb(bodyMat, 1.1, 4); legR.position.set(1.4, 0, 0); rig.add(legR);
  const armL = makeLimb(bodyMat, 0.8, 3.4); armL.position.set(-3, 4.6, 0); rig.add(armL);
  const armR = makeLimb(bodyMat, 0.8, 3.4); armR.position.set(3, 4.6, 0); rig.add(armR);

  // hunter ring on the ground (does not bob with the rig)
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(7, 0.6, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0xfb5555, transparent: true, opacity: 0.9 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.6;
  ring.visible = false;
  group.add(ring);

  scene.add(group);
  return {
    group, rig, head, ring, legL, legR, armL, armR,
    mats: [bodyMat, faceMat],
    target: null, headingTarget: 0,
    prevX: null, prevZ: null, speed: 0, walkAmp: 0, walkPhase: 0,
  };
}

function makePing(color) {
  const c = new THREE.Color(color);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1, 64),
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.3;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.12, wireframe: true })
  );
  scene.add(ring);
  scene.add(dome);
  return { ring, dome };
}

// web shot: a zig-zag strand ending in a classic radial spider-web splat
const webMeshes = [];
const WEB_STRAND_PTS = 14;
// a unit spider web in the XY plane: radial spokes + concentric rings
const WEB_NET_GEOM = (() => {
  const spokes = 11, rings = 4, pts = [];
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    pts.push(0, 0, 0, Math.cos(a), Math.sin(a), 0);
  }
  for (let r = 1; r <= rings; r++) {
    const rad = r / rings;
    for (let i = 0; i < spokes; i++) {
      const a1 = (i / spokes) * Math.PI * 2, a2 = ((i + 1) / spokes) * Math.PI * 2;
      // slight inward dip on each segment = spiral-web sag
      const mid = (rad - 0.06) ;
      pts.push(Math.cos(a1) * rad, Math.sin(a1) * rad, 0, Math.cos((a1 + a2) / 2) * mid, Math.sin((a1 + a2) / 2) * mid, 0);
      pts.push(Math.cos((a1 + a2) / 2) * mid, Math.sin((a1 + a2) / 2) * mid, 0, Math.cos(a2) * rad, Math.sin(a2) * rad, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
  return g;
})();
function makeWeb() {
  const sgeom = new THREE.BufferGeometry();
  sgeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(WEB_STRAND_PTS * 3), 3));
  const strand = new THREE.Line(sgeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  const net = new THREE.LineSegments(WEB_NET_GEOM, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
  scene.add(strand); scene.add(net);
  return { strand, net };
}

// smooch: a billboarded pink heart that pops up and fades
const smoochMeshes = [];
const heartTex = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const x = cv.getContext("2d");
  x.fillStyle = "#ff5d8f";
  x.font = "52px serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("♥", 32, 36);
  const t = new THREE.CanvasTexture(cv);
  return t;
})();
function makeSmooch() {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: heartTex, transparent: true, depthTest: false }));
  sp.scale.set(10, 10, 1);
  scene.add(sp);
  return sp;
}

// ---------------------------------------------- juice: shake / flash / bursts
let shakeAmt = 0;
const shake = (a) => { shakeAmt = Math.min(3, Math.max(shakeAmt, a)); };
const flashEl = $("flash"), dangerEl = $("danger");
function flash(a = 0.85) { flashEl.style.opacity = String(a); setTimeout(() => { flashEl.style.opacity = "0"; }, 40); }

const bursts = []; // expanding shockwave ring at a catch
function spawnBurst(x, z, color = "#ffffff") {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 1.5, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 1, z);
  scene.add(ring);
  bursts.push({ ring, t: 0 });
}
function updateBursts(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i]; b.t += dt;
    const s = 1 + b.t * 80;
    b.ring.scale.set(s, s, s);
    b.ring.material.opacity = Math.max(0, 0.95 - b.t * 2.4);
    if (b.t > 0.45) { scene.remove(b.ring); b.ring.geometry.dispose(); bursts.splice(i, 1); }
  }
}

// floating name label
function makeLabel(text, color) {
  const cv = document.createElement("canvas"); cv.width = 256; cv.height = 64;
  const c = cv.getContext("2d");
  c.font = "bold 36px ui-sans-serif, system-ui"; c.textAlign = "center"; c.textBaseline = "middle";
  c.lineWidth = 7; c.strokeStyle = "rgba(0,0,0,0.85)"; c.strokeText(text, 128, 34);
  c.fillStyle = color; c.fillText(text, 128, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false, depthWrite: false }));
  sp.scale.set(18, 4.5, 1);
  return sp;
}

// emote bubbles that follow a player and float up
const emoteTexCache = {};
function emoteSprite(emoji) {
  if (!emoteTexCache[emoji]) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 64;
    const c = cv.getContext("2d"); c.font = "48px serif"; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(emoji, 32, 36);
    emoteTexCache[emoji] = new THREE.CanvasTexture(cv);
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: emoteTexCache[emoji], transparent: true, depthTest: false }));
  sp.scale.set(11, 11, 1); return sp;
}
const emoteBubbles = [];
function spawnEmote(id, emoji) {
  const pm = playerMeshes.get(id); if (!pm) return;
  const sp = emoteSprite(emoji); scene.add(sp); emoteBubbles.push({ pm, sp, t: 0 });
}
function updateEmotes(dt) {
  for (let i = emoteBubbles.length - 1; i >= 0; i--) {
    const e = emoteBubbles[i]; e.t += dt;
    const p = e.pm.group.position;
    e.sp.position.set(p.x, 20 + e.t * 10, p.z);
    e.sp.material.opacity = Math.max(0, 1 - e.t / 1.6);
    if (e.t > 1.6) { scene.remove(e.sp); emoteBubbles.splice(i, 1); }
  }
}

// big animated role-reveal banner at round start
const roleBanner = $("roleBanner");
function showRoleBanner(isHunter) {
  $("roleBannerText").textContent = isHunter ? "HUNTER" : "HIDER";
  $("roleBannerSub").textContent = isHunter ? "Ping, web & tag them all" : "Stay unseen — survive the timer";
  roleBanner.className = isHunter ? "hunter" : "hider";
  void roleBanner.offsetWidth; // restart the CSS animation
  roleBanner.classList.add("show");
  setTimeout(() => roleBanner.classList.remove("show"), 2300);
}

// ------------------------------------------------------------------- menu flow
$("createBtn").onclick = () => doJoin("");
$("joinBtn").onclick = () => doJoin($("codeInput").value);
$("quickBtn").onclick = () => doJoin("", { quick: true });
$("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin($("codeInput").value); });

function doJoin(code, opts = {}) {
  initAudio();
  const name = $("nameInput").value.trim() || "Player";
  localStorage.setItem("echotag_name", name);
  socket.emit("join", { code, name }, (res) => {
    if (!res || res.error) { $("menuError").textContent = res?.error || "Could not join"; return; }
    myId = res.id;
    isHost = res.isHost;
    lastJoin = { code: res.code, name };
    $("roomCode").textContent = res.code;
    menu.classList.add("hidden");
    lobby.classList.remove("hidden");
    if (opts.quick) socket.emit("quickplay");
  });
}

$("startBtn").onclick = () => socket.emit("start");

// one-tap invite: auto-join the room from the link if we already know the player's name
if (inviteRoom && savedName) doJoin(inviteRoom);

$("copyLinkBtn").onclick = () => {
  const url = location.origin + "/?room=" + ($("roomCode").textContent || "");
  const b = $("copyLinkBtn");
  const done = () => { b.textContent = "✓ Link copied!"; b.classList.add("copied"); setTimeout(() => { b.textContent = "🔗 Copy invite link"; b.classList.remove("copied"); }, 1600); };
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done); else done();
};

$("botPlus").onclick = () => socket.emit("addBot");
$("botMinus").onclick = () => socket.emit("removeBot");

document.querySelectorAll("#emoteBar button").forEach((b) =>
  b.addEventListener("click", () => { initAudio(); socket.emit("emote", b.dataset.emote); }));

// reconnect: if the socket drops then returns mid-session, silently rejoin the same room
socket.on("connect", () => { if (lastJoin) socket.emit("join", lastJoin, (res) => { if (res && !res.error) myId = res.id; }); });

// ----------------------------------------------------- host settings panel
const MAP_LIST = [
  { id: "open", label: "Open Field" }, { id: "pillars", label: "Pillars" },
  { id: "maze", label: "The Maze" }, { id: "close", label: "Close Quarters" },
];
const SPEED_LIST = ["slow", "normal", "fast"];

// numeric sliders -> emit config (value label shown live)
const sliderValEls = {
  maxPlayers: "mpVal", roundSeconds: "rlVal", startHunters: "shVal",
  revealDuration: "rvVal", pingReach: "prVal", glowRadius: "glVal",
  pingCooldown: "cdVal", webCooldown: "wcVal",
};
function fmtSetting(key, v) { return key === "revealDuration" ? (+v).toFixed(1) : v; }
document.querySelectorAll("#hostSettings input[type=range]").forEach((sl) => {
  sl.addEventListener("input", () => {
    const key = sl.dataset.key;
    $(sliderValEls[key]).textContent = fmtSetting(key, sl.value);
    socket.emit("config", { [key]: +sl.value });
  });
});

// map buttons
const mapBtns = $("mapBtns");
for (const m of MAP_LIST) {
  const b = document.createElement("button");
  b.textContent = m.label; b.dataset.map = m.id;
  b.onclick = () => socket.emit("config", { mapId: m.id });
  mapBtns.appendChild(b);
}
// speed buttons
const speedBtns = $("speedBtns");
for (const sp of SPEED_LIST) {
  const b = document.createElement("button");
  b.textContent = sp; b.dataset.speed = sp;
  b.onclick = () => socket.emit("config", { speed: sp });
  speedBtns.appendChild(b);
}

// reflect authoritative settings into the host controls (skip the one being dragged)
function syncHostControls(s) {
  const set = s.settings;
  for (const [key, elId] of Object.entries(sliderValEls)) {
    const sl = document.querySelector(`#hostSettings input[data-key="${key}"]`);
    if (sl && document.activeElement !== sl) { sl.value = set[key]; $(elId).textContent = fmtSetting(key, set[key]); }
  }
  // starting-hunters max depends on player count
  const sh = document.querySelector('#hostSettings input[data-key="startHunters"]');
  if (sh) sh.max = Math.max(1, s.players.length - 1);
  mapBtns.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.map === set.mapId));
  speedBtns.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.speed === set.speed));
}

function renderReadonlySettings(s) {
  const set = s.settings;
  const mapName = (MAP_LIST.find((m) => m.id === set.mapId) || {}).label || set.mapId;
  $("settingsReadonly").innerHTML =
    `<div class="roHead">Game settings (set by host)</div>` +
    row("Map", mapName) + row("Max players", set.maxPlayers) + row("Round", set.roundSeconds + "s") +
    row("Starting hunters", set.startHunters) + row("Speed", set.speed) +
    row("Reveal time", (+set.revealDuration).toFixed(1) + "s") + row("Ping reach", set.pingReach) +
    row("Glow radius", set.glowRadius || "off") + row("Ping cooldown", set.pingCooldown + "s") +
    row("Web cooldown", set.webCooldown + "s");
}
function row(k, v) { return `<div class="ro"><span>${k}</span><b>${v}</b></div>`; }

// ----------------------------------------------------------------------- input
const keys = { up: false, down: false, left: false, right: false };
const keyMap = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
};
const sendInput = () => socket.emit("input", keys);
const EMOTES = ["👋", "😱", "😎", "🎯"];
window.addEventListener("keydown", (e) => {
  initAudio();
  if (e.code === "Space") { firePing(); e.preventDefault(); return; }
  if (/^Digit[1-4]$/.test(e.code) && latest?.state === "playing") { socket.emit("emote", EMOTES[+e.code.slice(5) - 1]); return; }
  const k = keyMap[e.code];
  if (k && !keys[k]) { keys[k] = true; sendInput(); }
});
window.addEventListener("keyup", (e) => {
  const k = keyMap[e.code];
  if (k && keys[k]) { keys[k] = false; sendInput(); }
});
function firePing() {
  if (latest?.me?.isHunter && latest.me.pingCd === 0) socket.emit("ping");
}
function fireWeb(dx, dz) {
  if (latest?.me?.isHunter && latest.me.webCd === 0) socket.emit("web", { dx, dz });
}
// fire a web in the direction the hunter is facing (used by touch / fallback)
function fireWebFacing() {
  const me = playerMeshes.get(myId);
  if (!me) return;
  fireWeb(Math.sin(me.group.rotation.y), -Math.cos(me.group.rotation.y));
}

// desktop: aim the web with the mouse (raycast cursor onto the ground)
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  initAudio();
  const me = playerMeshes.get(myId);
  if (!latest || latest.state !== "playing" || !me) return;
  ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.ray.intersectPlane(groundPlane, hitPoint)) {
    fireWeb(hitPoint.x - me.group.position.x, hitPoint.z - me.group.position.z);
  } else {
    fireWebFacing();
  }
});

// touch joystick
let joyId = null;
const joy = $("joystick"), stick = $("stick");
function setJoy(dx, dy) {
  const dead = 0.28, n = Math.hypot(dx, dy);
  const nx = n > 0 ? dx / n : 0, ny = n > 0 ? dy / n : 0, mag = Math.min(n / 50, 1);
  const next = {
    up: ny < -dead && mag > dead, down: ny > dead && mag > dead,
    left: nx < -dead && mag > dead, right: nx > dead && mag > dead,
  };
  if (next.up !== keys.up || next.down !== keys.down || next.left !== keys.left || next.right !== keys.right) {
    Object.assign(keys, next); sendInput();
  }
  const cm = Math.min(n, 50);
  stick.style.transform = `translate(calc(-50% + ${nx * cm}px), calc(-50% + ${ny * cm}px))`;
}
function resetJoy() {
  Object.assign(keys, { up: false, down: false, left: false, right: false });
  sendInput();
  stick.style.transform = "translate(-50%, -50%)";
}
joy.addEventListener("touchstart", (e) => {
  const t = e.changedTouches[0]; joyId = t.identifier;
  const r = joy.getBoundingClientRect();
  joy._cx = r.left + r.width / 2; joy._cy = r.top + r.height / 2;
  setJoy(t.clientX - joy._cx, t.clientY - joy._cy); e.preventDefault();
}, { passive: false });
joy.addEventListener("touchmove", (e) => {
  for (const t of e.changedTouches) if (t.identifier === joyId) setJoy(t.clientX - joy._cx, t.clientY - joy._cy);
  e.preventDefault();
}, { passive: false });
const endJoy = (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; resetJoy(); } };
joy.addEventListener("touchend", endJoy);
joy.addEventListener("touchcancel", endJoy);
$("pingBtn").addEventListener("touchstart", (e) => { initAudio(); firePing(); e.preventDefault(); }, { passive: false });
$("webBtn").addEventListener("touchstart", (e) => { initAudio(); fireWebFacing(); e.preventDefault(); }, { passive: false });

// --------------------------------------------------------------- server state
let prevState = null, prevHunter = null;
socket.on("state", (s) => {
  latest = s;
  if (s.map && s.map.id !== currentMapId) applyMap(s.map);

  // one-shot events: sound + visual juice
  for (const ev of s.events || []) {
    if (ev.type === "emote") { spawnEmote(ev.id, ev.emoji); SOUND.emote(); continue; }
    SOUND[ev.type]?.();
    if (ev.type === "tag") spawnBurst(ev.x, ev.z, "#fff1f1");
    else if (ev.type === "web") shake(0.35);
    else if (ev.type === "ping") shake(0.2);
  }

  // round just started -> big role banner
  if (s.state === "playing" && prevState !== "playing") showRoleBanner(!!s.me?.isHunter);
  // I just got caught (hider -> hunter) -> flash + heavy shake
  if (s.state === "playing" && prevHunter === false && s.me?.isHunter === true) { flash(0.8); shake(1.8); }
  prevState = s.state;
  prevHunter = s.me ? s.me.isHunter : null;

  syncEntities(s);
  renderLobby(s);
  renderHUD(s);
  renderResult(s);
});

function syncEntities(s) {
  const seen = new Set();
  for (const p of s.players) {
    seen.add(p.id);
    let pm = playerMeshes.get(p.id);
    if (!pm) { pm = makePlayer(p.color); playerMeshes.set(p.id, pm); }
    pm.isHunter = p.isHunter;
    pm.ring.visible = p.isHunter && (p.self || p.reveal > 0.05);
    pm.self = p.self;
    if (!pm.label || pm.labelName !== p.name) {
      if (pm.label) scene.remove(pm.label);
      pm.label = makeLabel(p.name, p.color); pm.labelName = p.name; scene.add(pm.label);
    }
    if (p.x !== null) {
      if (!pm.target) { pm.group.position.set(p.x, 0, p.z); } // snap on first sight
      pm.target = { x: p.x, z: p.z };
      pm.headingTarget = p.heading;
      pm.group.visible = true;
    } else {
      pm.group.visible = false; // invisible (no ping touching them)
    }
    const op = p.self ? 1 : Math.max(0, p.reveal);
    for (const m of pm.mats) m.opacity = op;
    pm.targetOpacity = op;
  }
  // remove gone players
  for (const [id, pm] of playerMeshes) {
    if (!seen.has(id)) {
      scene.remove(pm.group);
      if (pm.label) scene.remove(pm.label);
      pm.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      playerMeshes.delete(id);
    }
  }

  // pings
  const pings = s.pings || [];
  while (pingMeshes.length < pings.length) pingMeshes.push(makePing("#ffffff"));
  for (let i = 0; i < pingMeshes.length; i++) {
    const pm = pingMeshes[i];
    if (i < pings.length) {
      const pg = pings[i];
      const r = Math.max(0.5, pg.radius);
      pm.ring.position.set(pg.x, 0.3, pg.z);
      pm.ring.scale.set(r, r, r);
      pm.dome.position.set(pg.x, 0.2, pg.z);
      pm.dome.scale.set(r, r * 0.55, r);
      const fade = 1 - pg.life;
      pm.ring.material.opacity = 0.9 * fade;
      pm.dome.material.opacity = 0.14 * fade;
      pm.ring.material.color.set(pg.color);
      pm.dome.material.color.set(pg.color);
      pm.ring.visible = pm.dome.visible = true;
    } else {
      pm.ring.visible = pm.dome.visible = false;
    }
  }

  // webs (zig-zag strand + radial web splat at the tip)
  const webs = s.webs || [];
  while (webMeshes.length < webs.length) webMeshes.push(makeWeb());
  for (let i = 0; i < webMeshes.length; i++) {
    const wm = webMeshes[i];
    if (i < webs.length) {
      const w = webs[i];
      const y = 7;
      let dx = w.x1 - w.x0, dz = w.z1 - w.z0;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const px = -dz, pz = dx; // horizontal perpendicular
      const pos = wm.strand.geometry.attributes.position.array;
      const N = WEB_STRAND_PTS;
      for (let k = 0; k < N; k++) {
        const t = k / (N - 1);
        const taper = Math.sin(t * Math.PI);          // 0 at both ends
        const wob = (k % 2 ? 1 : -1) * 0.7 * taper;   // side-to-side zig-zag
        pos[k * 3] = w.x0 + dx * len * t + px * wob;
        pos[k * 3 + 1] = y + (k % 2 ? 0.45 : -0.45) * taper;
        pos[k * 3 + 2] = w.z0 + dz * len * t + pz * wob;
      }
      wm.strand.geometry.attributes.position.needsUpdate = true;
      const col = w.hit ? "#ffffff" : w.color;
      wm.strand.material.color.set(col);
      // web splat at the tip, plane facing back toward the hunter
      wm.net.position.set(w.x1, y, w.z1);
      wm.net.lookAt(w.x0, y, w.z0);
      const ns = w.hit ? 9 : 4.5;
      wm.net.scale.set(ns, ns, ns);
      wm.net.material.color.set(col);
      wm.net.material.opacity = w.hit ? 0.95 : 0.8;
      wm.strand.visible = wm.net.visible = true;
    } else {
      wm.strand.visible = wm.net.visible = false;
    }
  }

  // smooches (heart pop)
  const smooches = s.smooches || [];
  while (smoochMeshes.length < smooches.length) smoochMeshes.push(makeSmooch());
  for (let i = 0; i < smoochMeshes.length; i++) {
    const sm = smoochMeshes[i];
    if (i < smooches.length) {
      const ev = smooches[i];
      sm.position.set(ev.x, 14 + ev.life * 16, ev.z); // rises as it ages
      sm.material.opacity = Math.max(0, 1 - ev.life);
      sm.scale.setScalar(10 + ev.life * 6);
      sm.visible = true;
    } else {
      sm.visible = false;
    }
  }
}

// --------------------------------------------------------------------- UI bits
function renderLobby(s) {
  const inLobby = s.state === "lobby" || s.state === "countdown";
  lobby.classList.toggle("hidden", !inLobby);
  if (!inLobby) return;

  const list = $("playerList");
  list.innerHTML = "";
  for (const p of s.players) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}` +
      (p.id === myId ? `<span class="you">you</span>` : "") +
      (p.id === s.hostId ? `<span class="host">host</span>` : "");
    list.appendChild(li);
  }
  isHost = s.hostId === myId;

  $("hostSettings").classList.toggle("hidden", !isHost);
  $("settingsReadonly").classList.toggle("hidden", isHost);
  $("botRow").classList.toggle("hidden", !isHost);
  $("botCount").textContent = s.botCount || 0;
  if (isHost) syncHostControls(s);
  else renderReadonlySettings(s);

  const canStart = isHost && s.state === "lobby" && s.players.length >= 2;
  $("startBtn").classList.toggle("hidden", !canStart);
  if (s.state === "countdown") {
    $("waitMsg").textContent = `Starting in ${s.countdown}…`;
    $("startBtn").classList.add("hidden");
  } else if (s.players.length < 2) {
    $("waitMsg").textContent = "Waiting for at least 2 players…";
  } else {
    $("waitMsg").textContent = isHost ? "" : "Waiting for host to start…";
  }
}

function renderHUD(s) {
  const playing = s.state === "playing";
  hud.classList.toggle("hidden", !playing);
  touchControls.classList.toggle("hidden", !(playing && isTouch));
  $("emoteBar").classList.toggle("hidden", !playing);
  if (!playing) return;
  $("timer").textContent = s.timeLeft;
  const role = $("role");
  const hunter = !!s.me?.isHunter;
  if (hunter) { role.textContent = "🔴 HUNTER — ping, web & tag"; role.className = "role-hunter"; }
  else { role.textContent = "🟢 HIDER — stay unseen, survive"; role.className = "role-hider"; }

  // persistent, glanceable head-count: hiders surviving vs hunters chasing
  const left = s.hidersLeft ?? 0, total = s.totalPlayers ?? 0, hunters = total - left;
  $("counter").textContent = left > 0
    ? `🟢 ${left} hiding · 🔴 ${hunters} hunting`
    : "all caught!";

  // ability chips (desktop / always-visible status)
  $("abilities").classList.toggle("hidden", !hunter);
  if (hunter) {
    const pc = $("pingChip"), wc = $("webChip");
    const pCd = s.me.pingCd, wCd = s.me.webCd;
    pc.innerHTML = pCd > 0 ? `PING ${Math.ceil(pCd)}s` : `PING <kbd>Space</kbd>`;
    pc.className = "chip " + (pCd > 0 ? "cooling" : "ready");
    wc.innerHTML = wCd > 0 ? `WEB ${Math.ceil(wCd)}s` : `WEB <kbd>Click</kbd>`;
    wc.className = "chip " + (wCd > 0 ? "cooling" : "ready");
  }

  // mobile buttons
  const pb = $("pingBtn"), wb = $("webBtn");
  pb.classList.toggle("hidden", !hunter);
  wb.classList.toggle("hidden", !hunter);
  if (hunter) {
    pb.disabled = s.me.pingCd > 0;
    pb.textContent = s.me.pingCd > 0 ? Math.ceil(s.me.pingCd) : "PING";
    wb.disabled = s.me.webCd > 0;
    wb.textContent = s.me.webCd > 0 ? Math.ceil(s.me.webCd) : "WEB";
  }
}

let resultShownFor = null;
function renderResult(s) {
  if (s.state === "over") {
    if (resultShownFor !== s.winner) {
      resultShownFor = s.winner;
      const win = s.winner === "hiders";
      const youWon = win ? !s.me?.isHunter : s.me?.isHunter;
      $("resultTitle").textContent = win ? "🟢 Hiders survived!" : "🔴 Hunters caught everyone!";
      $("resultSub").textContent = (youWon ? "You won. " : "You lost. ") + "Back to lobby shortly…";
      result.classList.remove("hidden");
    }
  } else { result.classList.add("hidden"); resultShownFor = null; }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ----------------------------------------------------------------- render loop
const camTarget = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const camOffset = new THREE.Vector3(0, 58, 78);
let lobbyAngle = 0;
let heartTimer = 0, nowT = 0;
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  nowT += dt;

  // interpolate player positions + heading, then drive the walk cycle
  for (const pm of playerMeshes.values()) {
    if (pm.target) {
      pm.group.position.x += (pm.target.x - pm.group.position.x) * Math.min(1, dt * 12);
      pm.group.position.z += (pm.target.z - pm.group.position.z) * Math.min(1, dt * 12);
    }
    // shortest-arc heading lerp
    let d = pm.headingTarget - pm.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    pm.group.rotation.y += d * Math.min(1, dt * 10);

    // estimate ground speed from the rendered motion (smoothed)
    if (pm.prevX === null) { pm.prevX = pm.group.position.x; pm.prevZ = pm.group.position.z; }
    const inst = dt > 0 ? Math.hypot(pm.group.position.x - pm.prevX, pm.group.position.z - pm.prevZ) / dt : 0;
    pm.prevX = pm.group.position.x; pm.prevZ = pm.group.position.z;
    pm.speed += (inst - pm.speed) * Math.min(1, dt * 8);

    const moving = pm.speed > 2;
    pm.walkAmp += ((moving ? 1 : 0) - pm.walkAmp) * Math.min(1, dt * 9);
    pm.walkPhase += dt * (6 + Math.min(pm.speed, 60) * 0.16); // cadence rises a touch with speed

    const swing = Math.sin(pm.walkPhase) * 0.7 * pm.walkAmp;
    pm.legL.rotation.x = swing;
    pm.legR.rotation.x = -swing;
    pm.armL.rotation.x = -swing * 0.8;
    pm.armR.rotation.x = swing * 0.8;
    pm.rig.position.y = 7 + Math.abs(Math.sin(pm.walkPhase)) * 0.7 * pm.walkAmp;
    pm.rig.rotation.x = -0.18 * pm.walkAmp;

    // name label floats above the head, fades with visibility (not shown for self)
    if (pm.label) {
      const op = pm.self ? 0 : (pm.group.visible ? (pm.targetOpacity || 0) : 0);
      pm.label.material.opacity = op;
      pm.label.visible = op > 0.04;
      if (pm.label.visible) pm.label.position.set(pm.group.position.x, 22, pm.group.position.z);
    }
  }

  updateBursts(dt);
  updateEmotes(dt);

  const me = playerMeshes.get(myId);
  const playing = latest?.state === "playing";

  if (playing && me && me.target) {
    camDesired.copy(me.group.position).add(camOffset);
    camera.position.lerp(camDesired, Math.min(1, dt * 4));
    camTarget.lerp(me.group.position, Math.min(1, dt * 6));
    camera.lookAt(camTarget.x, 6, camTarget.z);
    selfLight.position.set(me.group.position.x, 22, me.group.position.z);
  } else {
    lobbyAngle += dt * 0.12;
    camera.position.set(Math.cos(lobbyAngle) * 210, 150, Math.sin(lobbyAngle) * 210);
    camera.lookAt(0, 0, 0);
  }

  // screen shake, applied after camera placement
  if (shakeAmt > 0.02) {
    camera.position.x += (Math.random() - 0.5) * shakeAmt * 7;
    camera.position.y += (Math.random() - 0.5) * shakeAmt * 7;
    camera.position.z += (Math.random() - 0.5) * shakeAmt * 7;
    shakeAmt *= Math.pow(0.0015, dt);
  } else shakeAmt = 0;

  // danger vignette + quickening heartbeat (the sound-off tension twin, no direction leak)
  const danger = (playing && latest?.me && !latest.me.isHunter) ? (latest.me.danger || 0) : 0;
  if (danger > 0.02) {
    const pulse = 0.6 + 0.4 * Math.sin(nowT * (6 + danger * 14));
    dangerEl.style.opacity = String((0.12 + 0.5 * danger) * pulse);
    heartTimer -= dt;
    if (heartTimer <= 0) { playHeart(danger); heartTimer = 0.95 - 0.55 * danger; }
  } else {
    dangerEl.style.opacity = "0";
  }

  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
