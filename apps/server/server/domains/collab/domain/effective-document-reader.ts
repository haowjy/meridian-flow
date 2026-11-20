/** Effective document reads for non-tool callers: the same room copy a model call would read. */
import { writeBlocks } from "@meridian/agent-edit/diff";
import {
  type AgentEditCodecFactory,
  type DocHandle,
  isDocumentNotFoundError,
  toDocHandle,
  unwrapDoc,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { DraftOwner, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { settledAheads } from "@meridian/markup/links";
import {
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  withBlockIds,
} from "@meridian/prosemirror-schema";
import { liveBlocks } from "@meridian/suggestions";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  DraftPeerShadowAccess,
  EffectiveBlocksRead,
  EffectiveReadVersion,
  HashlineRead,
  SyncError,
  WorkDraftMissing,
} from "../contracts.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import type { Branches } from "./branches.js";
import { documentRevision, readHashlines } from "./document-revision.js";
import { isCodeDocument } from "./document-schema-type.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftPullService } from "./draft-pulls.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import type { BlockText } from "./ports/block-text.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
} & EffectiveReadVersion;

export function createEffectiveDocumentReader(input: {
  drafts: ApplicationDraftStore;
  draftCoordinator: Pick<DraftCoordinator, "copyDraft" | "loadBase" | "prepareAppend">;
  blockText: BlockText;
  draftPulls: Pick<DraftPullService, "catchUpDraft">;
  agentEdit: AgentEditRouter;
  documents: Pick<MarkdownDocumentEngine, "serializeVersionedDocument">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  branches: Pick<Branches, "viewForOwner">;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
}): Omit<DraftPeerShadowAccess, "draftCreatedDocuments"> {
  /** The view a read spells in: the version it reads. */
  async function viewOf(command: EffectiveReadInput): Promise<LinkView> {
    return command.destination === "draft"
      ? input.branches.viewForOwner(command.owner)
      : { kind: "live" };
  }

  async function spelling(command: EffectiveReadInput, doc: Y.Doc) {
    const holder = { documentId: command.documentId, view: await viewOf(command) };
    await input.links.prepare({ holders: [holder], docs: [doc] });
    return input.links.holder(holder);
  }

  /**
   * Reads the document's effective Y.Doc for this command: the room copy a model call would
   * read (the thread's Work draft, or live). Choosing the content source never chooses the view: every source renders through
   * the same `read`, which spells in the command's own view.
   */
  async function readEffective<T>(
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<Result<T, SyncError>> {
    let room: Awaited<ReturnType<AgentEditRouter["readRoom"]>>;
    try {
      room = await input.agentEdit.readRoom({
        documentId: command.documentId,
        threadId: command.threadId,
        live: command.destination === "live",
      });
    } catch (cause) {
      if (isDocumentNotFoundError(cause))
        return Err({ code: "not_found", documentId: command.documentId });
      throw cause;
    }
    try {
      return Ok(await read(toDocHandle(room.doc)));
    } finally {
      room.dispose();
    }
  }

  /**
   * A Work's draft room as the Work holds it: found by the Work and the document alone, with
   * no reading chat and no reply's staged writes. A Work that never drafted the document is `draft_not_found`; callers decide
   * whether to fall back to live.
   */
  async function readWorkDraft<T>(
    command: { documentId: DocumentId; owner: DraftOwner },
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<Result<T, WorkDraftMissing>> {
    const draft = await input.drafts.findOwnerDraft(command.documentId, command.owner);
    if (!draft) return Err({ code: "draft_not_found", documentId: command.documentId });
    await input.draftPulls.catchUpDraft(draft.draftId);
    const { doc } = await input.draftCoordinator.copyDraft(draft.draftId);
    try {
      return Ok(await read(toDocHandle(doc)));
    } finally {
      doc.destroy();
    }
  }

  return {
    async readEffectiveRevision(command) {
      try {
        const result = await readEffective(command, async (handle) => {
          const doc = unwrapDoc(handle);
          return documentRevision(doc, await spelling(command, doc));
        });
        return result.ok ? result.value : null;
      } catch {
        return null;
      }
    },
    readStoredGrepTexts: ({ documentIds, ...version }) =>
      input.blockText.grepTexts(documentIds, {
        draftOwner: version.destination === "draft" ? version.owner : null,
      }),
    readStoredWordCounts: (documentIds) => input.blockText.wordCounts(documentIds),
    catchUpDraft(draftId) {
      return input.draftPulls.catchUpDraft(draftId);
    },
    async readOwnerMarkdown({ documentId, owner }) {
      const draft = await input.drafts.findOwnerDraft(documentId, owner);
      if (!draft)
        return readEffective({ documentId, destination: "live" }, async (doc) =>
          input.documents.serializeVersionedDocument(documentId, unwrapDoc(doc), { kind: "live" }),
        );
      await input.draftPulls.catchUpDraft(draft.draftId);
      const { doc } = await input.draftCoordinator.copyDraft(draft.draftId);
      try {
        return Ok(
          await input.documents.serializeVersionedDocument(
            documentId,
            doc,
            await input.branches.viewForOwner(owner),
          ),
        );
      } finally {
        doc.destroy();
      }
    },
    readEffectiveMarkdown(command) {
      return readEffective(command, async (doc) =>
        input.documents.serializeVersionedDocument(
          command.documentId,
          unwrapDoc(doc),
          await viewOf(command),
        ),
      );
    },
    async readEffectiveBlocks(command) {
      const project =
        (version: "live" | "draft") =>
        async (handle: DocHandle): Promise<EffectiveBlocksRead> => {
          const doc = unwrapDoc(handle);
          const scope = await spelling(command, doc);
          const blocks = liveBlocks(
            input.model.projectBlocks(toDocHandle(doc)).map((block) => block.node),
          );
          return {
            content: blocks,
            version,
            revision: documentRevision(doc, scope),
            holderUri: scope.holder.uri,
            stateVector: Y.encodeStateVector(doc),
            aheadSettlements: settledAheads(blocks, scope),
          };
        };
      if (command.destination === "draft") {
        const draft = await readWorkDraft(command, project("draft"));
        if (draft.ok) return draft;
      }
      return readEffective(
        { documentId: command.documentId, destination: "live" },
        project("live"),
      );
    },
    readEffectiveHashlines(command) {
      return readEffective(command, async (handle): Promise<HashlineRead> => {
        const doc = unwrapDoc(handle);
        const [scope, verbatim] = await Promise.all([
          spelling(command, doc),
          isCodeDocument(input.resolveFiletype, command.documentId),
        ]);
        return readHashlines(doc, scope, input.model, input.codec, verbatim);
      });
    },
    async writeCreatedDraftContent(created) {
      const schema = buildDocumentSchema();
      for (const { documentId, branchId, content } of created) {
        const draft = await input.drafts.findBranchDraft(documentId, branchId);
        if (!draft) throw new Error(`No created draft for ${documentId}`);
        const base = await input.draftCoordinator.loadBase(draft.draftId);
        const write = input.draftCoordinator.prepareAppend(base, [], {
          async authorServerRows(doc) {
            return captureMutationUpdates(doc, () =>
              doc.transact(() => {
                writeBlocks(
                  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
                  schema,
                  content.blocks.map(withBlockIds),
                );
              }),
            );
          },
        });
        try {
          if (!(await write.persist()))
            throw new Error(`Created draft content was contained for ${documentId}`);
          await write.transfer();
        } finally {
          write.dispose();
        }
      }
    },
  };
}
