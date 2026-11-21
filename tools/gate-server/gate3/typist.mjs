// Child process: holds the 50 writers' client docs (Live and the fork), types keystroke-sized edits, sends each
// commit's update to the server over IPC in 100 ms batches. Its memory is not the server's.
import { buildChapter, keystroke, rng } from "../lib/chapter.mjs";

const ROOMS = Number(process.env.ROOMS ?? 50);
const KEYS_PER_SEC = Number(process.env.KEYS_PER_SEC ?? 5);
const r = rng(42);
const writers = [];
for (let i = 0; i < ROOMS; i++) {
  const live = buildChapter(1000 + i, String(10_000 + i));
  const fork = live.fork();
  fork.setPeerId(String(20_000 + i));
  const w = {
    i,
    live,
    fork,
    pending: { live: [], fork: [] },
    cur: { live: { block: 5, offset: 0 }, fork: { block: 8, offset: 0 } },
    target: "live",
    typingUntil: Date.now() + r() * 20000,
    pauseUntil: 0,
  };
  live.subscribeLocalUpdates((u) => w.pending.live.push(u));
  fork.subscribeLocalUpdates((u) => w.pending.fork.push(u));
  writers.push(w);
  process.send({
    t: "seed",
    room: i,
    live: live.export({ mode: "snapshot" }),
    fork: fork.export({ mode: "snapshot" }),
  });
}
process.send({ t: "seeded" });

let running = true,
  keys = 0;
process.on("message", (m) => {
  if (m.t === "stop") running = false;
});
const tick = () => {
  const now = Date.now();
  for (const w of writers) {
    if (now < w.pauseUntil) continue;
    if (now > w.typingUntil) {
      w.pauseUntil = now + 2000 + r() * 13000;
      w.typingUntil = w.pauseUntil + 5000 + r() * 25000;
      w.target = r() < 0.2 ? "fork" : "live";
      continue;
    }
    // Poisson-ish: KEYS_PER_SEC/10 keystrokes per 100 ms tick.
    let n = 0;
    const lam = KEYS_PER_SEC / 10;
    let p = Math.exp(-lam),
      s = p,
      u = r();
    while (u > s) {
      n++;
      p *= lam / n;
      s += p;
    }
    for (let k = 0; k < n; k++) keystroke(w[w.target], w.cur[w.target], r);
    keys += n;
  }
  for (const w of writers)
    for (const kind of ["live", "fork"])
      if (w.pending[kind].length) {
        process.send({ t: "upd", room: w.i, kind, updates: w.pending[kind] });
        w.pending[kind] = [];
      }
  if (running) setTimeout(tick, 100);
  else process.send({ t: "stopped", keys }, () => process.exit(0));
};
tick();
setInterval(() => process.send({ t: "keys", keys }), 10000).unref();
