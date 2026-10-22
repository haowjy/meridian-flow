// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents, folders } from "@meridian/database/schema";

db.select().from(documents); // expect: from
db.select().innerJoin(folders, condition); // expect: from
db.select().leftJoin(documents, condition); // expect: from
db.select().rightJoin(documents, condition); // expect: from
db.select().fullJoin(documents, condition); // expect: from
db.select().crossJoin(folders); // expect: from

for (const documents of []) {
  db.select().from(documents);
}
db.select().from(documents); // expect: from
