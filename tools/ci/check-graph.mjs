#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const graphDir = mkdtempSync(join(tmpdir(), "meridian-nx-graph-"));
const graphPath = join(graphDir, "graph.json");

execFileSync("pnpm", ["nx", "graph", `--file=${graphPath}`], {
  stdio: ["ignore", "pipe", "inherit"],
});

const graphPayload = JSON.parse(readFileSync(graphPath, "utf8"));
const graph = graphPayload?.graph ?? { nodes: {}, dependencies: {} };
const nodes = Object.keys(graph.nodes ?? {});

if (nodes.length === 0) {
  console.log("Nx graph check skipped: no projects discovered yet.");
  process.exit(0);
}

const adjacency = new Map(nodes.map((node) => [node, []]));
for (const [source, edges] of Object.entries(graph.dependencies ?? {})) {
  const targets = (edges ?? [])
    .map((edge) => edge.target)
    .filter((target) => adjacency.has(target));

  if (adjacency.has(source)) {
    adjacency.set(source, targets);
  }
}

const state = new Map();
const stack = [];
const cycles = [];

function visit(node) {
  state.set(node, "visiting");
  stack.push(node);

  for (const next of adjacency.get(node) ?? []) {
    const nodeState = state.get(next);
    if (nodeState === "visiting") {
      const start = stack.indexOf(next);
      cycles.push([...stack.slice(start), next]);
      continue;
    }

    if (nodeState === undefined) {
      visit(next);
    }
  }

  stack.pop();
  state.set(node, "visited");
}

for (const node of nodes) {
  if (!state.has(node)) {
    visit(node);
  }
}

if (cycles.length > 0) {
  console.error("Dependency cycles detected in Nx graph:");
  for (const cycle of cycles) {
    console.error(`- ${cycle.join(" -> ")}`);
  }
  process.exit(1);
}

console.log(`Nx graph check passed (${nodes.length} projects, no cycles).`);
