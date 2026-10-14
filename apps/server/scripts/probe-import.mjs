/** Import a directory or loose files exclusively through ./mf api. Usage: pnpm exec tsx apps/server/scripts/probe-import.mjs PROJECT URI PATH... [--files] */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { splitFrontmatter } from "@meridian/markup/wikilinks";

const [projectId, folderUri, ...args] = process.argv.slice(2);
const loose = args.includes("--files"),
  replay = args.includes("--replay"),
  reverse = args.includes("--reverse"),
  paths = args.filter(
    (value) => value !== "--files" && value !== "--replay" && value !== "--reverse",
  );
if (!projectId || !folderUri || !paths.length)
  throw new Error(
    "Usage: pnpm exec tsx apps/server/scripts/probe-import.mjs PROJECT URI PATH... [--files]",
  );
const manifest = {
  importId: process.env.MF_IMPORT_ID ?? randomUUID(),
  destination: { folderUri },
  sort: false,
  roots: [],
  folders: [],
  entries: [],
};
const files = new Map();
for (const [rootId, source] of paths.entries()) {
  const kind = !loose && statSync(source).isDirectory() ? "folder" : "file";
  const root = { rootId, kind, name: basename(source) };
  manifest.roots.push(root);
  if (kind === "folder") {
    for (const [filename, key] of [
      [".obsidian/app.json", "appJson"],
      ["meridian-export.json", "meridianExport"],
    ]) {
      try {
        root[key] = readFileSync(join(source, filename), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    walk(source, "", rootId);
  } else add(source, "", rootId);
}
function walk(source, path, rootId) {
  for (const child of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const relative = [path, child.name].filter(Boolean).join("/"),
      full = join(source, child.name);
    if (child.isSymbolicLink()) {
      console.error("Skipped symlink", full);
      continue;
    }
    if (
      relative
        .split("/")
        .some((segment) =>
          [".obsidian", ".git", ".DS_Store", "Thumbs.db", "desktop.ini"].includes(segment),
        ) ||
      relative === "meridian-export.json"
    )
      continue;
    if (child.isDirectory()) {
      manifest.folders.push({ rootId, path: relative });
      walk(full, relative, rootId);
    } else if (child.isFile()) add(full, relative, rootId);
  }
}
function add(source, path, rootId) {
  const bytes = readFileSync(source),
    entryId = manifest.entries.length;
  const sniff = bytes.subarray(0, 512).toString("base64"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const frontmatter = splitFrontmatter(bytes.toString("utf8")).frontmatter;
  manifest.entries.push({
    entryId,
    rootId,
    path,
    size: bytes.length,
    sha256,
    sniff,
    ...(frontmatter ? { frontmatter: frontmatter.text } : {}),
  });
  files.set(entryId, source);
}
const scratch = mkdtempSync(join(tmpdir(), "mf-import-"));
function api(method, path, options = []) {
  return JSON.parse(
    execFileSync("./mf", ["api", method, path, ...options, "--timeout-ms", "180000", "--json"], {
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
    }),
  );
}
try {
  writeFileSync(join(scratch, "manifest.json"), JSON.stringify(manifest));
  const start = performance.now(),
    plan = api("POST", `/api/projects/${projectId}/imports`, [
      "--data",
      `@${join(scratch, "manifest.json")}`,
    ]);
  console.log(JSON.stringify({ phase: "plan", ms: performance.now() - start, report: plan }));
  const landingStart = performance.now();
  for (const entry of reverse ? [...plan.entries].reverse() : plan.entries) {
    if (
      entry.state !== "planned" &&
      entry.state !== "failed" &&
      !(replay && entry.state === "landed")
    )
      continue;
    const sourceEntry = manifest.entries.find(
      (source) =>
        source.path === entry.path &&
        source.size === entry.size &&
        source.sha256 === entry.sha256 &&
        manifest.roots.find((root) => root.rootId === source.rootId)?.name ===
          plan.roots.find((root) => root.rootId === entry.rootId)?.name,
    );
    if (!sourceEntry) throw new Error("Stored entry did not match selection");
    const result = api("POST", `/api/projects/${projectId}/imports/${manifest.importId}/files`, [
      "--file",
      `${entry.entryId}=@${files.get(sourceEntry.entryId)}`,
    ]);
    console.log(JSON.stringify({ phase: "land", result }));
  }
  console.log(
    JSON.stringify({
      phase: "finish",
      landingMs: performance.now() - landingStart,
      report: api("GET", `/api/projects/${projectId}/imports/${manifest.importId}`),
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
