/** Atomic ownership of tracked-document identity, Yjs authority, and manifest membership. */

import type { DocumentId } from "@meridian/contracts/runtime";

export type DocumentCreationMaterialization = {
  documentId: DocumentId;
  persistIdentity(): Promise<boolean>;
  persistMembership(): Promise<void>;
};

export type ImmediateDocumentCreation<T> = DocumentCreationMaterialization & {
  initializeContent(): Promise<T>;
};

export type DocumentRepair = Pick<
  ImmediateDocumentCreation<void>,
  "documentId" | "persistMembership" | "initializeContent"
>;

export type DocumentCreationAggregate = {
  createDocumentAtomically<T>(
    input: ImmediateDocumentCreation<T>,
  ): Promise<{ created: true; value: T } | { created: false }>;
  repairDocumentAtomically(input: DocumentRepair): Promise<void>;
  ensureDocument(documentId: string): Promise<void>;
};

export function createDocumentCreationAggregate(input: {
  atomic<T>(operation: () => Promise<T>): Promise<T>;
  ensureDocument(documentId: string): Promise<void>;
}): DocumentCreationAggregate {
  return {
    async createDocumentAtomically<T>(creation: ImmediateDocumentCreation<T>) {
      return input.atomic(async () => {
        if (!(await creation.persistIdentity())) return { created: false } as const;
        await creation.persistMembership();
        return {
          created: true,
          value: await creation.initializeContent(),
        } as const;
      });
    },

    async repairDocumentAtomically(repair) {
      await input.atomic(async () => {
        await repair.initializeContent();
        await repair.persistMembership();
      });
    },

    async ensureDocument(documentId) {
      await input.ensureDocument(documentId);
    },
  };
}
