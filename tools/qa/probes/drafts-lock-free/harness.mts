/**
 * Shared harness for the lock-free drafts probes (decision D21): one scratch PostgreSQL database
 * with the committed migration chain, the production collab and Work adapters wired over it, and
 * the fixtures and interleaving helpers the probes share. Each probe seeds its own Work, draft and
 * documents, so the probes run in any order against one database.
 */
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { createDb, type Database } from "@meridian/database";
import postgres from "postgres";
import * as Y from "yjs";
import { createDrizzleWorkDraftPendingStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-branch-push.ts";
import {
  type AppendCommitted,
  createDrizzleBranchStore,
} from "../../../../apps/server/server/domains/collab/adapters/drizzle-branches.ts";
import { createDrizzleDraftStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-drafts.ts";
import { createDrizzleCollabPersistence } from "../../../../apps/server/server/domains/collab/adapters/drizzle-journal.ts";
import { createBranchCoordinator } from "../../../../apps/server/server/domains/collab/domain/branch-coordinator.ts";
import { materializeBranchRead } from "../../../../apps/server/server/domains/collab/domain/branch-store.ts";
import { createWorkProjectionMutation } from "../../../../apps/server/server/domains/projects/adapters/work-projection-mutation.ts";
import { createDrizzleWorkRepository } from "../../../../apps/server/server/domains/projects/adapters/work-repository/drizzle.ts";
import { runInDrizzleSavepoint } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import {
  dropDatabaseForUrl,
  ensureDatabaseForUrl,
  LOCAL_DEV_POSTGRES_PORT,
} from "../../../dev/lib/dev-db.ts";
import { resolveCurrentRepoRoot } from "../../../dev/lib/dev-env.ts";
import { runMigrations } from "../../../dev/lib/migration-runner.ts";

export { Y };

/** Every scratch database this harness creates or accepts starts with this prefix. */
export const SCRATCH_PREFIX = "lfd_probe_";
/** Probe connections carry this name, so a probe can find the ones waiting on a lock. */
export const APPLICATION_NAME = "lfd-probe";

export type Probe = {
  name: string;
  /** The decision the probe guards, as the decision log names it. */
  decision: string;
  /** What a passing run shows, in one sentence. */
  expected: string;
  run(harness: Harness): Promise<void>;
};

export type Harness = Awaited<ReturnType<typeof openHarness>>;

/** A scratch database on the local dev Postgres: created, migrated, and dropped by `drop`. */
export async function createScratchDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `${SCRATCH_PREFIX}${process.pid}_${Date.now().toString(36)}`;
  const url = `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}/${name}`;
  await ensureDatabaseForUrl(url);
  // The migration chain's PostgreSQL notices (identifier truncation, skipped drops) are noise here.
  const log = console.log;
  console.log = () => {};
  try {
    await runMigrations({
      databaseUrl: url,
      migrationsDirectory: resolve(resolveCurrentRepoRoot(), "packages/database/src/migrations"),
    });
  } finally {
    console.log = log;
  }
  return { url, drop: () => dropDatabaseForUrl(url, []).then(() => undefined) };
}

/** The production adapters over `url`, with the project-level rows every probe shares. */
export async function openHarness(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!name.startsWith(SCRATCH_PREFIX))
    throw new Error(`Probes write only to a ${SCRATCH_PREFIX}* scratch database, not ${name}`);
  const db: Database = createDb(url, {
    max: 6,
    postgres: {
      connection: { application_name: APPLICATION_NAME, statement_timeout: 15_000 },
    },
  });
  const raw = postgres(url, { max: 3, connection: { statement_timeout: 15_000 } });
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    source: randomUUID(),
  };
  await raw`insert into users(id,external_id,email) values (${ids.user},${`probe-${ids.user}`},${`probe-${ids.user}@example.invalid`})`;
  await raw`insert into projects(id,user_id,name,slug) values (${ids.project},${ids.user},'probe','probe')`;
  await raw`insert into context_sources(id,project_id,name,slug,scope,is_primary) values (${ids.source},${ids.project},'probe','probe','project',true)`;

  const pending = createDrizzleWorkDraftPendingStore(db);
  const projection = createWorkProjectionMutation({
    db,
    availability: { advance: async () => "0" },
    catalog: { refreshProject: async () => {}, upsertWorkAuthorities: async () => {} },
    pendingCounts: pending,
  });
  const drafts = createDrizzleDraftStore(db);
  const persistence = createDrizzleCollabPersistence(db);
  /** Every committed append's sequence-point timing, in commit order. */
  const appends: AppendCommitted[] = [];
  const store = createDrizzleBranchStore(db, {
    workProjection: projection,
    drafts,
    live: persistence,
    onAppendSequenced: (detail) => appends.push(detail),
  });
  const attemptScope = <T,>(operation: () => Promise<T>) => runInDrizzleSavepoint(db, operation);
  const coordinator = createBranchCoordinator({ onAppendCommitted: () => {}, store, attemptScope });
  // The real Work lifecycle writer. Its file-access and Scratch ports are inert: the probes
  // observe the Work row, its branch fences and the locks, not access or Scratch publication.
  const works = createDrizzleWorkRepository({
    db,
    projectionMutation: projection,
    fileAccessChanges: { publish: async () => {} },
    lineageScratch: {} as never,
  });

  let documents = 0;
  return {
    url,
    db,
    raw,
    ids,
    projection,
    drafts,
    persistence,
    store,
    appends,
    attemptScope,
    coordinator,
    works,

    /** A fresh Work with its active draft, and a thread bound to it. */
    async seedWork(label: string) {
      const workId = randomUUID() as WorkId;
      const draftId = randomUUID() as DraftId;
      const threadId = randomUUID();
      const turnId = randomUUID();
      const slug = `${label}-${workId.slice(0, 8)}`;
      await raw`insert into works(id,project_id,created_by_user_id,name,slug) values (${workId},${ids.project},${ids.user},${label},${slug})`;
      await raw`insert into drafts(id,project_id,origin_work_id,created_by) values (${draftId},${ids.project},${workId},${ids.user})`;
      await raw`insert into threads(id,root_thread_id,project_id,created_by_user_id,title,kind,status,ai_write_mode) values (${threadId},${threadId},${ids.project},${ids.user},${label},'primary','idle','draft')`;
      await raw`insert into turns(id,thread_id,position,role,origin,status) values (${turnId},${threadId},1,'assistant','assistant','complete')`;
      await raw`insert into thread_works(thread_id,work_id,project_id,is_primary) values (${threadId},${workId},${ids.project},true)`;
      return { workId, draftId, threadId, turnId };
    },

    /** A live document holding one paragraph of `text`; the caller owns the returned doc. */
    async seedDocument(label: string, text = "Base") {
      documents += 1;
      const documentId = randomUUID() as DocumentId;
      await raw`insert into documents(id,context_source_id,name) values (${documentId},${ids.source},${`${label}-${documents}.md`})`;
      const live = paragraphDoc(text);
      await persistence.lifecycle.seedInitialDocument(documentId, Y.encodeStateAsUpdate(live));
      return { documentId, live };
    },

    async workArchived(workId: string): Promise<boolean> {
      const [row] =
        await raw`select archived_at is not null as archived from works where id=${workId}`;
      return Boolean(row?.archived);
    },

    /** The branch's durable state through the production one-statement read. */
    async readBranch(branchId: string) {
      const read = await store.readBranchAt(branchId);
      if (!read) throw new Error(`Branch ${branchId} is missing`);
      const doc = materializeBranchRead(read);
      try {
        return {
          lifecycle: read.branch.lifecycle,
          revision: read.branch.revision,
          checkpointRevision: read.branch.checkpointRevision,
          generation: read.branch.generation,
          tail: read.tail.length,
          text: doc.getXmlFragment("prosemirror").toString(),
        };
      } finally {
        doc.destroy();
      }
    },

    /** The live document's text as its journal holds it. */
    async liveText(documentId: string): Promise<string> {
      const doc = await liveDoc(documentId);
      try {
        return doc.getXmlFragment("prosemirror").toString();
      } finally {
        doc.destroy();
      }
    },

    liveDoc,

    /**
     * Probe connections waiting on a lock, polled until one appears: the observation that an
     * operation is held off by another's lock rather than racing past it.
     */
    async waitForLockWaiter(match: RegExp, timeoutMs = 5_000): Promise<string[]> {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const rows = await raw<{ query: string }[]>`
          select query from pg_stat_activity
          where datname = current_database() and application_name = ${APPLICATION_NAME}
            and wait_event_type = 'Lock'`;
        const waiting = rows.map((row) => row.query).filter((query) => match.test(query));
        if (waiting.length) return waiting.map((query) => query.slice(0, 80));
        await new Promise((done) => setTimeout(done, 5));
      }
      throw new Error(`No probe connection waited on a lock matching ${match}`);
    },

    async close() {
      await db.close();
      await raw.end();
    },
  };

  async function liveDoc(documentId: string): Promise<Y.Doc> {
    const snapshot = await persistence.journal.read(documentId);
    const doc = new Y.Doc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }
}

/** A collab document holding one paragraph of `text`. */
export function paragraphDoc(text: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  return doc;
}

/** `doc`'s first paragraph with `suffix` appended, as an update from a fresh client. */
export function appendToFirstParagraph(doc: Y.Doc, suffix: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  text.insert(text.length, suffix);
  return Y.encodeStateAsUpdate(doc, before);
}

/** A one-shot gate: `wait` resolves once `open` is called. */
export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((done) => {
    open = done;
  });
  return { wait, open };
}

/** The root async context, captured at load: no transaction, grant or attempt scope is bound. */
const rootContext = new AsyncResource("lfd-probe-independent");

/**
 * Runs `operation` as another caller would: on its own connection, outside every ambient
 * transaction, the edit grants bound to the current call and any attempt's commit scope.
 */
export function independently<T>(operation: () => T): T {
  return rootContext.runInAsyncScope(operation);
}

/** A promise's settlement as a value, its error's code included (Drizzle wraps it in `cause`). */
export async function settled<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; name: string; code?: string; message: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (cause) {
    const error = cause as Error & { code?: string; cause?: { code?: string } };
    return {
      ok: false,
      name: error.name,
      ...((error.code ?? error.cause?.code) ? { code: error.code ?? error.cause?.code } : {}),
      message: error.message.split("\n")[0] ?? "",
    };
  }
}

/** One labelled observation line, the shape every probe prints. */
export function observe(label: string, value: unknown): void {
  console.log(`  ${label}: ${JSON.stringify(value)}`);
}
