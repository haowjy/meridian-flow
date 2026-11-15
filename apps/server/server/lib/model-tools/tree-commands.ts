/**
 * `write`'s tree commands: `create` of a folder, `move`, `delete` and `restore`. Each tool call is
 * its own command with its records admitted at the call (nothing waits for the reply's save): the
 * paths resolve through the names the model was shown, the records are made on the project's list
 * under its lock, and the receipt that `undo`, `redo` and `revert` name commits with them. A failed
 * reply leaves what its calls did.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";
import { modelResult } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts";
import { contextPortForThread } from "../../domains/context/index.js";
import { decodeDelta } from "../../domains/context/tree/names-shown.js";
import {
  type Placement,
  runTreeCommand,
  type TreeCommand,
  type TreeResult,
} from "../../domains/context/tree/tree-commands.js";
import {
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { threadContainerTarget } from "../file-targets.js";
import { fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { areaOfPath, namesEvidence, shownNamesOf } from "./shown-paths.js";
import {
  contextErrorMessage,
  isToolError,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";
import { crossesLists, runMoveAcrossLists } from "./tree-across-lists.js";

type MoveInput = Extract<WriteToolInput, { command: "move" }>;
type DeleteInput = Extract<WriteToolInput, { command: "delete" }>;
type RestoreInput = Extract<WriteToolInput, { command: "restore" }>;
type CreateInput = Extract<WriteToolInput, { command: "create" }>;
export type TreeToolInput = MoveInput | DeleteInput | RestoreInput | CreateInput;

function commandOf(input: TreeToolInput): TreeCommand | WriteToolErrorOutput {
  switch (input.command) {
    case "create":
    case "delete":
    case "restore":
      return { command: input.command, path: input.path };
    case "move": {
      const from = input.from.paths ?? (input.from.path === undefined ? [] : [input.from.path]);
      return {
        command: "move",
        from,
        path: input.path,
        many: input.from.paths !== undefined,
        ...(input.position ? { position: input.position as Placement } : {}),
      };
    }
  }
}

/** The path as the model wrote it, with its source: what a later `undo` of a deleted node is found by. */
function uriOfWritten(path: string): string {
  const at = areaOfPath(path);
  return at ? `${at.area}${at.rest}` : path;
}

type MoveAnswer = {
  isError?: true;
  output: ReturnType<typeof modelResult>;
  metadata?: unknown;
  evidence?: { shown: unknown[]; names?: unknown };
};

/**
 * The one answer for a move whose sources went two ways: what each part moved and left, added up.
 * A part that moved nothing says why among the ones not moved; only when both did is the call refused.
 */
function joinMoves(stayed: unknown, crossed: unknown, of: number) {
  const parts = [stayed, crossed] as MoveAnswer[];
  const done = parts.filter((part) => !part.isError);
  if (done.length === 0) return parts[0];
  const tree = (part: MoveAnswer) =>
    (part.output.tree ?? {}) as NonNullable<typeof part.output.tree>;
  const notMoved = parts.flatMap((part) =>
    part.isError ? [part.output.message ?? "not moved"] : (tree(part).notMoved ?? []),
  );
  const handle = done.map((part) => part.output.write?.id).findLast(Boolean);
  const shown = done.flatMap((part) => {
    const names = part.evidence?.names as { snapshot: Uint8Array } | undefined;
    return names ? [decodeDelta(names.snapshot)] : [];
  });
  return {
    output: modelResult({
      command: "move",
      status: "success",
      phase: "committed",
      payload: {
        destination: "live" as const,
        ...(handle ? { write: { id: handle } } : {}),
        tree: {
          moved: { made: done.reduce((sum, part) => sum + (tree(part).moved?.made ?? 0), 0), of },
          ...(notMoved.length > 0 ? { notMoved } : {}),
        },
      },
    }),
    metadata: { treeWrite: true },
    evidence: {
      shown: [],
      ...namesEvidence({
        whole: shown.flatMap((delta) => delta.whole),
        names: shown.flatMap((delta) => delta.names),
      }),
    },
  };
}

function refusalOf(input: TreeToolInput, result: Extract<TreeResult, { ok: false }>) {
  return {
    isError: true as const,
    output: modelResult({
      command: input.command,
      status: result.status,
      payload: { path: result.path, message: result.message },
    }),
  };
}

/**
 * A tree command: the grant on the area it changes, then one command on its list. A move between
 * a project's files and the account's is the server's move between two lists.
 */
export async function runTreeToolCommand(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: TreeToolInput,
  ctx: ToolHandlerContext,
  /** Runs the part that changes things as the call's command. */
  settle: (effect: () => Promise<unknown>) => Promise<unknown>,
): Promise<unknown> {
  const command = commandOf(input);
  if (isToolError(command)) return command;
  const paths = command.command === "move" ? [...command.from, command.path] : [command.path];
  const located = paths.map((path) => areaOfPath(path));
  const areas = [...new Set(located.map((place) => place?.area))];
  if (areas.some((area) => area === undefined))
    return writeToolError(input.command, "That path names no source.");
  const roots = new Map<string, string>();
  for (const area of areas as string[]) {
    const top = await call.context.port.readTree(area, { read: (scope) => scope.root });
    if (!top.ok) return writeToolError(input.command, contextErrorMessage(top.error));
    roots.set(area, top.value);
  }
  const primary = areaOfPath(command.path)?.area as string;
  // The file policy decides per source whether the change is the chat's draft or live.
  const grants: FileGrant<"edit">[] = [];
  let draftArea: string | undefined;
  for (const area of areas as string[]) {
    const path = paths.find((candidate) => areaOfPath(candidate)?.area === area) as string;
    const target = await threadContainerTarget(deps.works, call.context.resolution, path);
    if (!target) continue;
    const granted = await deps.fileAccess.authorize(call.principal, target, "edit");
    if (isFileAccessDenied(granted)) return fileAccessDeniedError(input.command, granted, path);
    grants.push(granted);
    if (granted.destination.kind === "draft") draftArea ??= area;
  }
  const leaving =
    command.command === "move"
      ? command.from.filter((from) => crossesLists(areaOfPath(from)?.area ?? primary, primary))
      : [];
  if (leaving.length > 0 && draftArea !== undefined)
    return writeToolError(
      input.command,
      "A change in a Work's draft can't move files between a project and the account's files.",
    );
  if (leaving.length > 0 && command.command === "move") {
    // Each source goes the way its own area says: the ones that stay in their list through the
    // in-list move, the rest across, and the call has one answer.
    const staying = command.from.filter((from) => !leaving.includes(from));
    const now = (effect: () => Promise<unknown>) => effect();
    const across = (run: typeof settle) =>
      runMoveAcrossLists(
        deps,
        call,
        ctx,
        grants,
        { ...command, from: leaving },
        (folder) => runTreeToolCommand(deps, call, { command: "delete", path: folder }, ctx, now),
        run,
      );
    if (staying.length === 0) return across(settle);
    return settle(async () =>
      joinMoves(
        await runTreeToolCommand(
          deps,
          call,
          { ...(input as MoveInput), from: { paths: staying } },
          ctx,
          now,
        ),
        await across(now),
        command.from.length,
      ),
    );
  }
  const drafted = draftArea !== undefined;
  const destination = (grants.find((granted) => granted.destination.kind === "draft") ?? grants[0])
    ?.destination;
  // A drafted change runs in the source that has the chat's draft; a live one in the path's own.
  const area = draftArea ?? primary;
  const places = { area, roots, locate: (path: string) => areaOfPath(path) };
  const local = command;

  const shown = await shownNamesOf(ctx);
  const history = deps.documentSync.treeHistory();
  const firstDrafted =
    drafted && ctx.turnId ? !(await history.draftedInReply(ctx.turnId as TurnId)) : drafted;
  const origin = {
    type: "agent" as const,
    agentSlug: ctx.agentSlug,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
  };
  const port = drafted
    ? call.context.port
    : contextPortForThread(deps.contextPorts, call.context.resolution, {
        destination: { kind: "live" },
      });
  let handle: string | undefined;

  return settle(async () => {
    const run = await runWithEditGrants(deps.fileAccess, grants, () =>
      port.treeCommand(area, {
        origin,
        drafted,
        make: (scope) => {
          const result = runTreeCommand(scope, places, shown, local);
          return { result, arrived: result.ok ? result.arrived : [], refused: !result.ok };
        },
        afterWrite: async (result, scope) => {
          if (!result.ok || result.made.length === 0) return;
          const recorded = await history.recordAgentTreeChange({
            subject: result.subject,
            nodes: result.touched.map((touched) => ({
              nodeId: touched.node,
              beforeAt: touched.before,
              afterAt: touched.after,
            })),
            records: result.made,
            op: input.command === "create" ? "create" : input.command,
            threadId: ctx.threadId as ThreadId,
            ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
            ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
            ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
            ...(scope.view.draft
              ? {
                  draftBranchId: scope.view.draft as import("@meridian/contracts").BranchId,
                }
              : {}),
            shownAt: uriOfWritten(result.shownAt),
          });
          handle = recorded.handle;
        },
      }),
    );
    if (!run.ok)
      return fileAccessDeniedError(input.command, firstRefusal(run.refusal), paths[0] as string);
    const done = run.value;
    if (!done.ok) return writeToolError(input.command, contextErrorMessage(done.error));
    const result = done.value;
    if (!result.ok) return refusalOf(input, result);

    // A delete is never refused for its Works: they keep their drafts of what it took.
    const survivingWorks =
      input.command === "delete" && !drafted && result.taken.length <= 100
        ? [
            ...new Set(
              (
                await Promise.all(
                  result.taken.map((id) => history.survivingDraftWorks(id as never)),
                )
              ).flat(),
            ),
          ].sort()
        : [];
    const payload: Parameters<typeof modelResult>[0]["payload"] = {
      ...(result.landed ? { path: result.landed } : {}),
      ...(destination ? { destination: destination.kind } : {}),
      ...(destination?.kind === "draft" ? { draftWork: destination.ownerHandle ?? "/" } : {}),
      ...(handle ? { write: { id: handle } } : {}),
      tree: {
        ...(result.moved ? { moved: result.moved } : {}),
        ...(result.notMoved.length > 0 ? { notMoved: result.notMoved } : {}),
        ...(result.deleted !== undefined ? { deleted: result.deleted } : {}),
        ...(result.kept ? { kept: result.kept } : {}),
        ...(result.placedAtEnd ? { placedAtEnd: result.placedAtEnd } : {}),
        ...(result.already ? { already: result.already } : {}),
        ...(result.leftOut ? { leftOut: result.leftOut } : {}),
        ...(result.deletedInLive ? { deletedInLive: true as const } : {}),
        ...(survivingWorks.length > 0 ? { survivingWorks } : {}),
        ...(drafted && firstDrafted && result.made.length > 0
          ? { firstDrafted: true as const }
          : {}),
        ...(result.concurrent.length > 0 ? { concurrent: result.concurrent } : {}),
      },
    };
    return {
      output: modelResult({
        command: input.command,
        status: "success",
        phase: "committed",
        payload,
      }),
      metadata: { treeWrite: true },
      evidence: { shown: [], ...namesEvidence(result.delta) },
    };
  });
}
