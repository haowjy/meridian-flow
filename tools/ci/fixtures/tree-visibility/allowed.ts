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

// Prefixes and quoted identifiers containing table names are different relations.
sql`SELECT hidden FROM "documents_archive"`;
sql`SELECT hidden FROM public.documents_view`;
sql`SELECT hidden FROM "public"."folders_archive"`;
sql`SELECT hidden FROM "documents-archive"`;
sql`UPDATE public.folders_view SET hidden = false`;
sql`INSERT INTO "folders_archive" (hidden) VALUES (false)`;
sql`DELETE FROM "public"."documents_archive" WHERE hidden = true`;
