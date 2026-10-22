// Syntactic guard fixture; executed by check-tree-visibility.mjs.

import * as schema from "@meridian/database";
import { documents as docs } from "@meridian/database/schema";

db.select().from(docs); // expect: from
db.select().from(schema.folders); // expect: from
