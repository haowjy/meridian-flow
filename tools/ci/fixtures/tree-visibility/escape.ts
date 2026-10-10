// Syntactic guard fixture; executed by check-tree-visibility.mjs.
import { documents } from "@meridian/database/schema";

selectFromTable(documents); // expect: escape
selectFromTable(condition, documents); // expect: escape
