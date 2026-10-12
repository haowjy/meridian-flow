import { readStoredDocumentProperties } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { DocumentPropertiesReader } from "../ports/document-properties-reader.js";

export function createDrizzleDocumentPropertiesReader(db: Database): DocumentPropertiesReader {
  return {
    async findStored(documentId) {
      const [row] = await db
        .select({ metadata: documents.metadata })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
        .limit(1);
      return row ? readStoredDocumentProperties(row.metadata) : null;
    },
  };
}
