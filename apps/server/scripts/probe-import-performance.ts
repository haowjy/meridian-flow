/**
 * Import plan and landing cost on a generated vault, through the production
 * composition and a real database. Not a correctness gate; records timings.
 *
 *   pnpm probe:db apps/server/scripts/probe-import-performance.ts --out <file.ndjson> \
 *     [--notes 2000] [--fixture plain|linked] [--batch 1]
 *
 * `plain` notes are identical and link-free. `linked` notes each carry a frontmatter alias
 * and wiki-links to alias, basename and path targets, so selection preparation and target
 * lookups show up. `--batch 1` lands each file through `land`; a larger batch sends that many
 * files per multipart receive, which is what the browser does. Writes one NDJSON line per phase (plan, landing progress, summary,
 * counters) to --out; counters count port calls and rows during landing.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, type } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { Hocuspocus } from "@hocuspocus/server";
import type { ImportManifest } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, projects, users, works } from "@meridian/database/schema";
import { createImportService } from "../server/domains/import/domain/import-service.js";
import { createProductionImportPorts } from "../server/domains/import/index.js";
import { createNoopEventSink } from "../server/domains/observability/index.js";
import type { ObjectStorePort } from "../server/domains/storage/index.js";
import { composeAppServices, createProductionAppPorts } from "../server/lib/compose.js";
import { runAfterDrizzleCommit } from "../server/shared/drizzle-transaction.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    notes: { type: "string", default: "2000" },
    fixture: { type: "string", default: "plain" },
    batch: { type: "string", default: "1" },
  },
});
if (!values.out) throw new Error("--out <file.ndjson> is required");
const out = values.out;
const notes = Number(values.notes);
const fixture = values.fixture;
const batch = Number(values.batch);
if (fixture !== "plain" && fixture !== "linked") throw new Error("--fixture is plain or linked");
const databaseUrl = process.env.DATABASE_URL ?? "";
assertThrowawayDatabaseForRunDbTests(databaseUrl);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");
const record = (line: Record<string, unknown>) => {
  appendFileSync(out, `${JSON.stringify(line)}\n`);
  console.info(JSON.stringify(line));
};

const db = createDb(databaseUrl, { max: 8 });
const appPorts = await createProductionAppPorts({
  db,
  eventSink: createNoopEventSink(),
  environment: { FLOW_OPENAI_API_KEY: "sk-probe-import" },
});
const app = composeAppServices(appPorts);
const hocuspocus = new Hocuspocus({
  yDocOptions: { gc: false, gcFilter: () => true },
  onStoreDocument: ({ documentName, document }) =>
    app.documentSync.storeHocuspocusDocument(documentName, document),
});
app.documentSync.bindHocuspocus(hocuspocus);

const userId = randomUUID(),
  projectId = randomUUID();
await db.insert(users).values(conformanceUserValues(userId, "import-probe"));
await db.insert(projects).values({ id: projectId, userId, name: "Probe", slug: "probe" });
await db
  .insert(works)
  .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true });
await db.insert(contextSources).values(
  (["kb", "manuscript", "unfiled"] as const).map((slug) => ({
    projectId,
    name: slug,
    slug,
    scope: "project" as const,
    isPrimary: slug === "manuscript",
  })),
);

const objects = new Map<string, Uint8Array>();
const objectStore: ObjectStorePort = {
  async put(key, bytes) {
    objects.set(key, bytes);
    return { ok: true, value: { storageUrl: key } };
  },
  async get() {
    return { ok: false, error: { code: "not_found", message: "Not found" } };
  },
  async list() {
    return { ok: true, value: { keys: [] } };
  },
  async getSignedUrl(key) {
    return { ok: true, value: key };
  },
  async delete(key) {
    objects.delete(key);
    return { ok: true, value: undefined };
  },
};
const deps = createProductionImportPorts(
  {
    db,
    collab: app.documentSync,
    contextPorts: app.contextPorts,
    catalog: appPorts.contextCatalog,
    links: app.linkScopes,
    ahead: app.linkAheadRegistry,
    objects: objectStore,
    eventSink: appPorts.eventSink,
  },
  projectId,
  userId,
);
const counters = {
  entriesLoads: 0,
  entriesRowsLoaded: 0,
  currentUriCalls: 0,
  currentUrisCalls: 0,
  currentUrisIds: 0,
  binds: 0,
  bindMs: 0,
};
const { entries: loadEntries } = deps.repository;
deps.repository.entries = async (id) => {
  const rows = await loadEntries(id);
  counters.entriesLoads++;
  counters.entriesRowsLoaded += rows.length;
  return rows;
};
const { currentUri, currentUris, bind } = deps.tree;
deps.tree.currentUri = (...args) => {
  counters.currentUriCalls++;
  return currentUri(...args);
};
deps.tree.currentUris = (ids) => {
  counters.currentUrisCalls++;
  counters.currentUrisIds += ids.files.length + ids.folders.length;
  return currentUris(ids);
};
deps.tree.bind = async (...args) => {
  const start = performance.now();
  const result = await bind(...args);
  counters.binds++;
  counters.bindMs += performance.now() - start;
  return result;
};
const chunkCreateMs: number[] = [],
  chunkLockedMs: number[] = [];
let planning = true;
const { parent, create } = deps.tree;
deps.tree.parent = async (...args) => {
  const locked = await parent(...args),
    lockedAt = performance.now();
  if (planning && locked)
    runAfterDrizzleCommit(() => chunkLockedMs.push(performance.now() - lockedAt));
  return locked;
};
deps.tree.create = async (...args) => {
  const start = performance.now();
  await create(...args);
  chunkCreateMs.push(performance.now() - start);
};

const linksPerNote = 8;
const noteBytes = (index: number) =>
  Buffer.from(
    fixture === "plain"
      ? "A generated note."
      : [
          "---",
          `aliases: [Alias ${index}]`,
          "---",
          ...Array.from({ length: linksPerNote }, (_, link) => {
            const target = (index * 7 + link * 13 + 1) % notes;
            return [`[[Alias ${target}]]`, `[[Note ${target}]]`, `[[Notes/Note ${target}.md|n]]`][
              link % 3
            ];
          }),
        ].join("\n"),
  );
const frontmatterOf = (index: number) =>
  fixture === "plain" ? undefined : `aliases: [Alias ${index}]\n`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifest: ImportManifest = {
  importId: randomUUID(),
  destination: { folderUri: "kb://" },
  roots: [{ rootId: 0, kind: "folder", name: "Benchmark" }],
  folders: [],
  entries: Array.from({ length: notes }, (_, entryId) => {
    const bytes = noteBytes(entryId);
    const frontmatter = frontmatterOf(entryId);
    return {
      entryId,
      rootId: 0,
      path: fixture === "plain" ? `Note ${entryId}.md` : `Notes/Note ${entryId}.md`,
      size: bytes.length,
      sha256: sha(bytes),
      sniff: bytes.toString("base64"),
      ...(frontmatter ? { frontmatter } : {}),
    };
  }),
};
record({
  probe: "import-performance",
  notes,
  fixture,
  batch,
  environment: { cpu: cpus()[0]?.model, cores: cpus().length, memory: totalmem(), os: type() },
});
try {
  const service = createImportService(deps),
    planStart = performance.now(),
    plan = await service.plan(projectId, userId, manifest);
  planning = false;
  const planMs = performance.now() - planStart;
  record({ phase: "plan", planMs, state: plan.state, chunkCreateMs, chunkLockedMs });
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
  const landingStart = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < notes) {
        const first = next;
        next = Math.min(notes, next + batch);
        const ids = Array.from({ length: next - first }, (_, offset) => first + offset);
        const landed =
          batch === 1
            ? [await service.land(projectId, plan.importId, first, noteBytes(first))]
            : (
                await service.receive(plan.importId, projectId, async () =>
                  ids.map((entryId) => ({ entryId, bytes: noteBytes(entryId) })),
                )
              ).entries;
        for (const entry of landed)
          if (entry.state !== "landed")
            throw new Error(`Entry ${entry.entryId} ended ${entry.state}`);
        if (Math.floor(first / 500) !== Math.floor(next / 500))
          record({ phase: "landing", entries: next, ms: performance.now() - landingStart });
      }
    }),
  );
  const landMs = performance.now() - landingStart;
  const finished = await service.status(plan.importId, projectId);
  record({ phase: "counters", ...counters, bindMs: Math.round(counters.bindMs) });
  record({ phase: "summary", planMs, landMs, perFileMs: landMs / notes, state: finished.state });
} finally {
  await app.shutdown();
  for (const room of [...hocuspocus.documents.values()]) {
    await hocuspocus.debouncer.executeNow(`onStoreDocument-${room.name}`);
    await room.saveMutex.waitForUnlock();
    await hocuspocus.unloadDocument(room);
  }
  await db.close();
}
