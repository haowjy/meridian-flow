/** Authorized current-first browser address lookup over the authoritative namespace. */
import type { DocumentId } from "@meridian/contracts";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentPreviousLocations,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type { DocumentAddressStore } from "../ports/document-address.js";
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";

export function createDrizzleDocumentAddressStore(db: Database): DocumentAddressStore {
  return {
    async candidate(input) {
      return runInRootDrizzleReadSnapshot(db, async () => {
        const tx = currentDrizzleDb(db);
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.userId, input.userId),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1);
        if (!project) return null;
        const workScoped = isWorkScopedProjectContextScheme(input.scheme);
        if (!workScoped && input.workId !== null) return null;
        const [source] = await tx
          .select({ id: contextSources.id })
          .from(contextSources)
          .leftJoin(projects, eq(contextSources.projectId, projects.id))
          .leftJoin(works, eq(contextSources.workId, works.id))
          .where(
            and(
              eq(contextSources.slug, input.scheme),
              isNull(contextSources.deletedAt),
              workScoped && input.workId !== null
                ? and(
                    eq(works.id, input.workId),
                    eq(works.projectId, input.projectId),
                    isNull(works.deletedAt),
                    eq(works.status, "active"),
                  )
                : and(
                    isNull(contextSources.workId),
                    isNull(projects.deletedAt),
                    input.scheme === "user"
                      ? and(eq(projects.userId, input.userId), eq(projects.isPersonal, true))
                      : eq(projects.id, input.projectId),
                  ),
            ),
          )
          .limit(1);
        if (!source) return null;
        const current = await new DrizzleContextTreeMutationStore(db).inspect(
          source.id,
          input.path,
        );
        if (current)
          return current.kind === "file"
            ? { kind: "current", documentId: current.nodeId as DocumentId }
            : null;
        const [previous] = await tx
          .select({ documentId: documentPreviousLocations.documentId })
          .from(documentPreviousLocations)
          .where(
            and(
              eq(documentPreviousLocations.contextSourceId, source.id),
              eq(documentPreviousLocations.path, input.path),
            ),
          )
          .limit(1);
        return previous ? { kind: "alias", documentId: previous.documentId } : null;
      });
    },
  };
}
