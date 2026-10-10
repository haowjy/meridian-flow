// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents as table } from "@meridian/database/schema";
import { getTableColumns, getTableName, sql } from "drizzle-orm";

const documents = [1, 2];
Array.from(documents);
`${documents} changed`;
sql`-- FROM documents
select 1 /* JOIN folders */`;
db.select().from(visibleDocuments(view));
export type Row = typeof table.$inferSelect;
eq(table.id, id);
getTableColumns(table);
getTableName(table);
function shadow(table: unknown) {
  Array.from(table);
}
shadow(documents);

function importedNameIsShadowed(table: number[]) {
  Array.from(table);
  db.select().from(table);
}
importedNameIsShadowed(documents);
sql`select 'FROM documents', '--' /* JOIN folders */`;

function hoistedLocal() {
  if (condition) {
    // biome-ignore lint/correctness/noInnerDeclarations: guard fixture proves var hoisting shadows imports.
    var table = [1];
    Array.from(table);
  }
  db.select().from(table);
}
hoistedLocal();
