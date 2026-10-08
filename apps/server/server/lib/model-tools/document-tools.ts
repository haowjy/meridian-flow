/**
 * The `read` and `write` tools (D1): a path resolves to its tracked document,
 * the file policy grants the call, and the collab pool reads or writes under
 * that grant. `skills://` paths go to the skill files (D52).
 */
import type {
  DocumentCommandName,
  ReadToolInput,
  WriteCommand,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import {
  documentNotFoundMessage,
  formatDocumentFile,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import type { RoutedWriteOutcome } from "../../domains/collab/index.js";
import type { DocumentCreationMetadata } from "../../domains/context/document-metadata.js";
import {
  type FileDestination,
  FileEditRefusedError,
  type Principal,
} from "../../domains/file-policy/index.js";
import {
  isSkillsUri,
  readSkill,
  refuseSkillWrite,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
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
  fileAccessDeniedError,
  firstRefusal,
  inContainer,
  keptDraftReader,
  withDraftWork,
  withRefusedWrites,
} from "./file-access.js";
import { readDocument } from "./read-document.js";
import { deleteCreatedTrackedDocument } from "./response-write-lifecycle.js";
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

/** Resolves a model path to its tracked document; only `create` may make one. */
export async function resolveDocumentAddress(
  context: ResolvedModelContextPort,
  command: DocumentCommandName,
  path: string,
  options: {
    deferTrackedDocumentSync?: boolean;
    metadata?: DocumentCreationMetadata;
    origin?: import("../../domains/context/index.js").WriteProvenance;
  } = {},
): Promise<ResolvedDocumentAddress | WriteToolErrorOutput> {
  const port = context.port;
  const { filePath: basePath, fragment } = splitDocumentFile(path);
  if (command === "create" || command === "copy") {
    if (fragment) return writeToolError(command, `${command} does not accept a #fragment in path`);
    const ensureOptions = {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.deferTrackedDocumentSync ? { deferDocumentSync: true } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
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
      filePath: ensured.value.uri.startsWith("scratch://@/") ? ensured.value.uri : basePath,
      created: ensured.value.created,
    };
  }

  const ref = await port.stat(basePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found") {
      return writeToolError(command, documentNotFoundMessage(command), "document_not_found", {
        path,
      });
    }
    // A URI naming no Work or no scheme addresses no document; the reason lists the valid ones.
    const unknownAddress =
      ref.error.code === "invalid_uri" &&
      (ref.error.workSlug !== undefined || ref.error.unknownScheme !== undefined);
    return writeToolError(
      command,
      contextErrorMessage(ref.error),
      unknownAddress ? "document_not_found" : "invalid_write",
      unknownAddress ? { path } : {},
    );
  }
  if (ref.value.kind !== "tracked") {
    return writeToolError(
      command,
      command === "read"
        ? "The file is binary, so it can't be read as text."
        : "The file is binary, so it can't be edited as text.",
      "binary_file",
      { path },
    );
  }
  if (!ref.value.documentId) {
    return writeToolError(command, `Document id missing for ${path}`);
  }
  return {
    documentId: ref.value.documentId,
    uri: ref.value.uri,
    filePath: ref.value.uri.startsWith("scratch://@/") ? ref.value.uri : basePath,
    ...(fragment === undefined ? {} : { fragment }),
  };
}

function buildAgentWriteCommand(
  input: WriteToolInput,
  address: ResolvedDocumentAddress,
  toolUseId: string | undefined,
): WriteCommand {
  const { path: _path, ...command } = input;
  return {
    ...command,
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
      ...(destination.kind === "draft" ? { draftWork: destination.workSlug ?? "/" } : {}),
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
  parsed: WriteToolInput,
  address: ResolvedDocumentAddress,
  copied: CopiedSource | undefined,
  ctx: ToolHandlerContext,
): Promise<(WriteOutcome & { isError: false }) | WriteToolErrorOutput> {
  const grant = await documentGrant(deps, principal, parsed.command, address, "edit");
  if (isToolError(grant)) return grant;
  let written: RoutedWriteOutcome;
  try {
    written = await deps.documentSync
      .agentEdit()
      .write(buildAgentWriteCommand(parsed, address, ctx.toolCallId), {
        sessionId: ctx.threadId,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        responseId: ctx.responseId,
        tool_use_id: ctx.toolCallId,
        createdDocument: address.created === true,
        grant,
        ...(copied ? { copiedNodes: copied.nodes } : {}),
      });
  } catch (cause) {
    if (!(cause instanceof FileEditRefusedError)) throw cause;
    return fileAccessDeniedError(parsed.command, firstRefusal(cause), address.filePath);
  }
  if (written.isError) return { isError: true, output: written.result };
  // Undo and redo go where history says, so only forward writes name a destination.
  const reversal = parsed.command === "undo" || parsed.command === "redo";
  return (
    reversal ? withRefusedWrites(written) : withDestination(written, grant.destination)
  ) as WriteOutcome & { isError: false };
}

export function createReadHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const { path, format, version, ...selection } = input as ReadToolInput;
    if (isSkillsUri(path)) return readSkill(deps, ctx.threadId, input as ReadToolInput);
    const call = await resolveToolCall(deps, ctx, version);
    if (isToolError(call)) return writeToolError("read", call.output.message);
    const address = await resolveDocumentAddress(call.context, "read", path);
    if (isToolError(address)) return address;
    const reader =
      version === "draft"
        ? await keptDraftReader(deps, call.principal, call.execution, address.documentId)
        : call.principal;
    const grant = await documentGrant(deps, reader, "read", address, "read");
    if (isToolError(grant)) return grant;
    const outcome = await readDocument(
      deps,
      grant,
      address,
      { selection, format, ...(version ? { version } : {}) },
      ctx,
    );
    if (outcome.isError) return { isError: true, output: outcome.result };
    recordTouchInBackground(deps, address.documentId, ctx);
    return {
      output: outcome.result,
      metadata: documentRevisionMetadata(address, outcome.revision),
    };
  };
}

export function createWriteHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const parsed = input as WriteToolInput;
    const skillRefusal = refuseSkillWrite(parsed);
    if (skillRefusal) return skillRefusal;
    const call = await resolveToolCall(deps, ctx);
    if (isToolError(call)) return writeToolError(parsed.command, call.output.message);
    const { context, principal } = call;
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
        // A binary copy always lands live (D24), so its folder is judged live.
        return inContainer(deps, withDraftWork(principal, null), parsed.command, target, () =>
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

    const address = await inContainer(deps, principal, parsed.command, target, () =>
      resolveDocumentAddress(context, parsed.command, parsed.path, {
        origin: {
          type: "agent",
          agentSlug: ctx.agentSlug,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
        },
        deferTrackedDocumentSync: creates && ctx.responseId !== undefined,
        ...(parsed.command === "copy" && copied
          ? { metadata: { copiedFrom: copied.copiedFrom } }
          : {}),
      }),
    );
    if (isToolError(address)) return address;

    const outcome = await writeUnderGrant(deps, principal, parsed, address, copied, ctx);
    const stagedCreate = creates && ctx.responseId !== undefined && address.created === true;
    if (outcome.isError) {
      if (stagedCreate) {
        try {
          await deleteCreatedTrackedDocument({
            port: context.port,
            path: parsed.path,
            documentId: address.documentId,
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
      return { isError: true, output: outcome.output };
    }
    if (stagedCreate) {
      const responseId = ctx.responseId;
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
    // Undo and redo apply at once; every other write stages until the response
    // commits. A write that changed nothing has nothing to stage or refresh.
    const unchanged = outcome.result.unchanged === true;
    const stagedWrite =
      !unchanged &&
      ctx.responseId !== undefined &&
      parsed.command !== "undo" &&
      parsed.command !== "redo";
    if (!stagedWrite && !unchanged) {
      await deps.documentSync.refreshDocumentProjection({
        documentId: address.documentId,
        threadId: ctx.threadId,
      });
    }
    return {
      output: outcome.result,
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
    };
  };
}
