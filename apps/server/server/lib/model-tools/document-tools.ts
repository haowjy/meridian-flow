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
  EDIT_FAILED_MESSAGE,
  formatDocumentFile,
  isDocumentNotFoundError,
  modelResult,
  returnedWriteResult,
  splitDocumentFile,
  survivingDraftNotice,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts";
import type { ReturnedWhy } from "@meridian/contracts/commands";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { parseDocumentFilename, readSegment } from "@meridian/contracts/protocol";
import type { ModelInfo } from "@meridian-flow/runtime/gateway";
import {
  createCopyIdentityMap,
  ModelEditRefusal,
  remapCopiedBlocks,
} from "../../domains/collab/index.js";
import type { DocumentCreationMetadata } from "../../domains/context/document-metadata.js";
import {
  type FileAccessDenied,
  type FileDestination,
  FileEditRefusedError,
  type FileGrant,
  isFileAccessDenied,
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
  keptDraft,
  removalBehind,
  returnedWhy,
} from "./file-access.js";
import { readDocument } from "./read-document.js";
import { evidenceOf, threadShownLinks } from "./shown-link-capture.js";
import {
  areaOfPath,
  goneMessage,
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
      import("../../domains/context/ports/context-adapter.js").ContextEnsureTrackedPortOptions["recordCreate"]
    >;
    /** The folder node a create goes in, as the names shown resolved its folders. */
    into?: string;
    /** A new document even where the path reaches one (a twin): the one there holds text. */
    beside?: true;
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
      ...(options.into ? { into: options.into } : {}),
      ...(options.beside ? { beside: options.beside } : {}),
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
  if (command === "undo" || command === "revert") return outcome;
  return {
    ...outcome,
    result: {
      ...outcome.result,
      destination: destination.kind,
      ...(destination.kind === "draft" ? { draftWork: destination.ownerHandle ?? "/" } : {}),
    },
  };
}

const isTextEdit = (command: string) =>
  command === "insert" || command === "replace" || command === "remove";
const isInverseCommand = (command: string) => command === "undo" || command === "revert";
/** What a call to a removed document is answered for: a text edit, or an undo or revert. */
const settlesOnRemoval = (command: string) => isTextEdit(command) || isInverseCommand(command);

/**
 * A write the file policy refused: a text edit whose Work is closed or whose document was
 * removed is returned with the document as it stands, and every other refusal is the tool's
 * error.
 */
async function deniedWrite(
  deps: ToolWiringDeps,
  principal: Principal,
  parsed: EngineWriteInput,
  address: ResolvedDocumentAddress,
  ctx: ToolHandlerContext,
  denial: FileAccessDenied,
) {
  const removal = await removalBehind(deps, principal, denial);
  const returned = returnedWhy(denial, removal);
  // An undo, redo or revert is returned only for a removed document; a closed Work is its refusal.
  const why =
    returned === "document_removed" || (returned && isTextEdit(parsed.command)) ? returned : null;
  if (!why) return fileAccessDeniedError(parsed.command, denial, address.filePath, removal);
  return returnedEdit(deps, principal, parsed, address, ctx, why, {
    ...(removal ? { removal } : {}),
    ...(denial.archivedWork?.handle ? { work: denial.archivedWork.handle } : {}),
  });
}

/**
 * A text edit that changed nothing because what it edits is closed or gone, answered with the
 * document as this chat reads it now. The text is a read: its evidence is recorded with the
 * result, so the model's next write plans on it. A removed document has no text to show.
 */
export async function returnedEdit(
  deps: ToolWiringDeps,
  principal: Principal,
  parsed: Pick<EngineWriteInput, "command">,
  address: Pick<ResolvedDocumentAddress, "documentId" | "filePath" | "uri">,
  ctx: ToolHandlerContext,
  why: ReturnedWhy,
  detail: { removal?: DocumentRemovalRecord; work?: string },
): Promise<WriteOutcome & { isError: false; evidence: ResultEvidence }> {
  const returned = returnedWriteResult(why, { ...detail, thisChat: ctx.threadId });
  const grant =
    why === "document_removed"
      ? null
      : await documentGrant(deps, principal, "read", address, "read");
  const read =
    grant && !isToolError(grant)
      ? await readDocument(
          deps,
          grant,
          address,
          {
            inCommand: true,
            ...(ctx.frontiers ? { recordingFrontier: ctx.frontiers.recording } : {}),
          },
          ctx,
        )
      : null;
  const shown = read && !read.isError ? read : null;
  return {
    status: "returned",
    isError: false,
    revision: shown?.revision ?? null,
    command: parsed.command,
    result: modelResult({
      command: parsed.command,
      status: "returned",
      payload: {
        path: address.filePath,
        ...returned.model,
        ...(shown?.result.read ? { read: shown.result.read } : {}),
        ...(shown?.result.blocks ? { blocks: shown.result.blocks } : {}),
      },
    }),
    evidence: shown ? evidenceOf(address.documentId, shown) : { shown: [] },
  };
}

/**
 * The answer for a write to a document the writer removed, from the node the model was shown: it
 * is returned as `document_removed`, whatever the command, naming who removed it. Null when the
 * reached node is not a removed document.
 */
async function removedAnswer(
  deps: ToolWiringDeps,
  principal: Principal,
  written: Parameters<typeof returnedEdit>[2],
  ctx: ToolHandlerContext,
  reached: Reached,
): Promise<{
  output: Awaited<ReturnType<typeof returnedEdit>>["result"];
  evidence: ResultEvidence;
} | null> {
  if (reached.node?.kind !== "document") return null;
  const id = reached.node.id as DocumentId;
  const removal = (await deps.documentRemovals.lookup([id])).get(id);
  if (!removal) return null;
  const outcome = await returnedEdit(
    deps,
    principal,
    written,
    { documentId: id, filePath: reached.path, uri: reached.path },
    ctx,
    "document_removed",
    { removal },
  );
  return { output: outcome.result, evidence: outcome.evidence };
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
  let grant = given;
  if (!grant) {
    const authorized = await deps.fileAccess.authorize(
      principal,
      { kind: "document", documentId: address.documentId as never },
      "edit",
    );
    if (isFileAccessDenied(authorized))
      return deniedWrite(deps, principal, parsed, address, ctx, authorized);
    grant = authorized;
  }
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
    // commit): a text edit is returned with who removed it; any other call's interim answer is
    // `document_not_found`, with the record's sentence.
    if (isDocumentNotFoundError(cause)) {
      if (cause.removal && settlesOnRemoval(parsed.command))
        return returnedEdit(deps, principal, parsed, address, ctx, "document_removed", {
          removal: cause.removal,
        });
      return cause.removal
        ? removedFileResult(parsed.command, cause.removal, address.filePath)
        : documentNotFoundError(parsed.command, address.filePath);
    }
    if (!(cause instanceof FileEditRefusedError)) throw cause;
    return deniedWrite(deps, principal, parsed, address, ctx, firstRefusal(cause));
  }
  // A drafted edit returned because its document was removed names who removed it.
  if (written.result.status === "returned" && written.result.returned?.why === "document_removed") {
    const removal = (await deps.documentRemovals.lookup([address.documentId])).get(
      address.documentId,
    );
    return returnedEdit(deps, principal, parsed, address, ctx, "document_removed", {
      ...(removal ? { removal } : {}),
    });
  }
  // The echo, staged or immediate, and an undo or redo result were shown; so
  // was a partial failure's echo. Whatever frontier a result carries records,
  // error or not.
  const evidence = evidenceOf(address.documentId, written);
  if (written.isError)
    return {
      isError: true,
      output: written.result,
      evidence,
      ...(written.occupied ? { occupied: true as const } : {}),
    };
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
  const reached = await reachShown(deps, call, ctx, path, {
    ...(version ? { version } : {}),
  });
  if (reached.gone)
    return {
      ...writeToolError("read", goneMessage(path, reached.gone), "document_not_found", { path }),
      revision: null,
    };
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
  const decided = await documentGrant(deps, call.principal, "read", address, "read");
  if (isToolError(decided)) return { ...decided, revision: null };
  const kept =
    version === "draft" ? await keptDraft(deps, decided, address.documentId, call.execution) : null;
  const grant = kept
    ? await documentGrant(deps, call.principal, "read", address, "read", kept)
    : decided;
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
  const parsedUri = parseContextUri(address.uri);
  const surviving =
    parsedUri.ok && grant.destination.kind === "draft" && grant.facts.deleted
      ? survivingDraftNotice(
          (await deps.documentRemovals.lookup([address.documentId])).get(address.documentId),
          parsedUri.value.scheme,
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
  const write = async (input: unknown, ctx: ToolHandlerContext) => {
    const edit = ctx.modelEdit;
    if (!edit) throw new Error("A write is a document command: the executor keys it");
    const written = input as WriteToolInput;
    const skillRefusal = refuseSkillWrite(written);
    if (skillRefusal) return skillRefusal;
    const call = await resolveToolCall(deps, ctx);
    if (isToolError(call)) return writeToolError(written.command, call.output.message);
    const settle = effectSettler(deps, ctx, edit, written.command);
    if (
      written.command === "move" ||
      written.command === "delete" ||
      written.command === "restore" ||
      (written.command === "create" && written.path.endsWith("/"))
    )
      return runTreeToolCommand(deps, call, written, ctx, settle);
    const { context, principal } = call;
    const isInverse = isInverseCommand(written.command);
    const creates = written.command === "create" || written.command === "copy";
    let reached: Reached | undefined;
    let parsed = written;
    if (!isInverse) {
      // The path the model wrote is the node it was shown: a create only looks up its folders.
      const first = await reachShown(deps, call, ctx, written.path, {
        folderOf: creates,
        deleted: !creates,
      });
      if (first.gone)
        return writeToolError(
          written.command,
          goneMessage(written.path, first.gone),
          "document_not_found",
        );
      const removed = await removedAnswer(deps, principal, written, ctx, first);
      if (removed) return settle(async () => removed);
      reached = first;
      parsed = { ...written, path: first.path } as typeof written;
    }
    // A create or copy needs edit on the folder it makes the file in, at the
    // destination the file lands in; the namespace transaction confirms that
    // grant under its locks (seam C).
    const target = creates ? await threadContainerTarget(context.resolution, parsed.path) : null;

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

    // A write to an existing document finds it before the command claims its id.
    let existing: ResolvedDocumentAddress | undefined;
    if (!isInverse && !creates) {
      const found = await resolveDocumentAddress(context, parsed.command, parsed.path);
      if (isToolError(found)) return found;
      existing = found;
    }

    let refresh: DocumentId | undefined;
    const effect = async () => {
      refresh = undefined;
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
        // The node the model was shown, deleted or not: a removed document is answered below.
        const first = await reachShown(deps, call, ctx, written.path, { deleted: true });
        // A reversed creation took the document and its text steps with it.
        if (tree?.kind === "then_text" && !first.node) return tree.answer;
        if (first.gone)
          return writeToolError(
            written.command,
            goneMessage(written.path, first.gone),
            "document_not_found",
          );
        const removed = await removedAnswer(deps, principal, written, ctx, first);
        if (removed) return tree?.kind === "then_text" ? tree.answer : removed;
        reached = first;
        engine = { ...engine, path: first.path } as typeof written;
      }
      const resolveCreated = (beside: boolean) =>
        inContainer(deps, principal, engine.command, target, () =>
          resolveDocumentAddress(context, engine.command, engine.path, {
            ...(beside ? { beside: true as const } : {}),
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
            ...(creates && reached?.node?.kind === "folder" ? { into: reached.node.id } : {}),
            ...(creates
              ? {
                  recordCreate: async ({ documentId, record, folders, draftBranchId, uri }) => {
                    await deps.documentSync.treeHistory().recordAgentTreeChange({
                      subject: documentId,
                      nodes: [{ nodeId: documentId, beforeAt: null, afterAt: uri }],
                      records: [...folders, { record, node: documentId }],
                      threadId: ctx.threadId as ThreadId,
                      ...(ctx.turnId
                        ? { turnId: ctx.turnId as import("@meridian/contracts").TurnId }
                        : {}),
                      ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
                      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
                      op: "create",
                      ...(draftBranchId ? { draftBranchId } : {}),
                      shownAt: uri,
                    });
                  },
                }
              : {}),
          }),
        );
      let address = existing ?? (await resolveCreated(false));
      if (isToolError(address)) return address;

      // The effect can run again: `copied` stays what the source read gave, and each attempt
      // remaps its own copy of it to the document that attempt made.
      const placedAt = (address: ResolvedDocumentAddress) => {
        if (engine.command !== "copy" || !copied) return copied;
        // The copy's new identity is known now: a whole document's own links name the copy, not
        // the original (`collab/domain/copied-blocks.ts`, the one remap a writer Copy also uses).
        // A selection is not the copied set: its links to the whole source keep naming it.
        return {
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
      };
      const writeAt = (at: ResolvedDocumentAddress) =>
        writeUnderGrant(
          deps,
          principal,
          engine,
          at,
          placedAt(at),
          ctx,
          context.resolution.uploadsOwner?.chatRef,
        );

      let outcome = await writeAt(address);
      // The path reaches a document with text: the create makes another of that name, a twin.
      if (creates && outcome.isError && "occupied" in outcome && outcome.occupied) {
        address = await resolveCreated(true);
        if (isToolError(address)) return address;
        outcome = await writeAt(address);
      }
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
      // A create into a folder deleted since brought it back: said as a move into one is.
      if (creates && reached?.kept)
        outcome = {
          ...outcome,
          result: {
            ...outcome.result,
            message: [`kept: ${reached.kept}`, outcome.result.message].filter(Boolean).join("\n"),
          },
        };
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

      if (outcome.result.unchanged !== true && outcome.result.status !== "returned")
        refresh = address.documentId as DocumentId;
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
  return (input: unknown, ctx: ToolHandlerContext) => write(input, ctx);
}

/** A failed edit the server runs again once, under the same command id. */
class TransientEditFailure extends Error {}

/**
 * Runs a call's effect as the command the executor keyed it by, which stores its result with
 * its outcome. An error result is the command's refusal: whatever the effect changed rolls
 * back with it. A returned edit is a done command: nothing changed, and its row says why.
 *
 * A server failure (an apply or a commit that failed, or an effect that threw) is the server's
 * to get past: the effect runs once more under the same command id, and only a second failure
 * is the model's answer, worded as an edit that did not land and asking for no retry.
 */
function effectSettler(
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
  edit: NonNullable<ToolHandlerContext["modelEdit"]>,
  command: WriteToolInput["command"],
): (effect: () => Promise<unknown>) => Promise<unknown> {
  // What a command's effect leaves in memory outlives its rollback. The reply's own updates are
  // the one such state an effect writes; each attempt starts from, and a rolled-back one returns
  // to, what the reply held before it.
  const run = async (effect: () => Promise<unknown>, retried: boolean) => {
    const restore = ctx.frontiers?.reply?.checkpoint();
    const settled = await attempt(effect, retried).catch((cause) => {
      restore?.();
      throw cause;
    });
    if (settled.outcome.status === "refused") restore?.();
    return settled;
  };
  const attempt = (effect: () => Promise<unknown>, retried: boolean) =>
    deps.documentSync.modelEdits().run({
      key: edit.key,
      owner: { threadId: ctx.threadId, turnId: ctx.turnId },
      signal: ctx.signal,
      async effect() {
        const raw = await effect();
        if (!retried && isServerFailure(raw)) throw new TransientEditFailure();
        const rendered = edit.render(raw);
        if (isErrorOutput(raw)) throw new ModelEditRefusal(rendered.toolResult, rendered.evidence);
        const returned = returnedOf(raw);
        return returned
          ? { ...rendered, settled: [{ rule: "returned", why: returned }] }
          : rendered;
      },
    });
  const failed = () =>
    deps.documentSync.modelEdits().run({
      key: edit.key,
      owner: { threadId: ctx.threadId, turnId: ctx.turnId },
      signal: ctx.signal,
      async effect() {
        const rendered = edit.render(
          writeToolError(command, EDIT_FAILED_MESSAGE, "internal_error"),
        );
        throw new ModelEditRefusal(rendered.toolResult, rendered.evidence);
      },
    });
  return async (effect): Promise<ModelEditHandlerResult> => {
    const { outcome, evidence } = await run(effect, false)
      .catch((cause) => {
        if (ctx.signal.aborted) throw cause;
        return run(effect, true);
      })
      .catch((cause) => {
        if (ctx.signal.aborted) throw cause;
        return failed();
      });
    return { modelEdit: outcome, ...(evidence ? { evidence } : {}) };
  };
}

/** The tool's own failure result: an apply or commit that did not land. */
function isServerFailure(value: unknown): boolean {
  if (!isErrorOutput(value)) return false;
  const status = (value as { output?: { status?: unknown } }).output?.status;
  return status === "internal_error" || status === "partial_failure";
}

/** What a returned edit's result says closed it, when the effect returned one. */
function returnedOf(value: unknown): ReturnedWhy | null {
  const output = (value as { output?: { status?: unknown; returned?: { why?: ReturnedWhy } } })
    ?.output;
  return output?.status === "returned" ? (output.returned?.why ?? null) : null;
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
  const parsed = parseDocumentFilename(readSegment(uri.slice(uri.lastIndexOf("/") + 1)).name);
  return parsed.ok ? parsed.value.extension : "";
}
