/**
 * A refused Copy, derived from the operations journal: which surfaces say so, what they say, and
 * which rows to offer back. The journal keeps a refused Copy until the writer dismisses it or
 * sends it again, so the refusal survives a reload and shows in every tab; nothing here is
 * remembered by a notice.
 *
 * It shows where the writer was looking when it was destination: on the destination list's
 * surface (the Files lists share one family, a chat's Scratch and a Work's Files are their own),
 * or on the surface that started it when the destination is gone.
 */
import { plural, t } from "@lingui/core/macro";
import type { ContextError } from "@meridian/contracts/protocol";
import type { CopyDesired, NamespaceIntent } from "@meridian/resource-replica";
import { isNoticeSurface, type NoticeSurface } from "../../shell/SurfaceNotice";
import { schemeLabel } from "../context-schemes";
import { entryNameNow } from "./move-plan";
import type { NoticeView } from "./operation-notice";

export type CopyRefusal = {
  operationId: string;
  message: string;
  surfaces: readonly NoticeSurface[];
  /** The rows the Copy was asked to copy, as the writer sees them now. */
  sources: readonly { kind: "file" | "folder"; id: string; name: string }[];
};

/** The refused Copies of a project, oldest first. */
export function copyRefusals(view: NoticeView, projectId: string): CopyRefusal[] {
  return (view.operations ?? []).flatMap((operation) => {
    if (operation.projectId !== projectId) return [];
    const intent = operation.intents.find((candidate) => candidate.state === "needs-repair");
    if (intent?.desired.kind !== "copy") return [];
    const copy = intent.desired;
    const sources = copy.roots.map((root) => ({
      kind: root.kind,
      id: root.sourceId,
      name: entryNameNow(view, { kind: root.kind, id: root.sourceId }) ?? root.predictedName,
    }));
    const destination = destinationName(view, copy);
    return [
      {
        operationId: operation.operationId,
        message: describeRefusal(sources, destination, reasonOf(intent)),
        surfaces: surfacesOf(view, copy, destination !== null),
        sources,
      },
    ];
  });
}

/** The destination's name, or null once the destination is gone. */
function destinationName(view: NoticeView, copy: CopyDesired): string | null {
  const { parent } = copy.destination;
  return parent.kind === "root"
    ? schemeLabel(parent.scheme)
    : (view.placement.folderLocation(parent.folderId)?.name ?? null);
}

function surfacesOf(
  view: NoticeView,
  copy: CopyDesired,
  destinationPresent: boolean,
): readonly NoticeSurface[] {
  const { parent } = copy.destination;
  const place =
    parent.kind === "root"
      ? { scheme: parent.scheme, ...parent.owner }
      : view.placement.folderLocation(parent.folderId);
  if (!destinationPresent || !place)
    return isNoticeSurface(copy.origin) ? [copy.origin] : ["sidebar", "mobile"];
  if (place.scheme === "scratch") return [place.rootThreadId ? "chat-files" : "work-files"];
  return ["sidebar", "mobile"];
}

/** What the server (or the replica, before sending) said was wrong, when it said. */
function reasonOf(intent: NamespaceIntent): string | null {
  const outcome = intent.attempts.at(-1)?.outcome;
  // Refused before it was sent: a source or the destination was already gone.
  if (!outcome) return t`A source or the destination is no longer there.`;
  if (outcome.kind === "refusal") {
    const details = outcome.error.details;
    return details &&
      typeof details === "object" &&
      "reason" in details &&
      details.reason === "source_behind"
      ? t`The latest edits hadn't reached the server.`
      : null;
  }
  if (outcome.kind !== "operation" || outcome.receipt.result.ok) return null;
  return describeContextError(outcome.receipt.result.error);
}

function describeContextError(error: ContextError): string | null {
  switch (error.code) {
    case "not_found":
    case "stale_source":
      return t`A source is no longer there.`;
    case "destination_missing":
    case "stale_target":
      return t`The destination is no longer there.`;
    case "permission_denied":
      return t`You can't copy there.`;
    case "context_unavailable":
      return t`That Work isn't available.`;
    default:
      return null;
  }
}

function describeRefusal(
  sources: CopyRefusal["sources"],
  destination: string | null,
  reason: string | null,
): string {
  const [only] = sources;
  const said =
    sources.length === 1 && only
      ? destination
        ? t`Couldn't copy ${only.name} to ${destination}.`
        : t`Couldn't copy ${only.name}.`
      : destination
        ? plural(sources.length, {
            one: `Couldn't copy # item to ${destination}.`,
            other: `Couldn't copy # items to ${destination}.`,
          })
        : plural(sources.length, {
            one: "Couldn't copy # item.",
            other: "Couldn't copy # items.",
          });
  return reason ? `${said} ${reason}` : said;
}
