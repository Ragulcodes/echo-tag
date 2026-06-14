// Dev-only bot: joins a room and wanders so a round can start for visual testing.
import { io } from "socket.io-client";
const code = process.argv[2] || "";
const url = process.argv[3] || process.env.GAME_URL || "http://localhost:3000";
const s = io(url, { forceNew: true });
s.emit("join", { code, name: "Bot" }, (r) => console.log("bot joined", r.code, "id", r.id));
const dirs = [{ up: true }, { right: true }, { down: true }, { left: true }, { up: true, right: true }];
let i = 0;
let amHunter = false;
setInterval(() => { s.emit("input", dirs[i++ % dirs.length]); }, 700);
setInterval(() => { if (amHunter) s.emit("ping"); }, 1000);
setInterval(() => {
  if (!amHunter) return;
  const a = Math.random() * Math.PI * 2;
  s.emit("web", { dx: Math.cos(a), dz: Math.sin(a) });
}, 1300);
s.on("state", (st) => {
  amHunter = !!st.me?.isHunter;
  if (st.state === "over") process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
