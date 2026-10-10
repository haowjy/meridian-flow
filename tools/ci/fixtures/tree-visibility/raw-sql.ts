// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents } from "@meridian/database/schema";
import { sql } from "drizzle-orm";

sql`SELECT * FROM documents d`; // expect: raw-read
sql /* // expect: raw-read */`SELECT * JOIN
    folders f`; // expectation is on the tag, not the last line
sql`select * from ${documents}`; // expect: raw-read
sql`UPDATE folders SET name = 'folder'`; // expect: raw-write
sql.raw("DELETE FROM documents"); // expect: raw-write

// Quoted and qualified relations remain behind the same boundary.
sql`SELECT hidden FROM "documents"`; // expect: raw-read // expect: hidden
sql`SELECT * FROM other JOIN "documents" ON hidden = false`; // expect: raw-read // expect: hidden
sql`UPDATE "documents" SET hidden = false`; // expect: raw-write // expect: hidden
sql`INSERT INTO "documents" (hidden) VALUES (false)`; // expect: raw-write // expect: hidden
sql`DELETE FROM "documents" WHERE hidden = false`; // expect: raw-write // expect: hidden
sql`SELECT hidden FROM public.documents`; // expect: raw-read // expect: hidden
sql`SELECT * FROM other JOIN public.documents ON hidden = false`; // expect: raw-read // expect: hidden
sql`UPDATE public.documents SET hidden = false`; // expect: raw-write // expect: hidden
sql`INSERT INTO public.documents (hidden) VALUES (false)`; // expect: raw-write // expect: hidden
sql`DELETE FROM public.documents WHERE hidden = false`; // expect: raw-write // expect: hidden
sql`SELECT hidden FROM "public"."documents"`; // expect: raw-read // expect: hidden
sql`SELECT * FROM other JOIN "public"."documents" ON hidden = false`; // expect: raw-read // expect: hidden
sql`UPDATE "public"."documents" SET hidden = false`; // expect: raw-write // expect: hidden
sql`INSERT INTO "public"."documents" (hidden) VALUES (false)`; // expect: raw-write // expect: hidden
sql`DELETE FROM "public"."documents" WHERE hidden = false`; // expect: raw-write // expect: hidden
sql`SELECT hidden FROM "folders"`; // expect: raw-read // expect: hidden
sql`SELECT * FROM other JOIN "folders" ON hidden = false`; // expect: raw-read // expect: hidden
sql`UPDATE "folders" SET hidden = false`; // expect: raw-write // expect: hidden
sql`INSERT INTO "folders" (hidden) VALUES (false)`; // expect: raw-write // expect: hidden
sql`DELETE FROM "folders" WHERE hidden = false`; // expect: raw-write // expect: hidden
sql`SELECT hidden FROM public.folders`; // expect: raw-read // expect: hidden
sql`SELECT * FROM other JOIN public.folders ON hidden = false`; // expect: raw-read // expect: hidden
sql`UPDATE public.folders SET hidden = false`; // expect: raw-write // expect: hidden
sql`INSERT INTO public.folders (hidden) VALUES (false)`; // expect: raw-write // expect: hidden
sql`DELETE FROM public.folders WHERE hidden = false`; // expect: raw-write // expect: hidden
sql`SELECT hidden FROM "public"."folders"`; // expect: raw-read // expect: hidden
sql`SELECT * FROM other JOIN "public"."folders" ON hidden = false`; // expect: raw-read // expect: hidden
sql`UPDATE "public"."folders" SET hidden = false`; // expect: raw-write // expect: hidden
sql`INSERT INTO "public"."folders" (hidden) VALUES (false)`; // expect: raw-write // expect: hidden
sql`DELETE FROM "public"."folders" WHERE hidden = false`; // expect: raw-write // expect: hidden
sql`SELECT hidden FROM public."documents"`; // expect: raw-read // expect: hidden
sql`UPDATE "public".folders SET hidden = false`; // expect: raw-write // expect: hidden
sql.raw('DELETE FROM "public"."documents" WHERE hidden = true'); // expect: raw-write // expect: hidden
