// Merge the chunk summaries of run-gate.sh: node merge.mjs <dir>
import { readdirSync, readFileSync } from "node:fs";

const dir = process.argv[2];
const runs = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".out"))) {
  const line = readFileSync(`${dir}/${f}`, "utf8")
    .split("\n")
    .find((l) => l.startsWith("SUMMARY "));
  if (!line) continue;
  const j = JSON.parse(line.slice(8));
  const name = f.replace(/\.(\d+\.)?out$/, "");
  runs[name] ??= {
    name,
    binding: j.binding,
    approach: j.approach,
    undo: j.undo,
    reshare: j.reshare,
    n: 0,
    ok: 0,
    fails: {},
    seeds: {},
    totals: {},
    routes: {},
    ms: 0,
  };
  const r = runs[name];
  r.n += j.n;
  r.ok += j.ok;
  r.ms = Math.max(r.ms, j.ms);
  for (const [k, v] of Object.entries(j.fails)) r.fails[k] = (r.fails[k] ?? 0) + v;
  for (const [k, v] of Object.entries(j.firstSeeds)) {
    r.seeds[k] ??= [];
    r.seeds[k].push(...v);
  }
  for (const [k, v] of Object.entries(j.totals)) r.totals[k] = (r.totals[k] ?? 0) + v;
  for (const [k, v] of Object.entries(j.routes)) {
    r.routes[k] ??= {};
    const x = r.routes[k];
    for (const [kk, vv] of Object.entries(v)) x[kk] = (x[kk] ?? 0) + vv;
  }
}
for (const r of Object.values(runs).sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(
    `\n## ${r.name}: ${r.ok}/${r.n} pass  (binding ${r.binding.split("/").pop()}, approach ${r.approach}, undo ${r.undo}, reshare ${r.reshare}, wall ${Math.round(r.ms / 1000)} s per chunk)`,
  );
  for (const [k, v] of Object.entries(r.fails).sort((a, b) => b[1] - a[1]))
    console.log(
      `  ${String(v).padStart(4)}  ${k.padEnd(34)} seeds ${r.seeds[k]
        .sort((a, b) => a - b)
        .slice(0, 4)
        .join(", ")}`,
    );
  console.log(
    `  steps: ${Object.entries(r.totals)
      .filter(([k]) => !k.startsWith("staleLost"))
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  const lost = Object.entries(r.totals).filter(([k]) => k.startsWith("staleLost"));
  if (lost.length)
    console.log(`  stale typing lost: ${lost.map(([k, v]) => `${k.slice(10)} ${v}`).join(", ")}`);
  for (const [k, v] of Object.entries(r.routes)) {
    if (k === "restore-as-written")
      console.log(
        `  Restore before as written: ${v.ok}/${v.n} equal the expected draft; with a Live edit after the turn ${v.okLiveSince}/${v.nLiveSince}`,
      );
    else
      console.log(
        `  stale tab, ${k}: ${v.n} reconnects; discarded text back in ${v.withBack} (${v.back} words); typing kept ${v.kept}/${v.typed}`,
      );
  }
}
