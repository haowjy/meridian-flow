/** Live folder identity lookup for import upload admission. */
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextImportDestinationLookup } from "../ports/context-import-destination.js";
import type { ProjectContextFsScheme } from "../ports/context-port.js";
import { createTreeReader, LIVE_TREE } from "./tree-view.js";

export function createDrizzleContextImportDestinationLookup(
  db: Database,
  projectId: string,
  areas: readonly ProjectContextFsScheme[],
): ContextImportDestinationLookup {
  const tree = createTreeReader(db);
  return {
    async findFolder(scheme, segments) {
      if (!(areas as readonly string[]).includes(scheme)) return null;
      const [source] = await currentDrizzleDb(db)
        .select({ id: contextSources.id })
        .from(contextSources)
        .where(
          and(
            eq(contextSources.projectId, projectId as never),
            eq(contextSources.slug, scheme),
            isNull(contextSources.workId),
            isNull(contextSources.rootThreadId),
            isNull(contextSources.chatThreadId),
            isNull(contextSources.deletedAt),
          ),
        );
      if (!source) return null;
      const found = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: source.id,
        path: segments.join("/"),
      });
      return found.kind === "found" && found.node.kind === "folder"
        ? { folderId: found.node.folder.id }
        : null;
    },
  };
}
