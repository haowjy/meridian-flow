/**
 * The press: Apply or Discard on a change, a document, a draft or every draft of a Work, and its
 * Undo, as commands the driver delivers (resent under one id until the server stores an answer).
 * Each is journaled and shown at once and leaves once the server holds what this browser's copies
 * of the rooms it presses had (`ready`), so the server presses what the writer saw (design §4).
 * The server runs both halves; an open document's text changes when its update arrives on the
 * socket.
 */
import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import {
  type DocumentId,
  type DraftId,
  draftItemKey,
  parseDraftItemKey,
} from "@meridian/contracts";
import type { PressAction, PressRequest, PressScope, TreeSaw } from "@meridian/contracts/drafts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import type { PressRooms } from "@/core/editor/document-session-registry";
import { workDraftsQueryOptions } from "./draft-commands";
import { refreshDraftReads } from "./useOwnerDrafts";
import { refreshWorksSnapshotSince } from "./works-projection-acquisition";

export const PRESS_KIND = "press";
export const PRESS_UNDO_KIND = "unpress";

/** `PressRequest` without its id, one member per verdict, so a body still pairs a verdict with its scope. */
export type PressBody = { projectId: string } & (PressRequest extends infer R
  ? R extends PressRequest
    ? Omit<R, "commandId">
    : never
  : never);
export type PressUndoBody = { projectId: string; pressCommandId: string };

/** Settles once the server holds what this browser's copies of the press's rooms had. */
export type PressGate = (projectId: string, rooms: PressRooms) => Promise<void>;

const WORK_LANE = "work:";

/** One draft's presses and Undos go in the order the writer made them; a Work's press orders after its drafts'. */
const pressLane = (key: string) => `press:${key}`;

/** The draft a scope presses on (a turn's Undo turn names its draft); a Work's press names its Work. */
export function pressLaneKey(scope: PressAction["scope"]): string {
  if (scope.kind === "turn" || scope.kind === "draft") return scope.draft;
  if (scope.kind === "work") return `${WORK_LANE}${scope.work}`;
  return parseDraftItemKey(scope.item)?.draftId ?? scope.item;
}

/**
 * What a journaled press or Undo presses, read from its lane (`pressLaneKey`), which a body of
 * every version has: its draft, or each draft of its Work as the server lists them now; a press
 * of one document or change, only that document.
 */
async function pressRooms(
  client: QueryClient,
  record: CommandRecord,
  projectId: string,
): Promise<PressRooms> {
  const scope = (record.body as Partial<PressBody>).scope;
  const parsed =
    scope && (scope.kind === "change" || scope.kind === "document")
      ? parseDraftItemKey(scope.item)
      : null;
  const documents = parsed ? [parsed.documentId] : null;
  const key = record.lanes[0]?.slice(pressLane("").length) ?? "";
  if (!key.startsWith(WORK_LANE)) return { drafts: [key as DraftId], documents };
  const listed = await client.fetchQuery(
    workDraftsQueryOptions(projectId, key.slice(WORK_LANE.length)),
  );
  return { drafts: listed.drafts.map((draft) => draft.id as DraftId), documents };
}

/** A press journaled before presses named a scope: one draft's documents and folders, or all of it. */
type PressBodyV1 = {
  projectId: string;
  draft: DraftId;
  verdict: "apply" | "discard";
  items: { node: string }[] | "all";
  saw?: TreeSaw;
};

/**
 * An unsent version 1 press as a scope, where one says the same: all of a draft is the draft, one
 * node is that document (a folder names no item, and presses nothing). A press of several nodes
 * has no scope that takes exactly those, so it throws and the driver settles it as never sent:
 * its rows stay listed to press again, where any scope would press more or less than was chosen.
 */
function pressBodyFromV1({ projectId, draft, verdict, items, saw }: PressBodyV1): PressBody {
  let scope: PressScope;
  if (items === "all") scope = { kind: "draft", draft };
  else if (items.length === 1 && items[0])
    scope = { kind: "document", item: draftItemKey(draft, items[0].node as DocumentId) };
  else throw new Error("A press of several nodes has no scope");
  return { projectId, verdict, scope, ...(saw ? { saw } : {}) };
}

export function pressDomain(client: QueryClient, gate: PressGate): CommandDomain {
  // The driver hands every settled press in the journal to `onSettled` on each load. The tab's
  // own reads of drafts all begin after it opened, so a press settled before then is in them;
  // only the Works the server read for the page may predate it. A turn card follows its chat's
  // waiting drafts (`useDraftDock`).
  const opened = Date.now();
  let bound: CommandDriver | null = null;
  const settled = (record: CommandRecord) => {
    const observed = () => void bound?.observe((each) => each.id === record.id);
    const { projectId } = record.body as PressBody | PressUndoBody;
    const since = record.settledAt ?? Date.now();
    // A press can change any draft's list: two Works on one passage, the first applied wins.
    void (
      since <= opened
        ? refreshWorksSnapshotSince(client, projectId, since)
        : refreshDraftReads(client, projectId, new Set([undefined]), since)
    ).then(observed);
  };
  const kinds: Record<string, CommandKind> = {
    [PRESS_KIND]: {
      version: 2,
      migrate: (body, from) =>
        from < 2 ? pressBodyFromV1(body as PressBodyV1) : (body as PressBody),
      request: ({ body }) => {
        const { projectId, ...request } = body as PressBody;
        return { method: "POST", path: `${apiProjectPath(projectId)}/press`, body: request };
      },
      ready: async (record) => {
        const { projectId } = record.body as PressBody;
        await gate(projectId, await pressRooms(client, record, projectId));
      },
      onSettled: settled,
    },
    [PRESS_UNDO_KIND]: {
      version: 1,
      migrate: (body) => body as PressUndoBody,
      request: ({ body }) => {
        const { projectId, pressCommandId } = body as PressUndoBody;
        return {
          method: "POST",
          path: `${apiProjectPath(projectId)}/press/undo`,
          body: { pressCommandId },
        };
      },
      ready: async (record) => {
        const { projectId } = record.body as PressUndoBody;
        await gate(projectId, await pressRooms(client, record, projectId));
      },
      onSettled: settled,
    },
  };
  return {
    kinds,
    bind: (driver) => {
      bound = driver;
      return () => {
        if (bound === driver) bound = null;
      };
    },
  };
}

export function submitPress(driver: CommandDriver, body: PressBody) {
  return submitCommand(driver, {
    kind: PRESS_KIND,
    lanes: [pressLane(pressLaneKey(body.scope))],
    body,
  });
}

/** `lane` (the press's `pressLaneKey`) orders the Undo after the press it names. */
export function submitPressUndo(driver: CommandDriver, lane: string, body: PressUndoBody) {
  return submitCommand(driver, { kind: PRESS_UNDO_KIND, lanes: [pressLane(lane)], body });
}
