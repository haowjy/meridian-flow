/**
 * `undo`, `redo` and `revert` of the model's own tree changes: the receipt a tree call kept names
 * the records it admitted, and each is taken back by the package's `undoChange`, which finds the
 * record's copy when an Apply or a restored Discard has replaced it. A drafted change is taken
 * back in the Work's draft, and in live once an Apply has landed it. A path that names a node
 * whose newest edit is a text edit is left to the text engine.
 */
import { modelResult, parseEditHandle } from "@meridian/agent-edit/integration";
import type { BranchId, ThreadId, TurnId } from "@meridian/contracts";
import { LIVE, undoChange } from "@meridian/project-tree";
import type { TreeReceipt } from "../../domains/collab/contracts.js";
import { contextPortForThread } from "../../domains/context/index.js";
import { changeDelta, pathNames, type ShownDelta } from "../../domains/context/tree/names-shown.js";
import { reachPath } from "../../domains/context/tree/tree-commands.js";
import { runWithEditGrants } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { threadContainerTarget } from "../file-targets.js";
import { fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { areaOfPath, namesEvidence, shownNamesOf } from "./shown-paths.js";
import {
  contextErrorMessage,
  type ToolCall,
  type ToolWiringDeps,
  writeToolError,
} from "./tool-context.js";

type InverseInput = { command: "undo" | "redo" | "revert"; path: string; edit?: string };

type Done = {
  outcomes: Array<"superseded" | "unknown">;
  made: Array<{ record: string; node: string }>;
  landedAt: string;
  delta: ShownDelta;
};

/** The receipt this call reverses, or null when the call belongs to the text engine. */
async function pick(
  deps: ToolWiringDeps,
  input: InverseInput,
  threadId: ThreadId,
  nodeId: string,
  isDocument: boolean,
): Promise<TreeReceipt | null> {
  const history = deps.documentSync.treeHistory();
  const receipts = await history.receiptsFor(threadId, nodeId);
  const reversed = new Set(
    receipts.flatMap((receipt) => (receipt.reverses ? [receipt.reverses] : [])),
  );
  let picked: TreeReceipt | undefined;
  if (input.command === "revert") {
    const handle = input.edit === undefined ? undefined : parseEditHandle(input.edit);
    picked = receipts.find((receipt) => receipt.wId === handle && receipt.kind !== "undo");
  } else if (input.command === "undo")
    picked = receipts.find((receipt) => receipt.kind !== "undo" && !reversed.has(receipt.id));
  else picked = receipts.find((receipt) => receipt.kind === "undo" && !reversed.has(receipt.id));
  if (!picked) return null;
  if (input.command === "revert") return picked;
  // The newest edit of a document is what undo and redo take; a text edit after the receipt is it.
  if (isDocument) {
    const text = await history.latestTextEditAt(threadId, nodeId);
    if (text && text > picked.createdAt) return null;
  }
  return picked;
}

export async function runTreeInverse(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: InverseInput,
  ctx: ToolHandlerContext,
) {
  const parts = areaOfPath(input.path);
  if (!parts) return null;
  const shown = await shownNamesOf(ctx);
  const threadId = ctx.threadId as ThreadId;
  const reached = await call.context.port.readTree(parts.area, {
    read: (scope) =>
      reachPath(scope, parts.area, shown, parts.rest, input.command, { allowGone: true }),
  });
  const history = deps.documentSync.treeHistory();
  let node: { id: string; kind: string } | undefined;
  if (reached.ok && reached.value.kind === "node") node = reached.value.node;
  else {
    // A node deleted since, named by the path the model wrote for it, is found by that receipt.
    const written = await history.receiptsAt(threadId, `${parts.area}${parts.rest}`);
    const deleted = written.find((receipt) => receipt.op === "delete");
    if (deleted)
      node = { id: deleted.nodeId, kind: parts.rest.endsWith("/") ? "folder" : "document" };
  }
  if (!node) return null;
  const receipt = await pick(deps, input, threadId, node.id, node.kind !== "folder");
  if (!receipt) return null;

  const target = await threadContainerTarget(deps.works, call.context.resolution, input.path);
  const grant = target ? await deps.fileAccess.authorize(call.principal, target, "edit") : null;
  if (grant && "denied" in grant) return fileAccessDeniedError(input.command, grant, input.path);
  const drafted = receipt.draftBranchId !== null;
  const port = drafted
    ? call.context.port
    : contextPortForThread(deps.contextPorts, call.context.resolution, {
        responseId: ctx.responseIdentity?.editScopeId ?? null,
        liveWrites: true,
      });
  let handle: string | undefined;
  const kind = input.command === "redo" ? "redo" : "undo";

  const run = await runWithEditGrants(deps.fileAccess, grant ? [grant] : [], () =>
    port.treeCommand(parts.area, {
      origin: {
        type: "agent",
        agentSlug: ctx.agentSlug,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
      },
      drafted,
      make: (scope) => {
        const before = scope.writer.view(scope.view);
        const made: Done["made"] = [];
        const outcomes: Done["outcomes"] = [];
        // A change goes back newest record first; redo takes back the undo's records the same way.
        for (const entry of [...receipt.records].reverse()) {
          let back = undoChange(scope.writer, scope.view, scope.actor, entry.record);
          // An applied change lives on as a live copy: the Work's draft no longer has it.
          if (typeof back === "string" && scope.view.draft !== null)
            back = undoChange(scope.writer, LIVE, scope.actor, entry.record);
          if (typeof back === "string") outcomes.push(back);
          else made.push({ record: back.id, node: entry.node });
        }
        const after = scope.writer.view(scope.view);
        const touched = [...new Set(made.map((entry) => entry.node))];
        const emptied = touched.flatMap((id) => {
          const was = before.nodes.get(id);
          return was ? [{ folder: was.parent, name: was.displayName }] : [];
        });
        const filled = touched.flatMap((id) => {
          const now = after.nodes.get(id);
          return now && !now.trashed
            ? [{ folder: now.parent, name: now.displayName, node: id }]
            : [];
        });
        const here = after.nodes.get(node.id);
        return {
          result: {
            outcomes,
            made,
            landedAt: here
              ? `${parts.area}${pathNames(after, node.id).join("/")}${here.kind === "folder" ? "/" : ""}`
              : input.path,
            delta: changeDelta(emptied, filled),
          },
          arrived: [],
        };
      },
      afterWrite: async (result, scope) => {
        if (result.made.length === 0) return;
        const recorded = await history.recordAgentTreeChange({
          nodeId: receipt.nodeId,
          records: result.made,
          op: receipt.op,
          threadId,
          ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
          ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
          ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
          ...(scope.view.draft ? { draftBranchId: scope.view.draft as BranchId } : {}),
          shownAt: input.path,
          landedAt: result.landedAt,
          reverses: { kind, receipt: receipt.id },
        });
        handle = recorded.handle;
      },
    }),
  );
  if (!run.ok) return fileAccessDeniedError(input.command, firstRefusal(run.refusal), input.path);
  if (!run.value.ok) return writeToolError(input.command, contextErrorMessage(run.value.error));
  const done = run.value.value;
  const landed = done.made.length;
  const status =
    landed === 0
      ? input.command === "redo"
        ? "cant_redo_changed"
        : "cant_undo_changed"
      : done.outcomes.length > 0
        ? "partial"
        : "reversed";
  const payload = {
    path: done.landedAt,
    ...(handle ? { write: { id: handle } } : {}),
    ...(landed === 0
      ? {
          message: `Can't ${input.command}: something changed it after that change, or it is gone.`,
        }
      : {}),
  };
  return {
    ...(landed === 0 ? { isError: true as const } : {}),
    output: modelResult({ command: input.command, status, payload }),
    metadata: { treeWrite: true },
    evidence: { shown: [], ...namesEvidence(done.delta) },
  };
}
