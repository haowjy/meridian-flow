/** Shared agent-edit and markdown runtime construction for collab compositions. */
import {
  createAgentEditCodec,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentLifecycle,
  type ReversalStore,
  type UpdateJournal,
  type UpdateMeta,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { TurnId } from "@meridian/contracts/runtime";
import { type AssetPathResolver, mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import type { DocumentWriteHookRunner } from "./document-projection-refresher.js";
import {
  createMarkdownDocumentEngine,
  type MarkdownSerializationAnomalyObserver,
  type RuntimeOrigin,
} from "./markdown-document.js";
import type { InitialDocumentSeeds } from "./ports/initial-document-seeds.js";
import { createSemanticProvenanceWriter } from "./provenance.js";

type AgentEditObservability = Pick<
  Parameters<typeof createAgentEditCore>[0],
  | "reversalNoticePort"
  | "onInvariantViolation"
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onUnexpectedWriteError"
  | "onReversalNoticeFailed"
>;

export function createAgentEditRuntime(input: {
  journal: UpdateJournal & ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  initialDocumentSeeds: InitialDocumentSeeds;
  deferUntilCommit?(callback: () => void | Promise<void>): boolean;
  runDocumentWriteHook: DocumentWriteHookRunner;
  resolveDocumentFiletype(documentId: string): Promise<string | null>;
  observability: AgentEditObservability;
  /**
   * Project asset index for `asset:<documentId>` ↔ project-relative path
   * translation. Compositions with no asset namespace (in-memory, tests) leave
   * it out and get the resolver that refuses to serialize an asset ref.
   */
  assetPathResolver?: AssetPathResolver;
  observeSerializationAnomaly?: MarkdownSerializationAnomalyObserver;
}) {
  const schema = buildDocumentSchema();
  const markupCodec = mdxCodec({
    schema,
    assetPathResolver: input.assetPathResolver ?? unresolvedAssetPathResolver,
  });
  const codec = createAgentEditCodec(markupCodec);
  const model = yProsemirrorModel(schema);
  const semanticProvenance = createSemanticProvenanceWriter();
  const liveUtilityCore = asLiveAgentEditCore(
    createAgentEditCore({
      journal: input.journal,
      coordinator: input.coordinator,
      lifecycle: input.lifecycle,
      codec,
      model,
      semanticProvenance,
      undoClientId: AGENT_EDIT_UNDO_CLIENT_ID,
      createRuntimeDoc: () => createCollabYDoc({ gc: false }),
      deferUntilCommit: input.deferUntilCommit,
      ...input.observability,
    }),
  );
  const markdownDocuments = createMarkdownDocumentEngine({
    codec: markupCodec,
    schema,
    model,
    journal: input.journal,
    coordinator: input.coordinator,
    lifecycle: input.lifecycle,
    initialDocumentSeeds: input.initialDocumentSeeds,
    deferUntilCommit: input.deferUntilCommit,
    metaForOrigin,
    afterWrite: input.runDocumentWriteHook,
    identityPreservingWrite: ({ documentId, markdown, actor }) =>
      liveUtilityCore.write(
        {
          command: "create",
          file: "document.md",
          documentId,
          content: markdown,
          overwrite: true,
        },
        {
          actor,
          sessionId:
            actor.kind === "human"
              ? actor.userId
              : actor.kind === "agent"
                ? actor.turnId
                : `system:${actor.origin}`,
          ...(actor.kind === "agent" || actor.kind === "human" ? { threadId: actor.threadId } : {}),
        },
      ),
    resolveFiletype: input.resolveDocumentFiletype,
    observeSerializationAnomaly: input.observeSerializationAnomaly,
  });
  return {
    codec,
    liveUtilityCore,
    markdownDocuments,
    markupCodec,
    model,
    semanticProvenance,
  };
}

export function metaForOrigin(origin: RuntimeOrigin): UpdateMeta {
  if (origin.type === "agent") {
    return { origin: `agent:${origin.actorTurnId}`, actorTurnId: origin.actorTurnId, seq: 0 };
  }
  if (origin.type === "user") {
    const userId = "actorUserId" in origin ? origin.actorUserId : origin.userId;
    return { origin: `human:${userId}`, seq: 0 };
  }
  if (origin.type === "import") {
    return origin.userId
      ? { origin: `human:${origin.userId}`, seq: 0 }
      : { origin: "system", seq: 0 };
  }
  return { origin: "system", seq: 0 };
}

export function attributionFromMeta(meta: UpdateMeta): {
  originType: string | null;
  actorTurnId: TurnId | null;
  actorUserId: import("@meridian/contracts/runtime").UserId | null;
} {
  if (meta.origin === "system") {
    return {
      originType: "system",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: null,
    };
  }
  const separator = meta.origin.indexOf(":");
  if (separator === -1) {
    return { originType: null, actorTurnId: null, actorUserId: null };
  }
  const kind = meta.origin.slice(0, separator);
  const id = meta.origin.slice(separator + 1);
  if (kind === "agent") {
    return {
      originType: "agent",
      actorTurnId: ((meta.actorTurnId ?? id) as TurnId) || null,
      actorUserId: null,
    };
  }
  if (kind === "human") {
    return {
      originType: "user",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: (id as import("@meridian/contracts/runtime").UserId) || null,
    };
  }
  return { originType: null, actorTurnId: null, actorUserId: null };
}
