# 🔊 Echo Tag: Sonar

A real-time **3D multiplayer hide-and-seek of sound** for 2–8 friends, in the browser.

The arena is pitch black — you can't see anyone. Move freely; the only way to be seen is when a **hunter's sonar ping** sweeps over you or their **web shot** grabs you. Get tagged and you join the hunters. Hiders win if anyone survives the timer.

- **Move:** WASD / arrow keys (or the on-screen joystick on mobile)
- **Hunter — Ping:** Space (reveals nearby players, but exposes the hunter too)
- **Hunter — Web shot:** left-click to fling a web in any direction and grab a hider from range
- Bump into another hider and you make a **smooch** — a sound + heart that gives you away!

The host controls maps (obstacles, size, theme), player count, round length, starting hunters, speed, and all the visibility/cooldown knobs from the lobby.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 yourself, and share the printed **Network** link (e.g. `http://192.168.1.20:3000`) with friends on the same WiFi.

## Deploy for free (Render)

This is a stateful Node + Socket.IO app, so it needs a host that keeps a process running (not a static/serverless host).

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Blueprint** → connect the repo. It reads `render.yaml` automatically.
   - Or **New → Web Service** with build `npm install` and start `npm start`.
3. Open the `https://<your-app>.onrender.com` URL and share it — friends anywhere can join via a room code.

> The free tier sleeps after ~15 min idle (~30s to wake on the next visit). Fine for casual play.

## Tech
Node + Express + Socket.IO (authoritative 30 Hz server) · Three.js (vendored in `public/vendor/`, no build step) · vanilla ES-module client.
