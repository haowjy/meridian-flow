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

function refusalOf(input: TreeToolInput, result: Extract<TreeResult, { ok: false }>) {
  return {
    isError: true as const,
    output: modelResult({
      command: input.command,
      status: result.status,
      payload: {
        path: result.path,
        message: result.message,
        ...(result.refusal ? { refusal: result.refusal } : {}),
      },
    }),
  };
}

/**
 * A tree command: the grant on the area it changes, then one command on its list. Every path
 * stays in one area; a move between areas is not made.
 */
export async function runTreeToolCommand(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: TreeToolInput,
  ctx: ToolHandlerContext,
) {
  const command = commandOf(input);
  if (isToolError(command)) return command;
  const paths = command.command === "move" ? [...command.from, command.path] : [command.path];
  const areas = paths.map((path) => areaOfPath(path));
  const first = areas[0];
  if (!first || areas.some((area) => area?.area !== first.area))
    return writeToolError(
      input.command,
      "A tree command works inside one source: move between sources is not available. Copy, then delete.",
    );
  const area = first.area;
  const strip = (path: string) => areaOfPath(path)?.rest ?? path;
  const local: TreeCommand =
    command.command === "move"
      ? {
          ...command,
          from: command.from.map(strip),
          path: strip(command.path),
          ...(command.position && "sibling" in command.position
            ? { position: { ...command.position, sibling: strip(command.position.sibling) } }
            : {}),
        }
      : { ...command, path: strip(command.path) };

  const target = await threadContainerTarget(
    deps.works,
    call.context.resolution,
    paths[0] as string,
  );
  let grant: FileGrant<"edit"> | null = null;
  if (target) {
    const granted = await deps.fileAccess.authorize(call.principal, target, "edit");
    if (isFileAccessDenied(granted))
      return fileAccessDeniedError(input.command, granted, paths[0] as string);
    grant = granted;
  }
  const drafted = grant?.destination.kind === "draft";
  const destination = grant?.destination;

  const shown = await shownNamesOf(ctx);
  const history = deps.documentSync.treeHistory();
  const firstDrafted =
    drafted && ctx.responseIdentity
      ? !(await history.draftedInReply(ctx.responseIdentity.editScopeId))
      : drafted;
  const origin = {
    type: "agent" as const,
    agentSlug: ctx.agentSlug,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
  };
  const port = drafted
    ? call.context.port
    : contextPortForThread(deps.contextPorts, call.context.resolution, {
        responseId: ctx.responseIdentity?.editScopeId ?? null,
        liveWrites: true,
      });
  let handle: string | undefined;

  const run = await runWithEditGrants(deps.fileAccess, grant ? [grant] : [], () =>
    port.treeCommand(area, {
      origin,
      drafted,
      make: (scope) => {
        const result = runTreeCommand(scope, area, shown, local);
        return { result, arrived: result.ok ? result.arrived : [] };
      },
      afterWrite: async (result, scope) => {
        if (!result.ok || result.made.length === 0) return;
        const recorded = await history.recordAgentTreeChange({
          nodeId: result.subject,
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
          shownAt: result.shownAt,
          landedAt: result.landedAt,
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
  if (!result.ok)
    return {
      ...refusalOf(input, result),
      ...(result.status === "path_changed"
        ? { evidence: { shown: [], ...namesEvidence(result.delta) } }
        : {}),
    };

  // A delete is never refused for its Works: they keep their drafts of what it took.
  const survivingWorks =
    input.command === "delete" && !drafted && result.taken.length <= 100
      ? [
          ...new Set(
            (
              await Promise.all(result.taken.map((id) => history.survivingDraftWorks(id as never)))
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
      ...(result.alreadyDeleted ? { alreadyDeleted: true as const } : {}),
      ...(result.deletedInLive ? { deletedInLive: true as const } : {}),
      ...(survivingWorks.length > 0 ? { survivingWorks } : {}),
      ...(drafted && firstDrafted && result.made.length > 0 ? { firstDrafted: true as const } : {}),
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
    // Committed at the call: a save boundary after it rotates the reply's edit scope.
    metadata: { treeWrite: true },
    evidence: { shown: [], ...namesEvidence(result.delta) },
  };
}
