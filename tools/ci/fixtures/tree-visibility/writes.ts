// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents, folders } from "@meridian/database/schema";

db.insert(documents).values({ name: "chapter" }); // expect: write
db.update(folders).set({ name: "folder" }); // expect: write
db.delete(documents); // expect: write
