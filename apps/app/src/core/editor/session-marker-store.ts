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
const REVISION_TOMBSTONE_CAP = 50;

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
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ownUserId: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  setOwnUserId(userId: string): void {
    if (this.ownUserId === userId) return;
    this.ownUserId = userId;
  }

  getSnapshot = (): SessionMarkerSnapshot => this.markers;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replaceGroup(message: ChangeEventWsMessage): void {
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
      ...message.changes
        .filter(
          (change) =>
            change.admittedByUserId === null || change.admittedByUserId !== this.ownUserId,
        )
        .map(
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
    // Advance even for an empty/self-admitted replace-set so superseded marks
    // disappear and a delayed older delivery cannot resurrect them.
    this.revisions.set(key, message.projectionRevision);
    this.evict(false);
    this.pruneRevisions();
    this.scheduleExpiry();
    this.emit();
  }

  dismiss(changeId: string): void {
    let changed = false;
    this.markers = this.markers.map((marker) => {
      if (marker.changeId !== changeId || marker.dismissed) return marker;
      changed = true;
      return { ...marker, dismissed: true };
    });
    if (changed) {
      this.scheduleExpiry();
      this.emit();
    }
  }

  dismissGroup(group: MarkerGroup): void {
    const key = groupKey(group);
    let changed = false;
    this.markers = this.markers.map((marker) => {
      if (groupKey(marker.group) !== key || marker.dismissed) return marker;
      changed = true;
      return { ...marker, dismissed: true };
    });
    if (changed) {
      this.scheduleExpiry();
      this.emit();
    }
  }

  /** Whole-mark removal is reserved for writer edits and invalidated anchors. */
  remove(changeId: string): void {
    const next = this.markers.filter((marker) => marker.changeId !== changeId);
    if (next.length === this.markers.length) return;
    this.markers = next;
    this.scheduleExpiry();
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
          Number(b.marker.dismissed) - Number(a.marker.dismissed) ||
          Number(a.marker.swept) - Number(b.marker.swept) ||
          a.marker.receivedAt - b.marker.receivedAt ||
          a.index - b.index,
      );
    const removed = new Set(candidates.slice(0, excess).map(({ marker }) => marker));
    this.markers = this.markers.filter((marker) => !removed.has(marker));
    this.pruneRevisions();
    this.scheduleExpiry();
    if (emit) this.emit();
  }

  clear(): void {
    this.cancelExpiry();
    if (this.markers.length === 0 && this.revisions.size === 0) return;
    this.markers = [];
    this.revisions.clear();
    this.emit();
  }

  private scheduleExpiry(): void {
    this.cancelExpiry();
    const unresolved = this.markers.filter((marker) => marker.anchor.type === "unresolved");
    if (unresolved.length === 0) return;
    const deadline = Math.min(
      ...unresolved.map((marker) => marker.receivedAt + SESSION_MARKER_RESOLUTION_WINDOW_MS),
    );
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null;
        const now = this.now();
        const next = this.markers.filter(
          (marker) =>
            marker.anchor.type !== "unresolved" ||
            now - marker.receivedAt < SESSION_MARKER_RESOLUTION_WINDOW_MS,
        );
        if (next.length !== this.markers.length) {
          this.markers = next;
          this.pruneRevisions();
          this.emit();
        }
        this.scheduleExpiry();
      },
      Math.max(0, deadline - this.now()),
    );
  }

  private cancelExpiry(): void {
    if (this.expiryTimer === null) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private pruneRevisions(): void {
    const liveKeys = new Set(this.markers.map((marker) => groupKey(marker.group)));
    const tombstones = [...this.revisions.keys()].filter((key) => !liveKeys.has(key));
    for (const key of tombstones.slice(
      0,
      Math.max(0, tombstones.length - REVISION_TOMBSTONE_CAP),
    )) {
      this.revisions.delete(key);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
