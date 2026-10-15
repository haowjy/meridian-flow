// Syntactic guard fixture; executed by check-tree-visibility.mjs.

import { documents } from "@meridian/database";
import { sql as querySql } from "drizzle-orm";
import { alias as tableAlias } from "drizzle-orm/pg-core";
import { folders as relativeFolders } from "../../../../packages/database/src/schema/content";

const first = tableAlias(documents, "first");
const second = tableAlias(first, "second");
db.select().from(second); // expect: from
db.delete(relativeFolders); // expect: write
querySql`select * from ${relativeFolders}`; // expect: raw-read
querySql.raw("INSERT INTO documents (name) VALUES ('x')"); // expect: raw-write
