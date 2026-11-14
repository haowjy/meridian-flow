/**
 * The `read` and `write` tools: a path resolves to its tracked document,
 * the file policy grants the call, and collab reads or writes under that grant. `skills://` paths go to the skill files.
 */

import type {
  AgentEditResultV1,
  DocumentCommandName,
  FrontierLookup,
  NamespaceCommandName,
  ReadToolInput,
  WriteCommand,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import {
  documentNotFoundMessage,
  formatDocumentFile,
  isDocumentNotFoundError,
  splitDocumentFile,
  survivingDraftNotice,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { ModelInfo } from "@meridian-flow/gateway";
import {
  createCopyIdentityMap,
  ModelEditRefusal,
  remapCopiedBlocks,
} from "../../domains/collab/index.js";
import type { DocumentCreationMetadata } from "../../domains/context/document-metadata.js";
import {
  type FileDestination,
  FileEditRefusedError,
  type FileGrant,
  type Principal,
} from "../../domains/file-policy/index.js";
import {
  isSkillsUri,
  type ModelEditHandlerResult,
  type ResultEvidence,
  readSkill,
  refuseSkillWrite,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { removedFileResult } from "../file-access-denial-copy.js";
import { threadContainerTarget } from "../file-targets.js";
import { type ReadPlacement, readBinaryFile } from "./binary-read.js";
import {
  binaryCopySelectionMessage,
  type CopiedSource,
  copyBinary,
  fromMessage,
  readCopySource,
  readTrackedCopySource,
  resolveCopySource,
} from "./copy-source.js";
import {
  documentGrant,
  documentNotFoundError,
  fileAccessDeniedError,
  firstRefusal,
  inContainer,
  keptDraftReader,
  removalBehind,
} from "./file-access.js";
import { readDocument } from "./read-document.js";
import { evidenceOf, threadShownLinks } from "./shown-link-capture.js";
import {
  areaOfPath,
  namesEvidence,
  printedNames,
  type Reached,
  reachShown,
  wrongKindMessage,
} from "./shown-paths.js";
import {
  contextErrorMessage,
  documentRevisionMetadata,
  isToolError,
  type ResolvedDocumentAddress,
  type ResolvedModelContextPort,
  resolveToolCall,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";
import { runTreeToolCommand } from "./tree-commands.js";
import { runTreeInverse } from "./tree-inverse.js";

/** A `write` call the engine runs: everything but the host's whole-document commands. */
type EngineWriteInput = Exclude<WriteToolInput, { command: NamespaceCommandName }>;

/** Resolves a model path to its tracked document; only `create` may make one. */
export async function resolveDocumentAddress(
  context: ResolvedModelContextPort,
  command: DocumentCommandName,
  path: string,
  options: {
    sourceExtension?: string;
    metadata?: DocumentCreationMetadata;
    origin?: import("../../domains/context/index.js").WriteProvenance;
    recordCreate?: NonNullable<
      import("../../domains/context/ports/context-adapter.js").ContextEnsureTrackedOptions["recordCreate"]
    >;
  } = {},
): Promise<ResolvedDocumentAddress | WriteToolErrorOutput> {
  const port = context.port;
  const { filePath: basePath, fragment } = splitDocumentFile(path);
  if (command === "create" || command === "copy") {
    if (fragment) return writeToolError(command, `${command} does not accept a #fragment in path`);
    const ensureOptions = {
      ...(options.sourceExtension !== undefined
        ? { sourceExtension: options.sourceExtension }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.recordCreate ? { recordCreate: options.recordCreate } : {}),
    };
    const ensured = await port.ensureTrackedDocument(
      basePath,
      Object.keys(ensureOptions).length > 0 ? ensureOptions : undefined,
    );
    if (!ensured.ok) {
      return writeToolError(command, contextErrorMessage(ensured.error));
    }
    return {
      documentId: ensured.value.documentId,
      uri: ensured.value.uri,
      filePath: ensured.value.uri,
      created: ensured.value.created,
    };
  }

  const ref = await port.stat(basePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found") {
      return writeToolError(command, documentNotFoundMessage(command), "document_not_found", {
        path: path,
      });
    }
    // A URI naming no Work, no scheme or no live chat addresses no document; the reason says
    // what is valid. A read never reports a write status.
    const unknownAddress =
      ref.error.code === "invalid_uri" &&
      (command === "read" ||
        ref.error.workHandle !== undefined ||
        ref.error.unknownScheme !== undefined ||
        ref.error.slip !== undefined);
    if (ref.error.code === "invalid_operation" && ref.error.reason === "ambiguous_path") {
      return writeToolError(command, contextErrorMessage(ref.error), "ambiguous_path", {
        path: path,
      });
    }
    return writeToolError(
      command,
      contextErrorMessage(ref.error),
      unknownAddress ? "document_not_found" : "invalid_write",
      unknownAddress ? { path: path } : {},
    );
  }
  if (ref.value.kind !== "tracked") {
    return writeToolError(
      command,
      command === "read"
        ? "The file is binary, so it can't be read as text."
        : "The file is binary, so it can't be edited as text.",
      "binary_file",
      { path: ref.value.uri },
    );
  }
  if (!ref.value.documentId) {
    return writeToolError(command, `Document id missing for ${path}`);
  }
  return {
    documentId: ref.value.documentId,
    uri: ref.value.uri,
    filePath: ref.value.uri,
    ...(fragment === undefined ? {} : { fragment }),
  };
}

function buildAgentWriteCommand(
  input: EngineWriteInput,
  address: ResolvedDocumentAddress,
  toolUseId: string | undefined,
  copied?: CopiedSource,
): WriteCommand {
  const { path: _path, ...command } = input;
  return {
    ...command,
    ...("from" in command && command.from && copied
      ? {
          from: {
            ...command.from,
            path: formatDocumentFile({
              filePath: copied.copiedFrom.uri,
              fragment: splitDocumentFile(command.from.path).fragment,
            }),
          },
        }
      : {}),
    documentId: address.documentId,
    file: formatDocumentFile(address),
    tool_use_id: toolUseId,
  };
}

/** Writes report where they landed; a drafted write names its Work. */
function withDestination(
  outcome: WriteOutcome,
  destination: FileDestination,
  command: EngineWriteInput["command"],
): WriteOutcome {
  if (outcome.isError) return outcome;
  // Inverses can follow an edit away from the chat's current destination. Their owner reports
  // the version actually changed, or deliberately leaves it unnamed when one command spans views.
  if (command === "undo" || command === "redo" || command === "revert") return outcome;
  return {
    ...outcome,
    result: {
      ...outcome.result,
      destination: destination.kind,
      ...(destination.kind === "draft" ? { draftWork: destination.ownerHandle ?? "/" } : {}),
    },
  };
}

/**
 * The write itself: the edit grant on the document, then the pool call that
 * carries it. A seam that refuses the grant under its locks reports the same
 * error a preflight denial does.
 */
async function writeUnderGrant(
  deps: ToolWiringDeps,
  principal: Principal,
  parsed: EngineWriteInput,
  address: ResolvedDocumentAddress,
  copied: CopiedSource | undefined,
  ctx: ToolHandlerContext,
  uploadsChat: string | null | undefined,
  given?: FileGrant<"edit">,
): Promise<
  | (WriteOutcome & { isError: false; evidence: ResultEvidence })
  | (WriteToolErrorOutput & { evidence?: ResultEvidence })
> {
  const grant = given ?? (await documentGrant(deps, principal, parsed.command, address, "edit"));
  if (isToolError(grant)) return grant;
  let written: WriteOutcome;
  try {
    // The write runs under its own lock, inside the command's transaction.
    written = await deps.documentSync
      .modelEdits()
      .write(buildAgentWriteCommand(parsed, address, ctx.toolCallId, copied), {
        sessionId: ctx.threadId,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        responseIdentity: ctx.responseIdentity,
        tool_use_id: ctx.toolCallId,
        ...(uploadsChat ? { uploadsChat } : {}),
        grant,
        shownLinks: threadShownLinks(deps, ctx.threadId),
        ...(ctx.frontiers
          ? { frontiers: ctx.frontiers, creditedBlockIds: ctx.frontiers.credited() }
          : {}),
        ...(copied ? { copiedNodes: copied.nodes } : {}),
      });
  } catch (cause) {
    // A removal that won the document's lock after the grant (a pull, a staged or immediate
    // commit): the model's interim answer is `document_not_found`, with the record's sentence.
    if (isDocumentNotFoundError(cause))
      return cause.removal
        ? removedFileResult(parsed.command, cause.removal, address.filePath)
        : documentNotFoundError(parsed.command, address.filePath);
    if (!(cause instanceof FileEditRefusedError)) throw cause;
    const refusal = firstRefusal(cause);
    return fileAccessDeniedError(
      parsed.command,
      refusal,
      address.filePath,
      await removalBehind(deps, principal, refusal),
    );
  }
  // The echo, staged or immediate, and an undo or redo result were shown; so
  // was a partial failure's echo. Whatever frontier a result carries records,
  // error or not.
  const evidence = evidenceOf(address.documentId, written);
  if (written.isError) return { isError: true, output: written.result, evidence };
  // Showing and frontier are host-only: they leave here only as `evidence`.
  const { showing: _showing, frontier: _frontier, ...outcome } = written;
  return {
    ...withDestination(outcome, grant.destination, parsed.command),
    evidence,
  } as WriteOutcome & {
    isError: false;
    evidence: ResultEvidence;
  };
}

/** The names a result printed for the document it was about: what the path reached, else the tree's own. */
async function printedOf(
  call: ToolCall,
  address: ResolvedDocumentAddress,
  reached: Pick<Reached, "delta" | "node"> | null,
  version?: "draft" | "live",
) {
  if (reached?.node?.id === address.documentId && reached.delta) return reached.delta;
  const area = areaOfPath(address.uri)?.area;
  return area ? printedNames(call, area, [address.documentId], version) : reached?.delta;
}

/** Shared tracked read: ordinary tool arguments, optionally pinned to a known identity. */
export async function readTrackedDocument(
  deps: ToolWiringDeps,
  input: ReadToolInput,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseIdentity" | "toolCallId"> &
    Partial<Pick<ToolHandlerContext, "frontiers" | "shownNames">>,
  options: {
    expectedDocumentId?: string;
    recordingFrontier?: FrontierLookup;
    /** The thread's model, asked for only when the file is binary and what to show depends on it. */
    model?: () => Promise<ModelInfo | undefined>;
    /** Where the file is shown: a writer's mention goes in the user message, the agent's read in the tool result. */
    placement?: ReadPlacement;
  } = {},
): Promise<{
  output: AgentEditResultV1;
  revision: string | null;
  isError?: true;
  metadata?: ReturnType<typeof documentRevisionMetadata>;
  evidence?: ResultEvidence;
}> {
  const { path, format, version, ...selection } = input;
  const call = await resolveToolCall(deps, ctx, version);
  if (isToolError(call)) return { ...writeToolError("read", call.output.message), revision: null };
  const reached = await reachShown(call, ctx, "read", path, {
    ...(version ? { version } : {}),
  });
  if (isToolError(reached)) return { ...reached, revision: null };
  const wrongKind = reached.node ? wrongKindMessage(reached.path, reached.node, "read") : null;
  if (wrongKind)
    return { ...writeToolError("read", wrongKind, "document_not_found", { path }), revision: null };
  const address = await resolveDocumentAddress(call.context, "read", reached.path);
  if (isToolError(address)) {
    if (address.output.status === "binary_file")
      return readBinaryFile(
        deps,
        call,
        { ...input, path: reached.path },
        await options.model?.(),
        options.placement ?? "tool-result",
      );
    return { ...address, revision: null };
  }
  if (options.expectedDocumentId !== undefined && address.documentId !== options.expectedDocumentId)
    return {
      ...writeToolError(
        "read",
        "Referenced document is no longer available at this URI.",
        "document_not_found",
      ),
      revision: null,
    };
  const reader =
    version === "draft"
      ? await keptDraftReader(
          deps,
          call.principal,
          call.execution,
          call.context.resolution.thread,
          address.documentId,
        )
      : call.principal;
  const grant = await documentGrant(deps, reader, "read", address, "read");
  if (isToolError(grant)) return { ...grant, revision: null };
  const outcome = await readDocument(
    deps,
    grant,
    address,
    {
      selection,
      format,
      ...(version ? { version } : {}),
      ...(options.recordingFrontier ? { recordingFrontier: options.recordingFrontier } : {}),
    },
    ctx,
  );
  if (outcome.isError) return { isError: true, output: outcome.result, revision: outcome.revision };
  const owner = await deps.contextPorts.chatFiles.notice(
    call.context.resolution.thread.projectId,
    path,
    address.uri,
  );
  // Only a draft that outlived a live delete reads a deleted document.
  const surviving =
    grant.destination.kind === "draft" && grant.facts.deleted
      ? survivingDraftNotice(
          (await deps.documentRemovals.lookup([address.documentId])).get(address.documentId),
        )
      : null;
  const notice = [owner && "notice" in owner ? owner.notice : null, surviving]
    .filter(Boolean)
    .join("\n");
  return {
    output: { ...outcome.result, ...owner, ...(notice ? { notice } : {}) },
    revision: outcome.revision,
    metadata: documentRevisionMetadata(address, outcome.revision),
    evidence: {
      ...evidenceOf(address.documentId, outcome),
      ...namesEvidence(await printedOf(call, address, reached, version)),
    },
  };
}

export function createReadHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const parsed = input as ReadToolInput;
    if (isSkillsUri(parsed.path)) return readSkill(deps, ctx.threadId, parsed);
    const { revision: _revision, ...result } = await readTrackedDocument(deps, parsed, ctx, {
      model: async () => ctx.model,
      ...(ctx.frontiers ? { recordingFrontier: ctx.frontiers.recording } : {}),
    });
    return result;
  };
}

export function createWriteHandler(deps: ToolWiringDeps) {
  return async (input: unknown, handlerCtx: ToolHandlerContext) => {
    const ctx = handlerCtx;
    const edit = ctx.modelEdit;
    if (!edit) throw new Error("A write is a document command: the executor keys it");
    const written = input as WriteToolInput;
    const skillRefusal = refuseSkillWrite(written);
    if (skillRefusal) return skillRefusal;
    const call = await resolveToolCall(deps, ctx);
    if (isToolError(call)) return writeToolError(written.command, call.output.message);
    const settle = effectSettler(deps, ctx, edit);
    if (
      written.command === "move" ||
      written.command === "delete" ||
      written.command === "restore" ||
      (written.command === "create" && written.path.endsWith("/"))
    )
      return runTreeToolCommand(deps, call, written, ctx, settle);
    const { context, principal } = call;
    const isInverse =
      written.command === "undo" || written.command === "redo" || written.command === "revert";
    const creates = written.command === "create" || written.command === "copy";
    // The path the model wrote is the node it was shown: a create only looks up its folders. An
    // inverse reaches it after its tree half, which may have moved the node.
    const reach = (path: string) =>
      reachShown(call, ctx, written.command, path, { folderOf: creates });
    let reached: Reached | undefined;
    let parsed = written;
    if (!isInverse) {
      const first = await reach(written.path);
      if (isToolError(first)) return first;
      reached = first;
      parsed = { ...written, path: first.path } as typeof written;
    }
    // A create or copy needs edit on the folder it makes the file in, at the
    // destination the file lands in; the namespace transaction confirms that
    // grant under its locks (seam C).
    const target = creates
      ? await threadContainerTarget(deps.works, context.resolution, parsed.path)
      : null;

    // A copy reads its source before it creates anything, so a bad source leaves no file.
    let copied: CopiedSource | undefined;
    if (parsed.command === "copy") {
      const source = await resolveCopySource(deps, parsed.command, parsed.from, ctx);
      if (isToolError(source)) return source;
      if (source.ref.kind === "binary") {
        const selection = binaryCopySelectionMessage(parsed.from, source.address);
        if (selection) {
          return writeToolError(parsed.command, fromMessage(parsed.from, selection), "binary_file");
        }
        const binary = source.ref;
        const sourceGrant = await documentGrant(
          deps,
          principal,
          parsed.command,
          source.address,
          "read",
        );
        if (isToolError(sourceGrant)) {
          return writeToolError(
            parsed.command,
            fromMessage(parsed.from, sourceGrant.output.message ?? ""),
          );
        }
        // A binary copy lands where a create would: in a draft-mode chat, a hidden row
        // holding the branch's own object (12b-Q2).
        return settle(() =>
          inContainer(deps, principal, parsed.command, target, () =>
            copyBinary(deps, context, parsed, binary, sourceGrant, ctx),
          ),
        );
      }
      const read = await readTrackedCopySource(
        deps,
        principal,
        parsed.command,
        parsed.from,
        source.address,
        ctx,
      );
      if (isToolError(read)) return read;
      const { properties, aliases } = source.ref;
      copied = {
        ...read,
        inherited: { ...(properties ? { properties } : {}), ...(aliases ? { aliases } : {}) },
      };
    } else if ((parsed.command === "insert" || parsed.command === "replace") && parsed.from) {
      const read = await readCopySource(deps, principal, parsed.command, parsed.from, ctx);
      if (isToolError(read)) return read;
      copied = read;
    }

    // A write to an existing document finds it before the command claims its id. A drafted write
    // plans on a draft caught up with live, and the pull opens a connection of its own.
    let existing: ResolvedDocumentAddress | undefined;
    if (!isInverse && !creates) {
      const found = await resolveDocumentAddress(context, parsed.command, parsed.path);
      if (isToolError(found)) return found;
      await deps.documentSync.modelEdits().catchUp(found.documentId as DocumentId);
      existing = found;
    }

    let refresh: DocumentId | undefined;
    const effect = async () => {
      // What the tree took back of this call's `count`, said before the text engine's own line.
      let treeUndone: string[] = [];
      let engine = parsed;
      if (isInverse) {
        const tree = await runTreeInverse(
          deps,
          call,
          written as Parameters<typeof runTreeInverse>[2],
          ctx,
        );
        if (tree?.kind === "answer") return tree.answer;
        if (tree?.kind === "then_text") {
          treeUndone = tree.undone;
          engine = { ...written, count: tree.count } as typeof written;
        }
        const first = await reach(written.path);
        // A reversed creation took the document and its text steps with it.
        if (isToolError(first)) return tree?.kind === "then_text" ? tree.answer : first;
        reached = first;
        engine = { ...engine, path: first.path } as typeof written;
      }
      const address =
        existing ??
        (await inContainer(deps, principal, engine.command, target, () =>
          resolveDocumentAddress(context, engine.command, engine.path, {
            origin: {
              type: "agent",
              agentSlug: ctx.agentSlug,
              threadId: ctx.threadId,
              turnId: ctx.turnId,
            },
            ...(engine.command === "copy" && copied
              ? {
                  metadata: { copiedFrom: copied.copiedFrom, ...copied.inherited },
                  sourceExtension: sourceExtension(copied.copiedFrom.uri),
                }
              : {}),
            ...(creates
              ? {
                  recordCreate: async ({ documentId, record, draftBranchId }) => {
                    await deps.documentSync.treeHistory().recordAgentTreeChange({
                      subject: documentId,
                      nodes: [{ nodeId: documentId, beforeAt: null, afterAt: engine.path }],
                      records: [{ record, node: documentId }],
                      threadId: ctx.threadId as import("@meridian/contracts").ThreadId,
                      ...(ctx.turnId
                        ? { turnId: ctx.turnId as import("@meridian/contracts").TurnId }
                        : {}),
                      ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
                      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
                      op: "create",
                      ...(draftBranchId ? { draftBranchId } : {}),
                      shownAt: engine.path,
                    });
                  },
                }
              : {}),
          }),
        ));
      if (isToolError(address)) return address;

      if (engine.command === "copy" && copied) {
        // The copy's new identity is known now: a whole document's own links name the copy, not
        // the original (`collab/domain/copied-blocks.ts`, the one remap a writer Copy also uses).
        // A selection is not the copied set: its links to the whole source keep naming it.
        copied = {
          ...copied,
          nodes: remapCopiedBlocks({
            blocks: copied.nodes,
            sourceHolderUri: copied.copiedFrom.uri,
            aheadSettlements: copied.aheadSettlements,
            map: createCopyIdentityMap({
              documents: copied.wholeDocument
                ? [
                    {
                      sourceDocumentId: copied.sourceDocumentId,
                      sourceUri: copied.copiedFrom.uri,
                      documentId: address.documentId,
                      uri: address.uri,
                    },
                  ]
                : [],
              folders: [],
            }),
          }),
        };
      }

      let outcome = await writeUnderGrant(
        deps,
        principal,
        engine,
        address,
        copied,
        ctx,
        context.resolution.uploadsOwner?.chatRef,
      );
      // A reversed move left the document somewhere else: the result names where it is now. A
      // reversed creation removed the document, so its text half must not claim an empty document
      // survived the tree half of the same inverse.
      if (isInverse && !outcome.isError && outcome.result.status === "success") {
        const located = await call.context.port.locate(address.documentId);
        const now = located.ok ? (located.value?.uri ?? null) : null;
        if (now && now !== outcome.result.path)
          outcome = { ...outcome, result: { ...outcome.result, path: now } };
        else if (!now && outcome.result.documentEmpty)
          outcome = { ...outcome, result: { ...outcome.result, documentEmpty: false } };
      }
      if (outcome.isError)
        return { isError: true, output: outcome.output, evidence: outcome.evidence };
      if (treeUndone.length > 0)
        outcome = {
          ...outcome,
          result: {
            ...outcome.result,
            message: [`undone: ${treeUndone.join(", ")}`, outcome.result.message]
              .filter(Boolean)
              .join("\n"),
          },
        };

      if (outcome.result.unchanged !== true) refresh = address.documentId as DocumentId;
      const notice = await deps.contextPorts.chatFiles.notice(
        context.resolution.thread.projectId,
        engine.path,
        address.uri,
      );
      return {
        output: notice ? { ...outcome.result, ...notice } : outcome.result,
        metadata: documentRevisionMetadata(address, outcome.revision),
        evidence: {
          ...outcome.evidence,
          ...namesEvidence(
            // A create's own name and an inverse's new place are printed too.
            await printedOf(call, address, creates || isInverse ? null : (reached ?? null)),
          ),
        },
      };
    };
    const result = await settle(effect);
    // The projection catches up once the edit is durable, whoever stored it.
    if (refresh && !(isCommandResult(result) && result.modelEdit.status !== "done"))
      await deps.documentSync.refreshDocumentProjection({
        documentId: refresh,
        threadId: ctx.threadId,
      });
    return result;
  };
}

/**
 * Runs a call's effect as the command the executor keyed it by, which stores its result with
 * its outcome. An error result is the command's refusal: whatever the effect changed rolls
 * back with it.
 */
function effectSettler(
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
  edit: NonNullable<ToolHandlerContext["modelEdit"]>,
): (effect: () => Promise<unknown>) => Promise<unknown> {
  return async (effect): Promise<ModelEditHandlerResult> => {
    const { outcome, evidence } = await deps.documentSync.modelEdits().run({
      key: edit.key,
      owner: { threadId: ctx.threadId, turnId: ctx.turnId },
      signal: ctx.signal,
      async effect() {
        const raw = await effect();
        const rendered = edit.render(raw);
        if (isErrorOutput(raw)) throw new ModelEditRefusal(rendered.toolResult, rendered.evidence);
        return rendered;
      },
    });
    return { modelEdit: outcome, ...(evidence ? { evidence } : {}) };
  };
}

function isErrorOutput(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true
  );
}

function isCommandResult(value: unknown): value is ModelEditHandlerResult {
  return typeof value === "object" && value !== null && "modelEdit" in value;
}

function sourceExtension(uri: string): string {
  const parsed = parseDocumentFilename(uri.slice(uri.lastIndexOf("/") + 1));
  return parsed.ok ? parsed.value.extension : "";
}
