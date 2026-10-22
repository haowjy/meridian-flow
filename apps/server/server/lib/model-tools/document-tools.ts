/**
 * The `read` and `write` tools (D1): a path resolves to its tracked document,
 * the file policy grants the call, and the collab pool reads or writes under
 * that grant. `skills://` paths go to the skill files (D52).
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
import { documentPathKey } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { DocumentCreationMetadata } from "../../domains/context/document-metadata.js";
import {
  type FileDestination,
  FileEditRefusedError,
  type FileGrant,
  type Principal,
} from "../../domains/file-policy/index.js";
import {
  isSkillsUri,
  type ResultEvidence,
  readSkill,
  refuseSkillWrite,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { removedFileResult } from "../file-access-denial-copy.js";
import { threadContainerTarget } from "../file-targets.js";
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
import { currentUri, resolveDisplacedTarget, resolveInverseTarget } from "./inverse-address.js";
import { runNamespaceCommand } from "./namespace-commands.js";
import { readDocument } from "./read-document.js";
import { retractCreatedTrackedDocument } from "./response-write-lifecycle.js";
import { evidenceOf, threadShownLinks } from "./shown-link-capture.js";
import {
  contextErrorMessage,
  documentRevisionMetadata,
  isToolError,
  type ResolvedDocumentAddress,
  type ResolvedModelContextPort,
  recordTouchInBackground,
  resolveToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

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
  const canonicalPath = documentPathKey(basePath) + (fragment === undefined ? "" : `#${fragment}`);
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
        path: canonicalPath,
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
        path: canonicalPath,
      });
    }
    return writeToolError(
      command,
      contextErrorMessage(ref.error),
      unknownAddress ? "document_not_found" : "invalid_write",
      unknownAddress ? { path: canonicalPath } : {},
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
    return writeToolError(command, `Document id missing for ${canonicalPath}`);
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
function withDestination(outcome: WriteOutcome, destination: FileDestination): WriteOutcome {
  if (outcome.isError) return outcome;
  return {
    ...outcome,
    result: {
      ...outcome.result,
      destination: destination.kind,
      ...(destination.kind === "draft" ? { draftWork: destination.workHandle ?? "/" } : {}),
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
    written = await deps.documentSync
      .agentEdit()
      .write(buildAgentWriteCommand(parsed, address, ctx.toolCallId, copied), {
        sessionId: ctx.threadId,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        responseIdentity: ctx.responseIdentity,
        tool_use_id: ctx.toolCallId,
        createdDocument: address.created === true,
        ...(uploadsChat ? { uploadsChat } : {}),
        grant,
        shownLinks: threadShownLinks(deps, ctx.threadId),
        ...(ctx.frontiers ? { frontiers: ctx.frontiers } : {}),
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
  // was a partial failure's echo and a region refusal's current text. Whatever
  // frontier a result carries records, error or not.
  const evidence = evidenceOf(address.documentId, written);
  if (written.isError) return { isError: true, output: written.result, evidence };
  // Showing and frontier are host-only: they leave here only as `evidence`.
  const { showing: _showing, frontier: _frontier, ...outcome } = written;
  return { ...withDestination(outcome, grant.destination), evidence } as WriteOutcome & {
    isError: false;
    evidence: ResultEvidence;
  };
}

/** Shared tracked read: ordinary tool arguments, optionally pinned to a known identity. */
export async function readTrackedDocument(
  deps: ToolWiringDeps,
  input: ReadToolInput,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseIdentity" | "toolCallId">,
  options: { expectedDocumentId?: string; recordingFrontier?: FrontierLookup } = {},
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
  const address = await resolveDocumentAddress(call.context, "read", path);
  if (isToolError(address)) return { ...address, revision: null };
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
      ? await keptDraftReader(deps, call.principal, call.execution, address.documentId)
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
  recordTouchInBackground(deps, address.documentId, ctx);
  const owner = await deps.contextPorts.chatFiles.notice(
    call.context.resolution.thread.projectId,
    path,
    address.uri,
  );
  // Only a draft that outlived a live delete reads a deleted document (D79).
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
    evidence: evidenceOf(address.documentId, outcome),
  };
}

export function createReadHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const parsed = input as ReadToolInput;
    if (isSkillsUri(parsed.path)) return readSkill(deps, ctx.threadId, parsed);
    const { revision: _revision, ...result } = await readTrackedDocument(deps, parsed, ctx, {
      ...(ctx.frontiers ? { recordingFrontier: ctx.frontiers.recording } : {}),
    });
    return result;
  };
}

export function createWriteHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const parsed = input as WriteToolInput;
    const skillRefusal = refuseSkillWrite(parsed);
    if (skillRefusal) return skillRefusal;
    const call = await resolveToolCall(deps, ctx);
    if (isToolError(call)) return writeToolError(parsed.command, call.output.message);
    if (parsed.command === "move" || parsed.command === "delete")
      return runNamespaceCommand(deps, call, parsed, ctx);
    const { context, principal } = call;
    const inverse =
      parsed.command === "undo" || parsed.command === "redo" || parsed.command === "revert"
        ? await resolveInverseTarget(deps, call, parsed.command, parsed.path, ctx.threadId)
        : null;
    if (isToolError(inverse)) return inverse;
    const creates = parsed.command === "create" || parsed.command === "copy";
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
        return inContainer(deps, principal, parsed.command, target, () =>
          copyBinary(deps, context, parsed, binary, sourceGrant, ctx),
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
      copied = read;
    } else if ((parsed.command === "insert" || parsed.command === "replace") && parsed.from) {
      const read = await readCopySource(deps, principal, parsed.command, parsed.from, ctx);
      if (isToolError(read)) return read;
      copied = read;
    }

    let address = inverse
      ? inverse.address
      : await inContainer(deps, principal, parsed.command, target, () =>
          resolveDocumentAddress(context, parsed.command, parsed.path, {
            origin: {
              type: "agent",
              agentSlug: ctx.agentSlug,
              threadId: ctx.threadId,
              turnId: ctx.turnId,
            },
            ...(parsed.command === "copy" && copied
              ? {
                  metadata: { copiedFrom: copied.copiedFrom },
                  sourceExtension: sourceExtension(copied.copiedFrom.uri),
                }
              : {}),
            ...(creates
              ? {
                  recordCreate: async ({ documentId, change }) => {
                    await deps.documentSync.treeHistory().recordAgentTreeChange({
                      documentId,
                      threadId: ctx.threadId as import("@meridian/contracts").ThreadId,
                      ...(ctx.turnId
                        ? { turnId: ctx.turnId as import("@meridian/contracts").TurnId }
                        : {}),
                      ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
                      op: "create",
                      change,
                      shownAt: parsed.path,
                    });
                  },
                }
              : {}),
          }),
        );
    if (isToolError(address)) return address;

    let outcome = await writeUnderGrant(
      deps,
      principal,
      parsed,
      address,
      copied,
      ctx,
      context.resolution.uploadsOwner?.chatRef,
      inverse?.grant,
    );
    // Nothing of this chat's to reverse here, where it moved or deleted another document away.
    if (
      inverse &&
      (parsed.command === "undo" || parsed.command === "redo" || parsed.command === "revert") &&
      ["nothing_to_undo", "nothing_to_redo", "invalid_write"].includes(
        outcome.isError ? outcome.output.status : outcome.result.status,
      )
    ) {
      const displaced = await resolveDisplacedTarget(
        deps,
        call,
        parsed.command,
        address,
        ctx.threadId,
      );
      if (isToolError(displaced)) return displaced;
      if (displaced) {
        address = displaced.address;
        outcome = await writeUnderGrant(
          deps,
          principal,
          parsed,
          address,
          copied,
          ctx,
          context.resolution.uploadsOwner?.chatRef,
          displaced.grant,
        );
      }
    }
    // A reversed move left the document somewhere else: the result names where it is now. A
    // reversed creation removed the document, so its text half must not claim an empty document
    // survived the tree half of the same inverse.
    if (inverse && !outcome.isError && outcome.result.status === "success") {
      const now = await currentUri(call, address.documentId);
      if (now && now !== outcome.result.path)
        outcome = { ...outcome, result: { ...outcome.result, path: now } };
      else if (!now && outcome.result.documentEmpty)
        outcome = { ...outcome, result: { ...outcome.result, documentEmpty: false } };
    }
    const stagedCreate =
      creates && ctx.responseIdentity?.editScopeId !== undefined && address.created === true;
    if (outcome.isError) {
      if (stagedCreate) {
        try {
          await retractCreatedTrackedDocument({
            port: context.port,
            path: parsed.path,
            documentId: address.documentId,
            cause: "create_failed",
          });
        } catch (error) {
          return writeToolError(
            parsed.command,
            `Failed to discard staged create for ${parsed.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "internal_error",
          );
        }
      }
      return { isError: true, output: outcome.output, evidence: outcome.evidence };
    }
    if (stagedCreate) {
      const responseId = ctx.responseIdentity?.editScopeId;
      if (responseId === undefined) {
        return writeToolError(parsed.command, "Missing staged response id", "internal_error");
      }
      deps.responseWrites.trackStagedCreate({
        responseId,
        port: context.port,
        path: parsed.path,
        documentId: address.documentId,
      });
    }

    recordTouchInBackground(deps, address.documentId, ctx);
    // Settlement phase, not command names, decides who still owes admission.
    const unchanged = outcome.result.unchanged === true;
    const stagedWrite = outcome.status === "success" && outcome.phase === "staged";
    if (!stagedWrite && !unchanged) {
      await deps.documentSync.refreshDocumentProjection({
        documentId: address.documentId,
        threadId: ctx.threadId,
      });
    }
    const notice = await deps.contextPorts.chatFiles.notice(
      context.resolution.thread.projectId,
      parsed.path,
      address.uri,
    );
    return {
      output: notice ? { ...outcome.result, ...notice } : outcome.result,
      metadata: {
        ...documentRevisionMetadata(address, outcome.revision),
        ...(stagedWrite
          ? {
              documentId: address.documentId,
              stagedWrite: true,
              ...(outcome.writeId ? { writeId: outcome.writeId } : {}),
              ...(outcome.settlementId ? { settlementId: outcome.settlementId } : {}),
            }
          : {}),
      },
      evidence: outcome.evidence,
    };
  };
}

function sourceExtension(uri: string): string {
  const parsed = parseDocumentFilename(uri.slice(uri.lastIndexOf("/") + 1));
  return parsed.ok ? parsed.value.extension : "";
}
