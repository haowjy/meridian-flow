/**
 * One scratch PostgreSQL database with the committed baseline, the production collab adapters
 * wired over it, and the project-level rows every model-edit probe shares. Each probe seeds its
 * own Work and documents, so the probes run in any order against one database.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type DraftId, newDraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { createDb, type Database } from "@meridian/database";
import {
  encodeEnvelope,
  freshPeerId,
  RoomDocs,
  readDocument,
  writeDocument,
} from "@meridian/document-model";
import { blocksOf, nodeOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import postgres from "postgres";
import { createPostgresDocumentRooms } from "../../../../apps/server/server/domains/collab/rooms/postgres-document-rooms.ts";
import { createNoopEventSink } from "../../../../apps/server/server/domains/observability/index.ts";
import { runInDrizzleTransaction } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import { treeSeeder } from "../../../../apps/server/server/test-support/tree-seed.ts";
import type { View } from "../../../../packages/project-tree/src/index.ts";
import {
  dropDatabaseForUrl,
  ensureDatabaseForUrl,
  isCiRunnerPostgres,
  LOCAL_DEV_POSTGRES_PORT,
} from "../../../dev/lib/dev-db.ts";
import { resolveCurrentRepoRoot } from "../../../dev/lib/dev-env.ts";
import { runMigrations } from "../../../dev/lib/migration-runner.ts";

/** Every scratch database this harness creates or accepts starts with this prefix. */
const SCRATCH_PREFIX = "lfd_probe_";

export type Harness = Awaited<ReturnType<typeof openHarness>>;

/**
 * A scratch database: created, migrated, and dropped by `drop`. It lives on a CI runner's own
 * Postgres (`DATABASE_URL`) or else the local dev one, through the shared `dev-db` helpers, which
 * refuse unsafe and reserved names and any other server.
 */
export async function createScratchDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const { DATABASE_URL } = process.env;
  const server = new URL(
    DATABASE_URL && isCiRunnerPostgres(DATABASE_URL)
      ? DATABASE_URL
      : `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}/postgres`,
  );
  server.pathname = `/${SCRATCH_PREFIX}${process.pid}_${Date.now().toString(36)}`;
  const url = server.href;
  const drop = () => dropDatabaseForUrl(url, []).then(() => undefined);
  await ensureDatabaseForUrl(url);
  try {
    await runMigrations({
      databaseUrl: url,
      migrationsDirectory: resolve(resolveCurrentRepoRoot(), "packages/database/src/migrations"),
    });
  } catch (error) {
    await drop();
    throw error;
  }
  return { url, drop };
}

/** The production adapters over `url`, with the project-level rows every probe shares. */
export async function openHarness(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!name.startsWith(SCRATCH_PREFIX))
    throw new Error(`Probes write only to a ${SCRATCH_PREFIX}* scratch database, not ${name}`);
  const db: Database = createDb(url, {
    max: 6,
    postgres: { connection: { application_name: "lfd-probe", statement_timeout: 15_000 } },
  });
  const raw = postgres(url, { max: 3, connection: { statement_timeout: 15_000 } });
  const ids = {
    user: randomUUID(),
    project: randomUUID(),
    source: randomUUID(),
  };
  await raw`insert into users(id,external_id,email) values (${ids.user},${`probe-${ids.user}`},${`probe-${ids.user}@example.invalid`})`;
  await raw`insert into projects(id,user_id,name,slug) values (${ids.project},${ids.user},'probe','probe')`;
  await raw`insert into context_sources(id,project_id,slug,scope) values (${ids.source},${ids.project},'probe','project')`;

  const seeds = treeSeeder(db);
  const schema = buildDocumentSchema();
  const shape = shapeSchemaOf(schema);
  // Read and written only inside transactions: the room is then built from the stored rows, so
  // it sees what the child process committed, and nothing stays loaded here.
  const rooms = createPostgresDocumentRooms({
    db,
    shape,
    eventSink: createNoopEventSink(),
    schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
  });
  const live = (documentId: string) => ({ kind: "live", documentId }) as const;
  const storedLive = <T,>(documentId: string, use: (docs: RoomDocs) => T | Promise<T>) =>
    runInDrizzleTransaction(db, async () => {
      const docs = await rooms.read(live(documentId), { peer: freshPeerId() });
      try {
        return await use(docs);
      } finally {
        docs.free();
      }
    });

  let documents = 0;
  return {
    url,
    db,
    raw,
    ids,

    /** A fresh Work with its active draft, and a thread bound to it. */
    async seedWork(label: string) {
      const workId = randomUUID() as WorkId;
      const draftId: DraftId = newDraftId();
      const threadId = randomUUID();
      const turnId = randomUUID();
      const [counter] = await raw<{ n: number }[]>`
        insert into project_handle_counters(project_id,kind,n) values (${ids.project},'work',1)
        on conflict (project_id,kind) do update set n=project_handle_counters.n+1 returning n`;
      const handle = `w${counter.n}`;
      await raw`insert into drafts(id,project_id,work_id,is_default,created_by) values (${draftId},${ids.project},${workId},true,${ids.user})`;
      await raw`insert into works(id,project_id,created_by_user_id,name,handle) values (${workId},${ids.project},${ids.user},${label},${handle})`;
      await raw`insert into threads(id,root_thread_id,project_id,created_by_user_id,title,kind,ai_write_mode,draft_id) values (${threadId},${threadId},${ids.project},${ids.user},${label},'primary','draft',${draftId})`;
      await raw`insert into turns(id,thread_id,position,role,origin,status) values (${turnId},${threadId},1,'assistant','assistant','complete')`;
      await raw`insert into thread_works(thread_id,work_id,project_id,is_primary) values (${threadId},${workId},${ids.project},true)`;
      return { workId, draftId, threadId, turnId, handle };
    },

    /** A live document holding one paragraph of `text`. */
    async seedDocument(
      label: string,
      text = "Base",
      /** A Work's drafted create (its tree view only) instead of a live document. */
      seed: { view?: View; actor?: string } = {},
    ) {
      documents += 1;
      const documentId = randomUUID() as DocumentId;
      await seeds.document(ids.source, `${label}-${documents}.md`, { id: documentId, ...seed });
      const docs = RoomDocs.create(shape, freshPeerId());
      try {
        const paragraph = schema.nodes.paragraph.create({ id: "p" }, schema.text(text));
        writeDocument(docs, blocksOf(schema.topNodeType.create(null, [paragraph])));
        await rooms.seed(db, live(documentId), encodeEnvelope(docs.snapshots()));
      } finally {
        docs.free();
      }
      return { documentId };
    },

    /** The text of each top-level block of the live document, as its stored rows hold it. */
    liveParagraphs: (documentId: string): Promise<string[]> =>
      storedLive(documentId, (docs) =>
        readDocument(docs).map((block) => nodeOf(schema, block).textContent),
      ),

    /** The writer types `suffix` at the end of block `index`, committed as a client's batch. */
    writerTypes: (documentId: string, index: number, suffix: string) =>
      storedLive(documentId, async (docs) => {
        const since = docs.shownVersion();
        const blocks = readDocument(docs).map((block) => nodeOf(schema, block));
        const target = blocks[index];
        if (!target) throw new Error(`the document has no block ${index}`);
        blocks[index] = target.type.create(target.attrs, schema.text(target.textContent + suffix));
        writeDocument(docs, blocksOf(schema.topNodeType.create(null, blocks)));
        await rooms.commit(
          db,
          live(documentId),
          encodeEnvelope(docs.exportSince(since)),
          "socket:writer",
        );
      }),

    async close() {
      await rooms.close();
      await db.close();
      await raw.end();
    },
  };
}

/** A one-shot gate: `wait` resolves once `open` is called. */
export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((done) => {
    open = done;
  });
  return { wait, open };
}
