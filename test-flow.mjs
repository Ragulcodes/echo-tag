// Headless smoke test for Echo Tag: Sonar.
// Verifies: join/host, host-set cooldown, ping-only reveal, tag->infection, win flow.
import { io } from "socket.io-client";

const URL = "http://localhost:3000";
const log = (...a) => console.log("[test]", ...a);
let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.error("  ✗ FAIL:", m); } else console.log("  ✓", m); };

function mkClient(name) {
  const s = io(URL, { forceNew: true });
  const c = { s, name, last: null, id: null, code: null, isHost: false };
  s.on("state", (st) => { c.last = st; });
  return c;
}
const join = (c, code) => new Promise((res) =>
  c.s.emit("join", { code, name: c.name }, (r) => { c.id = r.id; c.code = r.code; c.isHost = r.isHost; res(r); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const selfPos = (c) => { const p = c.last?.players.find((x) => x.self); return p && p.x !== null ? p : null; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const a = mkClient("Alice");
const b = mkClient("Bob");

const r1 = await join(a, "");
assert(r1.code && r1.isHost, "host creates room and is host");
const r2 = await join(b, r1.code);
assert(r2.code === r1.code && !r2.isHost, "second player joins, not host");

await sleep(150);
assert(a.last.players.length === 2, "both players in lobby");
assert(a.last.state === "lobby", "starts in lobby");

// host sets cooldown + map + other settings
a.s.emit("config", { pingCooldown: 3 });
await sleep(120);
assert(a.last.settings.pingCooldown === 3, "host config sets ping cooldown to 3");
a.s.emit("config", { mapId: "pillars" });
await sleep(120);
assert(a.last.map.id === "pillars" && a.last.map.obstacles.length > 0, "host can switch map (obstacles present)");
a.s.emit("config", { maxPlayers: 4, roundSeconds: 60, speed: "fast", glowRadius: 30 });
await sleep(120);
assert(a.last.settings.maxPlayers === 4, "host sets max players");
assert(a.last.settings.roundSeconds === 60, "host sets round length");
assert(a.last.settings.speed === "fast", "host sets speed");
assert(a.last.settings.glowRadius === 30, "host sets glow radius");
// settings get clamped
a.s.emit("config", { pingReach: 9999, revealDuration: 99 });
await sleep(120);
assert(a.last.settings.pingReach === 280, "ping reach clamped to max");
assert(a.last.settings.revealDuration === 3, "reveal duration clamped to max");
// reset glow to 0 for the ping-only reveal test below
a.s.emit("config", { glowRadius: 0, mapId: "open" });
await sleep(120);
// non-host cannot change settings
b.s.emit("config", { pingCooldown: 11 });
await sleep(120);
assert(a.last.settings.pingCooldown === 3, "non-host cannot change settings");

// non-host cannot start
b.s.emit("start");
await sleep(150);
assert(a.last.state === "lobby", "non-host cannot start");

// host starts
a.s.emit("start");
await sleep(200);
assert(a.last.state === "countdown", "host triggers countdown");
await sleep(4500);
assert(a.last.state === "playing", "round playing");
assert(a.last.players.filter((p) => p.isHunter).length === 1, "exactly one hunter");

const hunter = a.last.players.find((p) => p.isHunter && p.id === a.id) ? a : b;
const hider = hunter === a ? b : a;
log("hunter:", hunter.name, "hider:", hider.name);

// hider stands still; hunter approaches but STOPS before tagging
hider.s.emit("input", {});
for (let i = 0; i < 50; i++) {
  const h = selfPos(hunter), v = selfPos(hider);
  if (h && v) {
    if (dist(h, v) < 42) { hunter.s.emit("input", {}); break; }
    hunter.s.emit("input", { right: v.x - h.x > 3, left: v.x - h.x < -3, up: v.z - h.z < -3, down: v.z - h.z > 3 });
  }
  await sleep(110);
}
hunter.s.emit("input", {});
await sleep(200);

// before pinging, the still hider should be INVISIBLE on the hunter's screen
const hiderOnHunterBefore = hunter.last.players.find((p) => p.id === hider.id);
assert(hiderOnHunterBefore && hiderOnHunterBefore.x === null, "still hider is invisible to hunter before ping");

// fire ping -> wave should sweep over the nearby hider and reveal them
hunter.s.emit("ping");
await sleep(120);
assert(hunter.last.me.pingCd > 2.4, "ping sets cooldown to host value (~3s)");
let revealed = false;
for (let i = 0; i < 25 && !revealed; i++) {
  const v = hunter.last.players.find((p) => p.id === hider.id);
  if (v && v.x !== null && v.reveal > 0.1) revealed = true;
  await sleep(60);
}
assert(revealed, "ping wave reveals the swept hider to the hunter");

// ping is on cooldown -> second immediate ping ignored (no new wave count growth guaranteed, but cd stays > 0)
const cdNow = hunter.last.me.pingCd;
hunter.s.emit("ping");
await sleep(100);
assert(hunter.last.me.pingCd <= cdNow && hunter.last.me.pingCd > 0, "ping respects cooldown");

// WEB grab-tag from range (no contact). Hunter is ~<42 units from the still hider.
{
  const h = selfPos(hunter), v = selfPos(hider);
  const rangeAtFire = dist(h, v);
  assert(rangeAtFire > 9, "hunter is beyond contact range before firing web");
  hunter.s.emit("web", { dx: v.x - h.x, dz: v.z - h.z });
  let webTagged = false;
  for (let i = 0; i < 30 && !webTagged; i++) {
    await sleep(60);
    if (hider.last.me.isHunter || a.last.state === "over") webTagged = true;
  }
  assert(webTagged, "web shot grabs & tags the hider from range");
}

// ---- Scenario 2: smooch (two hiders bumping) ----
const c1 = mkClient("H1"), c2 = mkClient("H2"), c3 = mkClient("H3");
const rr = await join(c1, "");
await join(c2, rr.code); await join(c3, rr.code);
await sleep(150);
c1.s.emit("config", { startHunters: 1, glowRadius: 0, mapId: "open" });
await sleep(120);
c1.s.emit("start");
await sleep(4600);
assert(c1.last.state === "playing", "scenario 2 round playing");
const hidersC = [c1, c2, c3].filter((c) => !c.last.me.isHunter);
assert(hidersC.length === 2, "two hiders present for smooch test");
const [hA, hB] = hidersC;
let smooched = false;
for (let i = 0; i < 70 && !smooched; i++) {
  const pa = selfPos(hA), pb = selfPos(hB);
  if (pa && pb) {
    hA.s.emit("input", { right: pb.x - pa.x > 2, left: pb.x - pa.x < -2, down: pb.z - pa.z > 2, up: pb.z - pa.z < -2 });
    hB.s.emit("input", { right: pa.x - pb.x > 2, left: pa.x - pb.x < -2, down: pa.z - pb.z > 2, up: pa.z - pb.z < -2 });
  }
  await sleep(85);
  if ((hA.last.smooches || []).length > 0) smooched = true;
}
hA.s.emit("input", {}); hB.s.emit("input", {});
assert(smooched, "two hiders bumping triggers a smooch (heart marker)");

log(fail ? "RESULT: FAILURES PRESENT" : "RESULT: ALL CHECKS PASSED");
[a, b, c1, c2, c3].forEach((c) => c.s.close());
process.exit(fail ? 1 : 0);
