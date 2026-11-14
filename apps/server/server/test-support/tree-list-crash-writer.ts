/**
 * Child process for the tree list's kill test: admits one client update and, at the step named
 * by `STEP`, signals ready and hangs so the parent can SIGKILL it with the transaction open.
 *
 * Env: DATABASE_URL, STEP, READY_PATH, PROJECT_ID, ACCOUNT_ID, UPDATE (base64)
 */
import { writeFileSync } from "node:fs";
import { createDb } from "@meridian/database";
import { createDrizzleJournal } from "../domains/collab/adapters/drizzle-journal.js";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import { setTestHook, type TestHookPoint } from "../shared/test-hooks.js";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`tree-list-crash-writer: ${name} required`);
  return value;
};

const db = createDb(env("DATABASE_URL"), { max: 2 });
setTestHook(env("STEP") as TestHookPoint, async () => {
  writeFileSync(env("READY_PATH"), `${process.pid}\n`, "utf8");
  await new Promise(() => {
    /* hang until SIGKILL */
  });
});
const store = createDrizzleTreeListStore({ db, journal: createDrizzleJournal(db) });
await store.admit({
  list: { kind: "project", projectId: env("PROJECT_ID") },
  accountId: env("ACCOUNT_ID"),
  update: new Uint8Array(Buffer.from(env("UPDATE"), "base64")),
});
process.exit(0);
