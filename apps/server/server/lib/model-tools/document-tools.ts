/**
 * The `read` and `write` tools: a path resolves to its tracked document,
 * the file policy grants the call, and the collab pool reads or writes under
 * that grant. `skills://` paths go to the skill files.
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
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { ModelInfo } from "@meridian-flow/gateway";
import { createCopyIdentityMap, remapCopiedBlocks } from "../../domains/collab/index.js";
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
import { retractCreatedTrackedDocument } from "./response-write-lifecycle.js";
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
  return async (input: unknown, ctx: ToolHandlerContext) => {
    let written = input as WriteToolInput;
    const skillRefusal = refuseSkillWrite(written);
    if (skillRefusal) return skillRefusal;
    const call = await resolveToolCall(deps, ctx);
    if (isToolError(call)) return writeToolError(written.command, call.output.message);
    if (
      written.command === "move" ||
      written.command === "delete" ||
      written.command === "restore" ||
      (written.command === "create" && written.path.endsWith("/"))
    )
      return runTreeToolCommand(deps, call, written, ctx);
    // What the tree took back of this call's `count`, said before the text engine's own line.
    let treeUndone: string[] = [];
    if (written.command === "undo" || written.command === "redo" || written.command === "revert") {
      const tree = await runTreeInverse(deps, call, written, ctx);
      if (tree?.kind === "answer") return tree.answer;
      if (tree?.kind === "then_text") {
        treeUndone = tree.undone;
        written = { ...written, count: tree.count } as typeof written;
      }
    }
    const { context, principal } = call;
    const isInverse =
      written.command === "undo" || written.command === "redo" || written.command === "revert";
    const creates = written.command === "create" || written.command === "copy";
    // The path the model wrote is the node it was shown: a create only looks up its folders.
    const reached = await reachShown(call, ctx, written.command, written.path, {
      folderOf: creates,
    });
    if (isToolError(reached)) return reached;
    const parsed = { ...written, path: reached.path } as typeof written;
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

    const address = await inContainer(deps, principal, parsed.command, target, () =>
      resolveDocumentAddress(context, parsed.command, parsed.path, {
        origin: {
          type: "agent",
          agentSlug: ctx.agentSlug,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
        },
        ...(parsed.command === "copy" && copied
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
                  nodes: [{ nodeId: documentId, beforeAt: null, afterAt: parsed.path }],
                  records: [{ record, node: documentId }],
                  threadId: ctx.threadId as import("@meridian/contracts").ThreadId,
                  ...(ctx.turnId
                    ? { turnId: ctx.turnId as import("@meridian/contracts").TurnId }
                    : {}),
                  ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
                  ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
                  op: "create",
                  ...(draftBranchId ? { draftBranchId } : {}),
                  shownAt: parsed.path,
                });
              },
            }
          : {}),
      }),
    );
    if (isToolError(address)) return address;

    if (parsed.command === "copy" && copied) {
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
      parsed,
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
    if (treeUndone.length > 0 && !outcome.isError)
      outcome = {
        ...outcome,
        result: {
          ...outcome.result,
          message: [`undone: ${treeUndone.join(", ")}`, outcome.result.message]
            .filter(Boolean)
            .join("\n"),
        },
      };
    const stagedCreate =
      creates && ctx.responseIdentity?.editScopeId !== undefined && address.created === true;
    if (outcome.isError) {
      if (stagedCreate) {
        try {
          await retractCreatedTrackedDocument({
            port: context.port,
            uri: address.uri,
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
        uri: address.uri,
        documentId: address.documentId,
      });
    }

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
      evidence: {
        ...outcome.evidence,
        ...namesEvidence(
          // A create's own name and an inverse's new place are printed too.
          await printedOf(call, address, creates || isInverse ? null : reached),
        ),
      },
    };
  };
}

function sourceExtension(uri: string): string {
  const parsed = parseDocumentFilename(uri.slice(uri.lastIndexOf("/") + 1));
  return parsed.ok ? parsed.value.extension : "";
}
