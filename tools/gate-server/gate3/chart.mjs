// Markdown table and a Mermaid xychart of a gate 3 run's memory curve. node gate3/chart.mjs <run.jsonl> [everyMin]
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((r) => r.rss);
const every = Number(process.argv[3] ?? 5) * 60;
const typing = rows.filter((r) => r.phase === "typing" || r.phase === "seeded");
const picked = typing.filter(
  (r, i) => i === 0 || Math.floor(r.s / every) !== Math.floor(typing[i - 1].s / every),
);
const tail = rows.filter(
  (r) => r.phase !== "typing" && r.phase !== "seeded" && r.phase !== "start",
);
const lastOf = (phase) => tail.filter((r) => r.phase === phase).at(-1);
const after = [
  "stopped",
  "unloaded-half",
  "unloaded-all",
  "reloaded",
  "reloaded-read",
  "reloaded-walked",
  "unloaded-again",
]
  .map(lastOf)
  .filter(Boolean);
console.log(
  "| t (min) | phase | RSS MB | WASM MB | JS heap used MB | external MB | keystrokes | snapshot p50 ms | import p50 ms | derive p50 ms |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of [...picked, ...after])
  console.log(
    `| ${(r.s / 60).toFixed(1)} | ${r.phase} | ${r.rss} | ${r.wasm} | ${r.heapUsed} | ${r.external} | ${r.keys ?? ""} | ${r.saveP50 ?? ""} | ${r.importP50 ?? ""} | ${r.deriveP50 ?? ""} |`,
  );
const pts = typing.filter(
  (r, i) => i === 0 || Math.floor(r.s / 180) !== Math.floor(typing[i - 1].s / 180),
);
console.log(
  '\n```mermaid\nxychart-beta\n  title "Gate 3: server memory while 50 writers type (MB)"',
);
console.log(`  x-axis "minutes" [${pts.map((r) => Math.round(r.s / 60)).join(", ")}]`);
console.log(`  y-axis "MB" 0 --> ${Math.ceil(Math.max(...pts.map((r) => r.rss)) / 100) * 100}`);
console.log(`  line [${pts.map((r) => r.rss).join(", ")}]`);
console.log(`  line [${pts.map((r) => r.wasm).join(", ")}]`);
console.log("```\nUpper line: RSS. Lower line: WASM linear memory.");
