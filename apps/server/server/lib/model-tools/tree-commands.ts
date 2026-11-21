/**
 * `write`'s tree commands: `create` of a folder, `move`, `delete` and `restore`. Each tool call is
 * its own command with its records admitted at the call (nothing waits for the reply's save): the
 * paths resolve through the names the model was shown, the records are made on the project's list
 * under its lock, and the receipt that `undo`, `redo` and `revert` name commits with them. A failed
 * reply leaves what its calls did.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";
import { modelResult } from "@meridian/agent-edit/integration";
import type { DraftId, ThreadId, TurnId } from "@meridian/contracts";
import { addressScheme } from "@meridian/contracts/context-uri";
import { contextPortForThread } from "../../domains/context/index.js";
import type { ShownDelta } from "../../domains/context/tree/names-shown.js";
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
import { type Copies, copyAcross, recordCopies } from "./tree-copy-across.js";

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
  let primaryDestination: FileGrant<"edit">["destination"] | undefined;
  for (const area of areas as string[]) {
    const path = paths.find((candidate) => areaOfPath(candidate)?.area === area) as string;
    const target = await threadContainerTarget(call.context.resolution, path);
    if (!target) continue;
    const granted = await deps.fileAccess.authorize(call.principal, target, "edit");
    if (isFileAccessDenied(granted)) return fileAccessDeniedError(input.command, granted, path);
    grants.push(granted);
    if (area === primary) primaryDestination = granted.destination;
    if (granted.destination.kind === "draft") draftArea ??= area;
  }
  const leaving =
    command.command === "move"
      ? command.from.filter((from) => crossesLists(areaOfPath(from)?.area ?? primary, primary))
      : [];
  // A source in the destination's list moves; one in the other list is copied and stays. The
  // call has one answer.
  const across = command.command === "move" && leaving.length > 0 ? command : undefined;
  const staying = across ? across.from.filter((from) => !leaving.includes(from)) : [];
  const drafted = draftArea !== undefined;
  const destination = (grants.find((granted) => granted.destination.kind === "draft") ?? grants[0])
    ?.destination;
  // A drafted change runs in the source that has the chat's draft; a live one in the path's own.
  const area = draftArea ?? primary;
  const places = { area, roots, locate: (path: string) => areaOfPath(path) };
  const local: TreeCommand = across ? { ...across, from: staying } : command;

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

  const withinList = async (): Promise<InList> => {
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
                  draftBranchId: scope.view.draft as DraftId,
                }
              : {}),
            shownAt: uriOfWritten(result.shownAt),
          });
          handle = recorded.handle;
        },
      }),
    );
    if (!run.ok)
      return refused(
        fileAccessDeniedError(input.command, firstRefusal(run.refusal), paths[0] as string),
      );
    const done = run.value;
    if (!done.ok) return refused(writeToolError(input.command, contextErrorMessage(done.error)));
    const result = done.value;
    if (!result.ok)
      return { refused: refusalOf(input, result), notMoved: result.notMoved ?? [result.message] };

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
        ...(drafted && firstDrafted && result.made.length > 0
          ? { firstDrafted: true as const }
          : {}),
        ...(result.concurrent.length > 0 ? { concurrent: result.concurrent } : {}),
      },
    };
    return { payload, delta: result.delta };
  };

  // Copy reads its sources outside any transaction, so it runs before the call's command.
  const copies = across
    ? await copyAcross(deps, call, ctx, grants, { ...across, from: leaving }, destination)
    : undefined;
  if (copies && "refused" in copies) return copies.refused;

  return settle(async () => {
    const stayed = staying.length > 0 || !across ? await withinList() : undefined;
    if (!across) {
      const only = stayed as InList;
      return "refused" in only ? only.refused : answerOf(input.command, only.payload, only.delta);
    }
    const copied = await recordCopies(
      deps,
      call,
      ctx,
      port,
      copies as Copies,
      primaryDestination?.kind === "draft",
    );
    const notMoved = [
      ...(stayed === undefined
        ? []
        : "refused" in stayed
          ? stayed.notMoved
          : (stayed.payload.tree?.notMoved ?? [])),
      ...copied.notCopied,
    ];
    const kept = stayed && "payload" in stayed ? stayed : undefined;
    const moved = kept?.payload.tree?.moved?.made ?? (kept ? 1 : 0);
    if (moved + copied.copied === 0)
      return writeToolError("move", `Nothing moved or copied: ${notMoved.join("; ")}`);
    // One handle for a call with two receipts: a mixed call's is the copy's, so `revert` of it
    // takes back only the copy. `undo` and the card's Undo take back the whole call.
    const handle = copied.handle ?? kept?.payload.write?.id;
    return answerOf(
      "move",
      {
        ...(kept?.payload ?? {}),
        ...(!across.many && copied.landed[0] ? { path: copied.landed[0].to } : {}),
        destination: primaryDestination?.kind ?? "live",
        ...(handle ? { write: { id: handle } } : {}),
        tree: {
          ...(kept?.payload.tree ?? {}),
          ...(across.many ? { moved: { made: moved, of: staying.length } } : {}),
          copied: copied.landed,
          ...(notMoved.length > 0 ? { notMoved } : {}),
        },
      },
      {
        whole: [...(kept?.delta?.whole ?? []), ...(copied.names?.whole ?? [])],
        names: [...(kept?.delta?.names ?? []), ...(copied.names?.names ?? [])],
      },
    );
  });
}

/** Whether a move from `from` to `to` leaves its list: `user://` is the account's, the rest the project's. */
const crossesLists = (from: string, to: string) =>
  (addressScheme(from) === "user") !== (addressScheme(to) === "user");

type Payload = NonNullable<Parameters<typeof modelResult>[0]["payload"]>;

/** What the part of a call that stays in its list did: its answer, or why it moved nothing. */
type InList =
  | { refused: unknown; notMoved: string[] }
  | { payload: Payload; delta: ShownDelta | undefined };

const refused = (answer: { output: { message?: string } }): InList => ({
  refused: answer,
  notMoved: [answer.output.message ?? "not moved"],
});

function answerOf(
  command: TreeToolInput["command"],
  payload: Payload,
  delta: ShownDelta | undefined,
) {
  return {
    output: modelResult({ command, status: "success", phase: "committed", payload }),
    metadata: { treeWrite: true },
    evidence: { shown: [], ...namesEvidence(delta) },
  };
}
