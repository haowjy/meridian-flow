/** Ephemeral, session-owned AI change markers and their replace-set lifecycle. */
import type { NavigationTargetV1 } from "@meridian/contracts";
import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import * as Y from "yjs";

export type MarkerGroup = { trailId: string; documentId: string };
export type SessionMarkerAnchor =
  | { type: "range"; start: Y.RelativePosition; end: Y.RelativePosition }
  | {
      type: "boundary";
      position: Y.RelativePosition;
      affinity: "before_next" | "after_previous" | "document_start";
    }
  | { type: "unresolved"; raw: NavigationTargetV1 };

export type SessionMarker = {
  changeId: string;
  group: MarkerGroup;
  author: ChangeEventWsMessage["author"];
  kind: "insert" | "modify" | "delete";
  anchor: SessionMarkerAnchor;
  swept: boolean;
  excerpt: string | null;
  pureDeletionOffset: number | null;
  projectionRevision: number;
  receivedAt: number;
  dismissed: boolean;
};

export type SessionMarkerSnapshot = readonly SessionMarker[];
type Listener = () => void;

export const SESSION_MARKER_CAP = 200;
export const SESSION_MARKER_RESOLUTION_WINDOW_MS = 30_000;

function groupKey(group: MarkerGroup): string {
  return `${group.trailId}\u0000${group.documentId}`;
}

function decodePosition(value: string): Y.RelativePosition {
  const binary = atob(value);
  return Y.decodeRelativePosition(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function decodeAnchor(
  raw: NavigationTargetV1,
): Exclude<SessionMarkerAnchor, { type: "unresolved" }> | null {
  try {
    if (raw.kind === "live_block_range") {
      return {
        type: "range",
        start: decodePosition(raw.relStart),
        end: decodePosition(raw.relEnd),
      };
    }
    if (raw.kind === "deletion_boundary") {
      return {
        type: "boundary",
        position: decodePosition(raw.position),
        affinity: raw.affinity,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class SessionMarkerStore {
  private markers: SessionMarker[] = [];
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly ownUserId: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  getSnapshot = (): SessionMarkerSnapshot => this.markers;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replaceGroup(message: ChangeEventWsMessage): void {
    if (message.admittedByUserId !== null && message.admittedByUserId === this.ownUserId) return;
    const group = { trailId: message.trailId, documentId: message.documentId };
    const key = groupKey(group);
    const priorRevision = this.revisions.get(key);
    if (priorRevision !== undefined && message.projectionRevision <= priorRevision) return;

    const dismissed = new Map(
      this.markers
        .filter((marker) => groupKey(marker.group) === key)
        .map((marker) => [marker.changeId, marker.dismissed]),
    );
    const receivedAt = this.now();
    this.markers = [
      ...this.markers.filter((marker) => groupKey(marker.group) !== key),
      ...message.changes.map(
        (change): SessionMarker => ({
          changeId: change.changeId,
          group,
          author: message.author,
          kind: change.kind,
          anchor: { type: "unresolved", raw: change.navigation },
          swept: change.swept,
          excerpt: change.excerpt,
          pureDeletionOffset: change.pureDeletionOffset,
          projectionRevision: message.projectionRevision,
          receivedAt,
          dismissed: dismissed.get(change.changeId) ?? false,
        }),
      ),
    ];
    this.revisions.set(key, message.projectionRevision);
    this.evict(false);
    this.emit();
  }

  dismiss(changeId: string): void {
    let changed = false;
    this.markers = this.markers.map((marker) => {
      if (marker.changeId !== changeId || marker.dismissed) return marker;
      changed = true;
      return { ...marker, dismissed: true };
    });
    if (changed) this.emit();
  }

  dismissGroup(group: MarkerGroup): void {
    const key = groupKey(group);
    let changed = false;
    this.markers = this.markers.map((marker) => {
      if (groupKey(marker.group) !== key || marker.dismissed) return marker;
      changed = true;
      return { ...marker, dismissed: true };
    });
    if (changed) this.emit();
  }

  /** Whole-mark removal is used by writer edits and successful forward actions. */
  remove(changeId: string): void {
    const next = this.markers.filter((marker) => marker.changeId !== changeId);
    if (next.length === this.markers.length) return;
    this.markers = next;
    this.emit();
  }

  /**
   * Retry raw anchors against the current editor binding. Once an anchor has
   * resolved, later failure means its content was deleted again and the marker
   * is dropped. Raw anchors get the bounded reorder window before eviction.
   */
  reconcileAnchors(
    resolves: (anchor: Exclude<SessionMarkerAnchor, { type: "unresolved" }>) => boolean,
  ): void {
    const now = this.now();
    let changed = false;
    const next: SessionMarker[] = [];
    for (const marker of this.markers) {
      if (marker.anchor.type === "unresolved") {
        const decoded = decodeAnchor(marker.anchor.raw);
        if (decoded && resolves(decoded)) {
          next.push({ ...marker, anchor: decoded });
          changed = true;
        } else if (now - marker.receivedAt < SESSION_MARKER_RESOLUTION_WINDOW_MS) {
          next.push(marker);
        } else {
          changed = true;
        }
      } else if (resolves(marker.anchor)) {
        next.push(marker);
      } else {
        changed = true;
      }
    }
    if (!changed) return;
    this.markers = next;
    this.emit();
  }

  evict(emit = true): void {
    if (this.markers.length <= SESSION_MARKER_CAP) return;
    const excess = this.markers.length - SESSION_MARKER_CAP;
    const candidates = this.markers
      .map((marker, index) => ({ marker, index }))
      .sort(
        (a, b) =>
          Number(a.marker.swept) - Number(b.marker.swept) ||
          a.marker.receivedAt - b.marker.receivedAt ||
          a.index - b.index,
      );
    const removed = new Set(candidates.slice(0, excess).map(({ marker }) => marker));
    this.markers = this.markers.filter((marker) => !removed.has(marker));
    if (emit) this.emit();
  }

  clear(): void {
    if (this.markers.length === 0) return;
    this.markers = [];
    this.revisions.clear();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
