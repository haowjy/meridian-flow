// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents, folders } from "@meridian/database/schema";
import { sql } from "drizzle-orm";

eq(documents.hidden, false); // expect: hidden
db.update(folders) // expect: write
  .set({ hidden: true }); // expect: hidden
sql`${documents.hidden}`; // expect: hidden

db.insert(documents) // expect: write
  .values({ hidden: true }); // expect: hidden
sql`select hidden from folders`; // expect: hidden // expect: raw-read
sql.raw("update documents set hidden = false"); // expect: hidden // expect: raw-write
