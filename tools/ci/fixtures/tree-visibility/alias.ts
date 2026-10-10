// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents } from "@meridian/database/schema";
import { alias } from "drizzle-orm/pg-core";

const d = alias(documents, "d");
db.select().from(d); // expect: from
