// Echo Tag: Sonar — authoritative game server (3D, host-configurable)
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.use(express.static(join(__dirname, "public")));

// ---- fixed tuning ----
const TICK_HZ = 30;
const BASE_SPEED = 48;       // units/sec at "normal"
const PLAYER_RADIUS = 4;
const TAG_DIST = PLAYER_RADIUS * 2;
const PING_SPEED = 95;       // wave expansion units/sec
const PING_BAND = 13;        // reveal-zone thickness at the wave edge
const LOBBY_COUNTDOWN = 4;
const GLOW_REVEAL = 0.45;    // brightness of always-on nearby glow

// web shot (hunter's ranged grab-tag)
const WEB_SPEED = 260;       // projectile units/sec
const WEB_RANGE = 135;       // max travel before it retracts
const WEB_HIT_RADIUS = 6.5;  // how close the web tip must pass a hider to grab
const WEB_DEAD = 0.6;        // seconds a landed/latched web stays drawn (the splat lingers)

// smooch (two hiders bumping)
const SMOOCH_DIST = PLAYER_RADIUS * 2 + 2;
const SMOOCH_CD = 1.6;       // seconds before the same hider can smooch again

const SPEEDS = { slow: 0.72, normal: 1, fast: 1.45 };

const DANGER_RANGE = 115;    // a hider "feels" a hunter within this (sound-off tension cue)
const BOT_NAMES = ["Nyx", "Echo", "Vesp", "Mochi", "Juno", "Rook", "Zuzu", "Pixel"];
const BOT_SENSE = 92;        // how close a bot hunter must be to start chasing a hider
const BOT_FLEE = 78;         // how close a hunter must be before a bot hider bolts

// ---- maps: each bundles size + obstacles + visual theme ----
function box(x, z, w, d, h) {
  return { x, z, w, d, h, minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}
const MAPS = {
  open: { name: "Open Field", theme: "neon", hx: 150, hz: 100, obstacles: [] },
  pillars: {
    name: "Pillars", theme: "void", hx: 145, hz: 98,
    obstacles: [
      box(-75, -50, 14, 14, 18), box(0, -50, 14, 14, 18), box(75, -50, 14, 14, 18),
      box(-75, 50, 14, 14, 18), box(0, 50, 14, 14, 18), box(75, 50, 14, 14, 18),
      box(-40, 0, 16, 16, 20), box(40, 0, 16, 16, 20),
    ],
  },
  maze: {
    name: "The Maze", theme: "ice", hx: 160, hz: 112,
    obstacles: [
      box(-55, -62, 6, 96, 17), box(55, 62, 6, 96, 17),
      box(-110, 6, 96, 6, 17), box(110, -6, 96, 6, 17),
      box(0, 0, 70, 6, 17), box(0, -55, 6, 60, 17),
    ],
  },
  close: {
    name: "Close Quarters", theme: "amber", hx: 96, hz: 66,
    obstacles: [
      box(-42, -26, 18, 18, 18), box(42, -26, 18, 18, 18),
      box(-42, 26, 18, 18, 18), box(42, 26, 18, 18, 18),
      box(0, 0, 22, 10, 18),
    ],
  },
};
const MAP_IDS = Object.keys(MAPS);

function defaultSettings() {
  return {
    mapId: "open",
    maxPlayers: 8,
    roundSeconds: 90,
    startHunters: 1,
    speed: "normal",
    pingCooldown: 6,
    webCooldown: 4,       // hunter web-shot cooldown
    revealDuration: 1.25, // seconds a swept player stays lit
    pingReach: 200,       // wave dies past this radius
    glowRadius: 0,        // always-on faint visibility radius (0 = pure darkness)
  };
}

const COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fbbf24", "#c084fc", "#fb7185", "#34d399", "#60a5fa"];
const rooms = new Map();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
  while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code, players: new Map(), state: "lobby", hostId: null,
    countdown: 0, timeLeft: 90, pings: [], webs: [], smooches: [], events: [],
    settings: defaultSettings(),
    loop: null, lastTick: Date.now(), winner: null, overTimer: 0,
  };
  rooms.set(code, room);
  return room;
}

function currentMap(room) { return MAPS[room.settings.mapId] || MAPS.open; }

function spawnPos(room) {
  const m = currentMap(room);
  for (let i = 0; i < 40; i++) {
    const x = -m.hx + 16 + Math.random() * (2 * m.hx - 32);
    const z = -m.hz + 16 + Math.random() * (2 * m.hz - 32);
    if (!insideAnyObstacle(x, z, m.obstacles, PLAYER_RADIUS + 2)) return { x, z };
  }
  return { x: 0, z: 0 };
}

function insideAnyObstacle(x, z, obstacles, pad) {
  for (const b of obstacles) {
    if (x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad) return true;
  }
  return false;
}

// push a circle out of any box it overlaps (allows sliding along walls)
function resolveCollision(p, obstacles) {
  for (const b of obstacles) {
    const cx = clamp(p.x, b.minX, b.maxX);
    const cz = clamp(p.z, b.minZ, b.maxZ);
    const dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * PLAYER_RADIUS;
        p.z = cz + (dz / d) * PLAYER_RADIUS;
      } else {
        const left = p.x - b.minX, right = b.maxX - p.x, top = p.z - b.minZ, bottom = b.maxZ - p.z;
        const m = Math.min(left, right, top, bottom);
        if (m === left) p.x = b.minX - PLAYER_RADIUS;
        else if (m === right) p.x = b.maxX + PLAYER_RADIUS;
        else if (m === top) p.z = b.minZ - PLAYER_RADIUS;
        else p.z = b.maxZ + PLAYER_RADIUS;
      }
    }
  }
}

// is the segment (x0,z0)->(x1,z1) blocked by any obstacle? (slab method, xz plane)
function lineBlocked(x0, z0, x1, z1, obstacles) {
  const dx = x1 - x0, dz = z1 - z0;
  for (const b of obstacles) {
    let tmin = 0, tmax = 1, ok = true;
    for (const [p, d, mn, mx] of [[x0, dx, b.minX, b.maxX], [z0, dz, b.minZ, b.maxZ]]) {
      if (Math.abs(d) < 1e-9) { if (p < mn || p > mx) { ok = false; break; } }
      else {
        let t1 = (mn - p) / d, t2 = (mx - p) / d;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

function addPlayer(room, socketId, name) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[room.players.size % COLORS.length];
  const pos = spawnPos(room);
  const player = {
    id: socketId, name: (name || "Player").slice(0, 14), color,
    x: pos.x, z: pos.z, heading: 0,
    input: { up: false, down: false, left: false, right: false },
    isHunter: false, reveal: 0, pingCd: 0, webCd: 0, smoochCd: 0, connected: true,
    isBot: false, aiTimer: 0, aiX: 0, aiZ: 1,
  };
  room.players.set(socketId, player);
  if (!room.hostId) room.hostId = socketId;
  return player;
}

function addBot(room) {
  if (room.players.size >= room.settings.maxPlayers) return null;
  const used = new Set([...room.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[room.players.size % COLORS.length];
  const usedNames = new Set([...room.players.values()].map((p) => p.name));
  const name = BOT_NAMES.find((n) => !usedNames.has(n)) || "Bot";
  const pos = spawnPos(room);
  const id = "bot_" + Math.random().toString(36).slice(2, 9);
  const bot = {
    id, name, color, x: pos.x, z: pos.z, heading: 0,
    input: { up: false, down: false, left: false, right: false },
    isHunter: false, reveal: 0, pingCd: 0, webCd: 0, smoochCd: 0, connected: true,
    isBot: true, aiTimer: 0, aiX: 0, aiZ: 1,
  };
  room.players.set(id, bot);
  return bot;
}

function removeBot(room) {
  for (const [id, p] of [...room.players].reverse()) {
    if (p.isBot) { room.players.delete(id); return true; }
  }
  return false;
}

// simple server-side AI: chase/ping/web as a hunter, flee as a hider, wander otherwise
function botThink(room, p, dt) {
  const map = currentMap(room);
  const others = [...room.players.values()].filter((q) => q.connected && q.id !== p.id);
  p.aiTimer -= dt;
  let dx = 0, dz = 0, acting = false;

  if (p.isHunter) {
    let target = null, td = Infinity;
    for (const q of others) {
      if (q.isHunter) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if ((d < BOT_SENSE || q.reveal > 0.1) && d < td) { td = d; target = q; }
    }
    if (target) {
      acting = true;
      dx = target.x - p.x; dz = target.z - p.z;
      if (p.pingCd <= 0 && td < room.settings.pingReach * 0.7) {
        p.pingCd = room.settings.pingCooldown; p.reveal = 1;
        room.pings.push({ x: p.x, z: p.z, t: 0, owner: p.id, color: p.color });
        room.events.push({ type: "ping", x: p.x, z: p.z });
      }
      if (p.webCd <= 0 && td < WEB_RANGE * 0.9 && td > TAG_DIST + 3 &&
          !lineBlocked(p.x, p.z, target.x, target.z, map.obstacles)) {
        const l = Math.hypot(dx, dz) || 1;
        p.webCd = room.settings.webCooldown;
        room.webs.push({ owner: p.id, tx: p.x, tz: p.z, dx: dx / l, dz: dz / l, dist: 0, hit: false, dead: 0, color: p.color });
        room.events.push({ type: "web", x: p.x, z: p.z });
      }
    }
  } else {
    let hd = Infinity, hunter = null;
    for (const q of others) if (q.isHunter) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < hd) { hd = d; hunter = q; } }
    if (hunter && hd < BOT_FLEE) { acting = true; dx = p.x - hunter.x; dz = p.z - hunter.z; }
  }

  if (!acting) {
    if (p.aiTimer <= 0) {
      p.aiTimer = 0.6 + Math.random() * 1.4;
      const a = Math.random() * Math.PI * 2;
      p.aiX = Math.cos(a); p.aiZ = Math.sin(a);
      if (Math.abs(p.x) > map.hx * 0.8) p.aiX = -Math.sign(p.x) * Math.abs(p.aiX);
      if (Math.abs(p.z) > map.hz * 0.8) p.aiZ = -Math.sign(p.z) * Math.abs(p.aiZ);
    }
    dx = p.aiX; dz = p.aiZ;
  }

  const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  const th = 0.25;
  p.input = { right: dx > th, left: dx < -th, down: dz > th, up: dz < -th };
}

function startRound(room) {
  const players = [...room.players.values()];
  if (players.length < 2) return;
  for (const p of players) {
    const pos = spawnPos(room);
    p.x = pos.x; p.z = pos.z; p.isHunter = false; p.reveal = 0;
    p.pingCd = 0; p.webCd = 0; p.smoochCd = 0;
  }
  // pick N starting hunters
  const n = clamp(room.settings.startHunters, 1, Math.max(1, players.length - 1));
  const shuffled = players.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < n; i++) shuffled[i].isHunter = true;
  room.pings = []; room.webs = []; room.smooches = []; room.events = [];
  room.timeLeft = room.settings.roundSeconds;
  room.winner = null;
  room.state = "playing";
}

function endRound(room, winner) { room.state = "over"; room.winner = winner; room.overTimer = 6; }

function tick(room, dt) {
  if (room.state === "countdown") {
    room.countdown -= dt;
    if (room.countdown <= 0) startRound(room);
    return;
  }
  if (room.state === "over") {
    room.overTimer -= dt;
    if (room.overTimer <= 0) room.state = "lobby";
    return;
  }
  if (room.state !== "playing") return;

  const map = currentMap(room);
  const obstacles = map.obstacles;
  const speed = BASE_SPEED * (SPEEDS[room.settings.speed] || 1);
  const players = [...room.players.values()];

  for (const p of players) if (p.isBot && p.connected) botThink(room, p, dt);

  for (const p of players) {
    if (!p.connected) continue;
    let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    let dz = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    const len = Math.hypot(dx, dz);
    if (len > 0) { dx /= len; dz /= len; p.heading = Math.atan2(dx, -dz); }
    // move per-axis then resolve, so players slide along walls
    p.x = clamp(p.x + dx * speed * dt, -map.hx + PLAYER_RADIUS, map.hx - PLAYER_RADIUS);
    p.z = clamp(p.z + dz * speed * dt, -map.hz + PLAYER_RADIUS, map.hz - PLAYER_RADIUS);
    resolveCollision(p, obstacles);
    if (p.pingCd > 0) p.pingCd = Math.max(0, p.pingCd - dt);
    if (p.webCd > 0) p.webCd = Math.max(0, p.webCd - dt);
    if (p.smoochCd > 0) p.smoochCd = Math.max(0, p.smoochCd - dt);
  }

  // advance pings + reveal swept players (blocked by obstacles -> real hiding spots)
  for (const ping of room.pings) ping.t += dt;
  room.pings = room.pings.filter((ping) => ping.t * PING_SPEED <= room.settings.pingReach);
  for (const p of players) p.reveal = Math.max(0, p.reveal - dt / room.settings.revealDuration);
  for (const ping of room.pings) {
    const radius = ping.t * PING_SPEED;
    for (const p of players) {
      if (!p.connected) continue;
      const d = Math.hypot(p.x - ping.x, p.z - ping.z);
      if (Math.abs(d - radius) <= PING_BAND && !lineBlocked(ping.x, ping.z, p.x, p.z, obstacles)) {
        p.reveal = 1;
      }
    }
  }

  // web shots: advance, blocked by obstacles, grab+tag the first hider hit
  for (const web of room.webs) {
    if (web.dead > 0) { web.dead -= dt; continue; }
    const step = WEB_SPEED * dt;
    const nx = web.tx + web.dx * step, nz = web.tz + web.dz * step;
    if (lineBlocked(web.tx, web.tz, nx, nz, obstacles)) { web.dead = WEB_DEAD; continue; }
    web.tx = nx; web.tz = nz; web.dist += step;
    if (web.dist >= WEB_RANGE) { web.dead = WEB_DEAD; continue; }
    for (const p of players) {
      if (!p.connected || p.isHunter || p.id === web.owner) continue;
      if (Math.hypot(p.x - web.tx, p.z - web.tz) <= WEB_HIT_RADIUS) {
        p.isHunter = true; p.reveal = 1;
        web.tx = p.x; web.tz = p.z; web.hit = true; web.dead = WEB_DEAD;
        room.events.push({ type: "tag", x: p.x, z: p.z });
        break;
      }
    }
  }
  room.webs = room.webs.filter((w) => !(w.dead < 0));

  // contact tagging -> infection
  const hunters = players.filter((p) => p.isHunter && p.connected);
  for (const h of hunters) {
    for (const v of players) {
      if (v.isHunter || !v.connected) continue;
      if (Math.hypot(h.x - v.x, h.z - v.z) <= TAG_DIST) {
        v.isHunter = true; v.reveal = 1;
        room.events.push({ type: "tag", x: v.x, z: v.z });
      }
    }
  }

  // smooch: two hiders bumping -> kiss sound + heart that reveals them to the hunter
  for (const ev of room.smooches) ev.t += dt;
  room.smooches = room.smooches.filter((ev) => ev.t < 1.0);
  const hiders = players.filter((p) => !p.isHunter && p.connected);
  for (let i = 0; i < hiders.length; i++) {
    for (let j = i + 1; j < hiders.length; j++) {
      const a = hiders[i], b = hiders[j];
      if (a.smoochCd > 0 || b.smoochCd > 0) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= SMOOCH_DIST) {
        a.smoochCd = b.smoochCd = SMOOCH_CD;
        a.reveal = b.reveal = 1;
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        room.smooches.push({ x: mx, z: mz, t: 0 });
        room.events.push({ type: "smooch", x: mx, z: mz });
      }
    }
  }

  room.timeLeft -= dt;
  const remaining = players.filter((p) => !p.isHunter && p.connected);
  if (remaining.length === 0) endRound(room, "hunters");
  else if (room.timeLeft <= 0) { room.timeLeft = 0; endRound(room, "hiders"); }
}

function mapPayload(room) {
  const m = currentMap(room);
  return {
    id: room.settings.mapId, name: m.name, theme: m.theme, hx: m.hx, hz: m.hz,
    obstacles: m.obstacles.map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d, h: b.h })),
  };
}

function snapshot(room, forId) {
  const me = room.players.get(forId);
  const map = currentMap(room);
  const glow = room.settings.glowRadius;
  const players = [];
  for (const p of room.players.values()) {
    const isSelf = p.id === forId;
    let reveal = isSelf ? 1 : p.reveal;
    // always-on glow: faintly see nearby players if line of sight is clear
    if (!isSelf && glow > 0 && me && p.x !== undefined) {
      const dist = Math.hypot(p.x - me.x, p.z - me.z);
      if (dist <= glow && !lineBlocked(me.x, me.z, p.x, p.z, map.obstacles)) {
        reveal = Math.max(reveal, GLOW_REVEAL);
      }
    }
    const shown = isSelf || reveal > 0.02;
    players.push({
      id: p.id, name: p.name, color: p.color, isHunter: p.isHunter,
      x: shown ? +p.x.toFixed(2) : null, z: shown ? +p.z.toFixed(2) : null,
      heading: shown ? +p.heading.toFixed(3) : 0,
      reveal: shown ? +reveal.toFixed(2) : 0,
      connected: p.connected, self: isSelf,
    });
  }
  // sound-off tension cue: how close is the nearest hunter (hiders only), no direction leak
  let danger = 0;
  if (me && !me.isHunter && room.state === "playing") {
    let nd = Infinity;
    for (const q of room.players.values()) {
      if (q.isHunter && q.connected) { const d = Math.hypot(q.x - me.x, q.z - me.z); if (d < nd) nd = d; }
    }
    if (nd < DANGER_RANGE) danger = +(1 - nd / DANGER_RANGE).toFixed(2);
  }
  const conn = [...room.players.values()].filter((p) => p.connected);
  return {
    state: room.state, code: room.code,
    timeLeft: Math.ceil(room.timeLeft), countdown: Math.ceil(room.countdown),
    winner: room.winner, hostId: room.hostId,
    settings: room.settings, map: mapPayload(room),
    hidersLeft: conn.filter((p) => !p.isHunter).length,
    totalPlayers: conn.length,
    botCount: conn.filter((p) => p.isBot).length,
    me: me ? { isHunter: me.isHunter, pingCd: +me.pingCd.toFixed(1), webCd: +me.webCd.toFixed(1), danger } : null,
    players,
    pings: room.pings.map((ping) => ({
      x: +ping.x.toFixed(1), z: +ping.z.toFixed(1),
      radius: +(ping.t * PING_SPEED).toFixed(1),
      life: +Math.min(1, (ping.t * PING_SPEED) / room.settings.pingReach).toFixed(3),
      color: ping.color,
    })),
    webs: room.webs.map((w) => {
      const o = room.players.get(w.owner);
      return {
        x0: +((o ? o.x : w.tx)).toFixed(1), z0: +((o ? o.z : w.tz)).toFixed(1),
        x1: +w.tx.toFixed(1), z1: +w.tz.toFixed(1), color: w.color, hit: w.hit,
      };
    }),
    smooches: room.smooches.map((ev) => ({ x: +ev.x.toFixed(1), z: +ev.z.toFixed(1), life: +ev.t.toFixed(2) })),
    events: room.events,
  };
}

function ensureLoop(room) {
  if (room.loop) return;
  room.lastTick = Date.now();
  room.loop = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - room.lastTick) / 1000);
    room.lastTick = now;
    tick(room, dt);
    for (const p of room.players.values()) if (!p.isBot) io.to(p.id).emit("state", snapshot(room, p.id));
    room.events = []; // one-shot events delivered; clear for next tick
    // tear the room down once no humans remain (bots alone don't keep it alive)
    const humans = [...room.players.values()].filter((p) => !p.isBot).length;
    if (humans === 0) { clearInterval(room.loop); room.loop = null; rooms.delete(room.code); }
  }, 1000 / TICK_HZ);
}

function applyConfig(room, c) {
  const s = room.settings;
  if (typeof c.mapId === "string" && MAPS[c.mapId]) s.mapId = c.mapId;
  if (Number.isFinite(c.maxPlayers)) s.maxPlayers = clamp(Math.round(c.maxPlayers), Math.max(2, room.players.size), 8);
  if (Number.isFinite(c.roundSeconds)) s.roundSeconds = clamp(Math.round(c.roundSeconds), 30, 180);
  if (Number.isFinite(c.startHunters)) s.startHunters = clamp(Math.round(c.startHunters), 1, 6);
  if (typeof c.speed === "string" && SPEEDS[c.speed]) s.speed = c.speed;
  if (Number.isFinite(c.pingCooldown)) s.pingCooldown = clamp(Math.round(c.pingCooldown), 2, 12);
  if (Number.isFinite(c.webCooldown)) s.webCooldown = clamp(Math.round(c.webCooldown), 2, 10);
  if (Number.isFinite(c.revealDuration)) s.revealDuration = clamp(+c.revealDuration, 0.4, 3);
  if (Number.isFinite(c.pingReach)) s.pingReach = clamp(Math.round(c.pingReach), 80, 280);
  if (Number.isFinite(c.glowRadius)) s.glowRadius = clamp(Math.round(c.glowRadius), 0, 70);
}

io.on("connection", (socket) => {
  let roomCode = null;

  socket.on("join", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    let room;
    if (code) {
      room = rooms.get(code);
      if (!room) return cb && cb({ error: "Room not found" });
      if (room.players.size >= room.settings.maxPlayers) return cb && cb({ error: "Room is full" });
    } else {
      room = createRoom(makeRoomCode());
    }
    roomCode = room.code;
    socket.join(room.code);
    const player = addPlayer(room, socket.id, name);
    ensureLoop(room);
    cb && cb({ code: room.code, id: socket.id, isHost: room.hostId === socket.id, color: player.color });
  });

  socket.on("config", (c) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.state !== "lobby" || !c) return;
    applyConfig(room, c);
  });

  socket.on("start", () => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== "lobby" || room.players.size < 2) return;
    room.state = "countdown";
    room.countdown = LOBBY_COUNTDOWN;
  });

  // instant match: fill with bots and start right away
  socket.on("quickplay", () => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    while (room.players.size < 4) if (!addBot(room)) break;
    if (room.players.size >= 2) { room.state = "countdown"; room.countdown = LOBBY_COUNTDOWN; }
  });

  socket.on("addBot", () => {
    const room = rooms.get(roomCode);
    if (room && room.hostId === socket.id && room.state === "lobby") addBot(room);
  });
  socket.on("removeBot", () => {
    const room = rooms.get(roomCode);
    if (room && room.hostId === socket.id && room.state === "lobby") removeBot(room);
  });

  socket.on("emote", (e) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const emoji = (typeof e === "string" ? e : (e && e.emoji) || "").slice(0, 4);
    if (emoji) room.events.push({ type: "emote", id: p.id, emoji });
  });

  socket.on("input", (input) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input = { up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right };
  });

  socket.on("ping", () => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p || !p.isHunter || p.pingCd > 0) return;
    p.pingCd = room.settings.pingCooldown;
    p.reveal = 1;
    room.pings.push({ x: p.x, z: p.z, t: 0, owner: p.id, color: p.color });
    room.events.push({ type: "ping", x: p.x, z: p.z });
  });

  socket.on("web", (aim) => {
    const room = rooms.get(roomCode);
    if (!room || room.state !== "playing" || !aim) return;
    const p = room.players.get(socket.id);
    if (!p || !p.isHunter || p.webCd > 0) return;
    let dx = +aim.dx || 0, dz = +aim.dz || 0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) { dx = Math.sin(p.heading); dz = -Math.cos(p.heading); }
    else { dx /= len; dz /= len; }
    p.webCd = room.settings.webCooldown;
    room.webs.push({ owner: p.id, tx: p.x, tz: p.z, dx, dz, dist: 0, hit: false, dead: 0, color: p.color });
    room.events.push({ type: "web", x: p.x, z: p.z });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value || null;
    if (room.state === "playing" && room.players.size < 2) endRound(room, "hiders");
  });
});

function localIPs() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces()))
    for (const net of iface || []) if (net.family === "IPv4" && !net.internal) ips.push(net.address);
  return ips;
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n  🔊  Echo Tag: Sonar running!\n`);
  console.log(`     Local:    http://localhost:${PORT}`);
  for (const ip of localIPs()) console.log(`     Network:  http://${ip}:${PORT}   <- share with friends on the same WiFi`);
  console.log("");
});
