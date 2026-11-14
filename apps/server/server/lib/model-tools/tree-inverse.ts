/**
 * `undo`, `redo` and `revert` of the model's own tree changes. A node has one history in a chat:
 * its tree receipts and its text edits, ordered by the write ordinal both take from the node's
 * counter, with what was undone left out. Undo takes the newest of them (`count` of them), so a
 * move is reached after a later text edit has been undone, and a text edit made after a move is
 * taken first. The tree receipts are taken back here, each record by the package's `undoChange`
 * (which finds the record's copy when an Apply or a restored Discard replaced it); what is left
 * for the text engine goes back to the caller. A drafted change is taken back in the Work's
 * draft, and in live once an Apply has landed it.
 */
import { modelResult, parseEditHandle } from "@meridian/agent-edit/integration";
import type { BranchId, ThreadId, TurnId } from "@meridian/contracts";
import type { TreeReceipt } from "../../domains/collab/contracts.js";
import { contextPortForThread } from "../../domains/context/index.js";
import { reachPath, runTreeUndo } from "../../domains/context/tree/tree-commands.js";
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
import { reverseAcrossLists } from "./tree-across-lists.js";

type InverseInput = {
  command: "undo" | "redo" | "revert";
  path: string;
  edit?: string;
  count?: number;
};

/** What the tree took back, and what is still the text engine's. */
export type TreeInverse =
  | { kind: "answer"; answer: Awaited<ReturnType<typeof reverseReceipt>> }
  | { kind: "then_text"; count: number; undone: string[] };

type Chosen = { receipts: TreeReceipt[]; text: number };

/**
 * The steps this call takes, newest first across both kinds, or null when none is the tree's.
 * Redo takes only the tree receipts undone after the text engine's newest undo: the text side
 * does not say what comes after its first candidate.
 */
function choose(
  input: InverseInput,
  history: Awaited<
    ReturnType<ReturnType<ToolWiringDeps["documentSync"]["treeHistory"]>["historyOf"]>
  >,
): Chosen | "insufficient" | null {
  const count = input.command === "revert" ? 1 : (input.count ?? 1);
  if (input.command === "revert") {
    const handle = input.edit === undefined ? undefined : parseEditHandle(input.edit);
    const picked = history.all.find((receipt) => receipt.wId === handle && receipt.kind !== "undo");
    return picked ? { receipts: [picked], text: 0 } : null;
  }
  if (input.command === "redo") {
    const after = history.text.redo ?? 0;
    const receipts = history.redo.filter((receipt) => receipt.wId > after).slice(0, count);
    return receipts.length > 0 ? { receipts, text: 0 } : null;
  }
  const steps = [
    ...history.undo.map((receipt) => ({ at: receipt.wId, receipt })),
    ...history.text.undo.map((at) => ({ at, receipt: null })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, count);
  const receipts = steps.flatMap((step) => (step.receipt ? [step.receipt] : []));
  if (receipts.length === 0) return null;
  if (steps.length < count) return "insufficient";
  return { receipts, text: steps.length - receipts.length };
}

export async function runTreeInverse(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: InverseInput,
  ctx: ToolHandlerContext,
): Promise<TreeInverse | null> {
  const parts = areaOfPath(input.path);
  if (!parts) return null;
  const shown = await shownNamesOf(ctx);
  const threadId = ctx.threadId as ThreadId;
  const reached = await call.context.port.readTree(parts.area, {
    read: (scope) =>
      reachPath(scope, parts.area, shown, parts.rest, input.command, { allowGone: true }),
  });
  const treeHistory = deps.documentSync.treeHistory();
  let node: { id: string; kind: string } | undefined;
  if (reached.ok && reached.value.kind === "node") node = reached.value.node;
  else {
    // A node deleted since, named by the path the model wrote for it, is found by that receipt.
    const written = await treeHistory.receiptsAt(threadId, `${parts.area}${parts.rest}`);
    const deleted = written.find((receipt) => receipt.op === "delete");
    if (deleted)
      node = { id: deleted.subject, kind: parts.rest.endsWith("/") ? "folder" : "document" };
  }
  if (!node) return null;
  const history = await treeHistory.historyOf(threadId, node.id, node.kind !== "folder");
  const chosen = choose(input, history);
  if (chosen === null) return null;
  if (chosen === "insufficient")
    return {
      kind: "answer",
      answer: writeToolError(
        input.command,
        `Only ${history.undo.length + history.text.undo.length} ${history.undo.length + history.text.undo.length === 1 ? "edit" : "edits"} to undo in ${input.path}; requested ${input.count}. Nothing was changed.`,
      ),
    };

  const done: Array<Awaited<ReturnType<typeof reverseReceipt>>> = [];
  for (const receipt of chosen.receipts) {
    const answer = await reverseReceipt(deps, call, input, ctx, receipt, node.id);
    done.push(answer);
    if ("isError" in answer && answer.isError) break;
  }
  const last = done.at(-1) as (typeof done)[number];
  if (chosen.text === 0 || ("isError" in last && last.isError))
    return { kind: "answer", answer: last };
  return {
    kind: "then_text",
    count: chosen.text,
    undone: chosen.receipts.map((receipt) => `e${receipt.wId}`),
  };
}

/** One receipt taken back on its own list, with the receipt that names it. */
async function reverseReceipt(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: InverseInput,
  ctx: ToolHandlerContext,
  receipt: TreeReceipt,
  nodeId: string,
) {
  const parts = areaOfPath(input.path) as NonNullable<ReturnType<typeof areaOfPath>>;
  const history = deps.documentSync.treeHistory();
  const threadId = ctx.threadId as ThreadId;
  const target = await threadContainerTarget(deps.works, call.context.resolution, input.path);
  const grant = target ? await deps.fileAccess.authorize(call.principal, target, "edit") : null;
  if (grant && "denied" in grant) return fileAccessDeniedError(input.command, grant, input.path);
  if (receipt.across) {
    // The other end of a move between lists: its own container, its own grant.
    const otherTarget = await threadContainerTarget(
      deps.works,
      call.context.resolution,
      receipt.across.from,
    );
    const other = otherTarget
      ? await deps.fileAccess.authorize(call.principal, otherTarget, "edit")
      : null;
    if (other && "denied" in other)
      return fileAccessDeniedError(input.command, other, receipt.across.from);
    return reverseAcrossLists(
      deps,
      call,
      ctx,
      [grant, other].flatMap((granted) => (granted ? [granted] : [])),
      input.command,
      receipt as TreeReceipt & { across: { from: string; to: string } },
    );
  }
  const drafted = receipt.draftBranchId !== null;
  const port = drafted
    ? call.context.port
    : contextPortForThread(deps.contextPorts, call.context.resolution, {
        responseId: ctx.responseIdentity?.editScopeId ?? null,
        liveWrites: true,
      });
  let handle: string | undefined;
  const kind = input.command === "redo" ? "redo" : "undo";
  const places = { area: parts.area, roots: new Map<string, string>(), locate: () => null };

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
        places.roots.set(parts.area, scope.root);
        return {
          result: runTreeUndo(scope, places, receipt.records, nodeId, input.path),
          arrived: [],
        };
      },
      afterWrite: async (result, scope) => {
        if (result.made.length === 0) return;
        const recorded = await history.recordAgentTreeChange({
          subject: receipt.subject,
          nodes: result.touched.map((touched) => ({
            nodeId: touched.node,
            beforeAt: touched.before,
            afterAt: touched.after,
          })),
          records: result.made,
          op: receipt.op,
          threadId,
          ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
          ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
          ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
          // An applied change is taken back in live: the Work's draft no longer has it.
          ...(scope.view.draft && !result.inLive
            ? { draftBranchId: scope.view.draft as BranchId }
            : {}),
          shownAt: input.path,
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
    ...(done.kept ? { tree: { kept: done.kept } } : {}),
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
