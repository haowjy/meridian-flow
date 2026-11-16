/**
 * `undo` and `revert` of the model's own tree changes. A node has one history in a chat:
 * its tree receipts and its text edits, ordered by the write ordinal both take from the node's
 * counter, with what was undone left out. Undo takes the newest of them (`count` of them), so a
 * move is reached after a later text edit has been undone, and a text edit made after a move is
 * taken first. The tree receipts are taken back here, in one walk of the package's `takeBackAll`
 * (which finds the record's copy when an Apply or a restored Discard replaced it); what is left
 * for the text engine goes back to the caller. A drafted change is taken back in the Work's
 * draft, and in live once an Apply has landed it.
 */
import { modelResult, parseEditHandle } from "@meridian/agent-edit/integration";
import type { BranchId, ThreadId, TurnId } from "@meridian/contracts";
import { undoReports } from "@meridian/project-tree";
import type { TreeReceipt } from "../../domains/collab/contracts.js";
import { contextPortForThread } from "../../domains/context/index.js";
import { folderHolds, reachPath, runTreeUndo } from "../../domains/context/tree/tree-commands.js";
import { runWithEditGrants } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { type ClosedSource, withTreeOwners } from "../../shared/tree-owners.js";
import { getDb } from "../db.js";
import { threadContainerTarget } from "../file-targets.js";
import { fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { areaOfPath, namesEvidence, shownNamesOf } from "./shown-paths.js";
import {
  contextErrorMessage,
  type ToolCall,
  type ToolWiringDeps,
  writeToolError,
} from "./tool-context.js";

type InverseInput = {
  command: "undo" | "revert";
  path: string;
  edit?: string;
  count?: number;
};

/** What the tree took back, and what is still the text engine's. */
export type TreeInverse =
  | { kind: "answer"; answer: Awaited<ReturnType<typeof reverseReceipt>> }
  | {
      kind: "then_text";
      count: number;
      undone: string[];
      /** The tree half's answer: all the call has to say when the node it took back had the text. */
      answer: Awaited<ReturnType<typeof reverseReceipt>>;
    };

type TreeHistory = ReturnType<ToolWiringDeps["documentSync"]["treeHistory"]>;

type Chosen = { receipts: TreeReceipt[]; text: number };

/**
 * The steps this call takes, newest first across both kinds, or null when none is the tree's.
 */
function choose(
  input: InverseInput,
  history: Awaited<ReturnType<TreeHistory["historyOf"]>>,
): Chosen | "insufficient" | null {
  const count = input.command === "revert" ? 1 : (input.count ?? 1);
  if (input.command === "revert") {
    const handle = input.edit === undefined ? undefined : parseEditHandle(input.edit);
    const picked = history.all.find((receipt) => receipt.wId === handle && receipt.kind !== "undo");
    return picked ? { receipts: [picked], text: 0 } : null;
  }
  const units = undoUnits(history);
  const taken = units.slice(0, count);
  const receipts = taken.flatMap((unit) => unit.receipts);
  if (receipts.length === 0) return null;
  if (taken.length < count) return "insufficient";
  return { receipts, text: taken.reduce((sum, unit) => sum + unit.text, 0) };
}

/**
 * What Undo counts, newest first: the steps of one command are one (a create with content is a
 * tree receipt and a text edit, one call), the rest one each.
 */
function undoUnits(history: Awaited<ReturnType<TreeHistory["historyOf"]>>): Chosen[] {
  const steps = [
    ...history.undo.map((receipt) => ({
      at: receipt.wId,
      receipt,
      command: receipt.commandId,
    })),
    ...history.text.undo.map((at) => ({
      at,
      receipt: null,
      command: history.text.commands[at] ?? null,
    })),
  ].sort((a, b) => b.at - a.at);
  const units: Chosen[] = [];
  const byCommand = new Map<string, Chosen>();
  for (const step of steps) {
    let unit = step.command ? byCommand.get(step.command) : undefined;
    if (!unit) {
      unit = { receipts: [], text: 0 };
      units.push(unit);
      if (step.command) byCommand.set(step.command, unit);
    }
    if (step.receipt) unit.receipts.push(step.receipt);
    else unit.text += 1;
  }
  return units;
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
  const read = await call.context.port.readTree(parts.area, {
    read: (scope) => ({
      reached: reachPath(scope, parts.area, shown, parts.rest, { deleted: true }),
      holds: folderHolds(scope, shown),
    }),
  });
  const treeHistory = deps.documentSync.treeHistory();
  let node: { id: string; kind: string } | undefined;
  if (read.ok && read.value.reached.kind === "node") node = read.value.reached.node;
  else if (read.ok) {
    // A node gone since (deleted, a create that was undone, or moved away from this path),
    // named by a path the model wrote for it, is found by that receipt.
    const left = await treeHistory.nodeLeftAt(
      threadId,
      `${parts.area}${parts.rest}`,
      read.value.holds,
    );
    if (left) node = { id: left.node, kind: left.folder ? "folder" : "document" };
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
        `Only ${undoUnits(history).length} ${undoUnits(history).length === 1 ? "edit" : "edits"} to undo in ${input.path}; requested ${input.count}. Nothing was changed.`,
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
    answer: last,
  };
}

/** Why an Undo left a change where it is, for the model: the owner it would have changed is closed. */
function closedMessage(closed: ClosedSource | undefined): string {
  const who = closed?.owner ?? "its owner";
  switch (closed?.why) {
    case "chat_frozen":
      return `Not undone: ${who} is in Trash, so the change stayed. It comes undone only after the writer restores it.`;
    case "work_deleted":
      return `Not undone: ${who} is deleted, so the change stayed. It comes undone only after the writer restores it.`;
    default:
      return `Not undone: ${who} is archived, so the change stayed. It comes undone only after the writer unarchives it.`;
  }
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
  const target = await threadContainerTarget(call.context.resolution, input.path);
  const grant = target ? await deps.fileAccess.authorize(call.principal, target, "edit") : null;
  if (grant && "denied" in grant) return fileAccessDeniedError(input.command, grant, input.path);
  const drafted = receipt.draftBranchId !== null;
  const port = drafted
    ? call.context.port
    : contextPortForThread(deps.contextPorts, call.context.resolution, {
        destination: { kind: "live" },
      });
  let handle: string | undefined;
  const kind = "undo";
  const places = { area: parts.area, roots: new Map<string, string>(), locate: () => null };

  // The sources the Undo changes, read before the locks: their owners are locked with the
  // grants', and judged under the locks. A guess, so it can miss; a miss restarts the command.
  const sources = async () => {
    const read = await port.readTree(parts.area, {
      version: drafted ? "draft" : "live",
      read: ({ writer, view }) =>
        undoReports(
          writer,
          // The order `runTreeUndo` takes them: an estimate equals its press only on the same steps.
          receipt.records.toReversed().map((entry) => ({ id: entry.record, view })),
        ),
    });
    return new Set(read.ok ? [...read.value.values()].flatMap((report) => report.sources) : []);
  };
  const run = await withTreeOwners(getDb(), sources, (owners) =>
    runWithEditGrants(
      deps.fileAccess,
      grant ? [grant] : [],
      () =>
        port.treeCommand(parts.area, {
          origin: {
            type: "agent",
            agentSlug: ctx.agentSlug,
            threadId: ctx.threadId,
            turnId: ctx.turnId,
          },
          drafted,
          owners,
          make: (scope, judge) => {
            places.roots.set(parts.area, scope.root);
            return {
              result: runTreeUndo(scope, places, receipt.records, nodeId, input.path, judge),
              arrived: [],
            };
          },
          afterWrite: async (result, scope) => {
            // A receipt whose opposite already stands is taken back with no record of its own.
            if (result.made.length === 0 && result.fate !== "taken") return;
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
              shownAt: `${parts.area}${parts.rest}`,
              reverses: { kind, receipt: receipt.id },
            });
            handle = recorded.handle;
          },
        }),
      { works: owners.works, lineages: owners.lineages },
    ),
  );
  if (!run.ok) return fileAccessDeniedError(input.command, firstRefusal(run.refusal), input.path);
  if (!run.value.ok) return writeToolError(input.command, contextErrorMessage(run.value.error));
  const done = run.value.value;
  const undone = done.fate === "acts" || done.fate === "taken";
  const status = !undone
    ? done.fate === "closed"
      ? "returned"
      : done.fate === "purged"
        ? "purged"
        : "cant_undo_changed"
    : done.partial
      ? "partial"
      : "reversed";
  const payload = {
    path: done.landedAt,
    ...(handle ? { write: { id: handle } } : {}),
    ...(done.kept ? { tree: { kept: done.kept } } : {}),
    ...(!undone
      ? {
          message:
            done.fate === "closed"
              ? closedMessage(done.closed)
              : done.fate === "purged"
                ? `Can't ${input.command}: what that change touched is gone.`
                : `Can't ${input.command}: something changed it after that change, or it is gone.`,
        }
      : {}),
  };
  return {
    output: modelResult({ command: input.command, status, payload }),
    metadata: { treeWrite: true },
    evidence: { shown: [], ...namesEvidence(done.delta) },
  };
}
