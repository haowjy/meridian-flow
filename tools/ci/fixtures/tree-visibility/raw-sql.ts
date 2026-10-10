// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents } from "@meridian/database/schema";
import { sql } from "drizzle-orm";

sql`SELECT * FROM documents d`; // expect: raw-read
sql /* // expect: raw-read */`SELECT * JOIN
    folders f`; // expectation is on the tag, not the last line
sql`select * from ${documents}`; // expect: raw-read
sql`UPDATE folders SET name = 'folder'`; // expect: raw-write
sql.raw("DELETE FROM documents"); // expect: raw-write
