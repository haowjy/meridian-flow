/**
 * A surface's link follower: the resolution scope registered on the surface's
 * cache, and the follow procedure bound to the surface's destination and host.
 *
 * **An answer belongs to a scope, not to a href.** `{ projectId, workId,
 * baseUri }` and the index's revision are the whole semantic input to a
 * resolution, so the resolver is registered once per scope and registered
 * again whenever any of them changes. Registering is the cache's only
 * invalidation: it forgets every answer and every failure the previous scope
 * produced. Nothing else in the app pokes this cache. A click in flight across
 * a registration is asked again in the new one, so a rename or a catalog
 * refetch never turns into "could not be checked".
 *
 * **What aborts a follow.** A newer `current` follow aborts the previous one:
 * the pane can only go one place, and the latest click is where the writer
 * meant. A `new-tab` follow is never aborted by a newer one and never aborts
 * another, because each is its own tab. A project or Work change, unmount,
 * the surface hiding (`active: false`), and `cancel()` abort everything in
 * flight. An abort only stops a follow before
 * it opens; once it opens, the navigation completes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createLinkResolution,
  documentLinkTarget,
  isInternalLinkTarget,
  type LinkFollowDisposition,
  type LinkResolution,
  type LinkTarget,
} from "@/core/editor/links";

import { type FollowReporter, followProjectLink, type LinkDestination } from "./follow-link";
import {
  createProjectLinkResolver,
  type LinkResolutionScope,
  projectLinkAnswer,
} from "./project-link-resolver";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

export type LinkFollower = {
  follow(target: LinkTarget, gesture?: LinkFollowDisposition): void;
  /** Abort every in-flight follow, then clear its outcome. Order matters: see below. */
  cancel(): void;
  /**
   * Internal, and relative only with a base URI. Independent of loading: a
   * link that can be followed once the scope arrives is followable now.
   */
  canFollow(target: LinkTarget): boolean;
};

export function useLinkFollower({
  scope,
  index,
  resolution: providedResolution,
  active = true,
  open,
  reporter,
}: {
  /**
   * `"pending"`: the surface has a project but does not know its Work yet. A
   * follow waits for the scope (showing checking after the usual delay) and is
   * never answered from a guessed one. Null: no project; nothing is followable.
   */
  scope: LinkResolutionScope | "pending" | null;
  index: LinkableDocumentIndex;
  /**
   * The cache this surface draws its links from. Omitted, the follower owns
   * one: created once and never destroyed, because `destroy()` drops listeners
   * and a StrictMode remount would keep using it. Unregistering is the cleanup.
   */
  resolution?: LinkResolution | null;
  /** False while the surface is hidden: in-flight follows abort. */
  active?: boolean;
  open: LinkDestination;
  reporter: FollowReporter;
}): LinkFollower {
  const [ownedResolution] = useState<LinkResolution | null>(() =>
    providedResolution === undefined ? createLinkResolution() : null,
  );
  const resolution = providedResolution === undefined ? ownedResolution : providedResolution;
  const ready = scope !== null && scope !== "pending" ? scope : null;
  const pending = scope === "pending";
  const projectId = ready?.projectId ?? null;
  const workId = ready?.workId ?? null;
  const baseUri = ready?.baseUri ?? null;

  /** Follows clicked while the scope was pending, released once it registers. */
  const scopeWaiters = useRef(new Set<() => void>());

  useEffect(() => {
    if (!resolution || !projectId) return;
    const unregister = resolution.registerResolver(
      createProjectLinkResolver({ projectId, workId, baseUri }, index),
    );
    for (const release of scopeWaiters.current) release();
    scopeWaiters.current.clear();
    // React runs this cleanup and the next registration in one commit.
    // Unregistering right away would leave no live generation for a pending
    // click to be carried into, so it would settle null and report "could not
    // be checked". Deferred, the unregister finds a newer registration and is a
    // no-op (it only takes its own generation); on unmount it still runs.
    return () => queueMicrotask(unregister);
    // `index` stays the same object while its revision does, so a different one
    // is a different catalog: registering against it is how an answer about the
    // old one becomes unreachable.
  }, [baseUri, index, projectId, resolution, workId]);

  // Read when an answer lands, not when the click happened: a pending scope or
  // a catalog change in between means the click-time index is the wrong one.
  const latest = useRef({ index, baseUri });
  latest.current = { index, baseUri };
  const candidates = useCallback((target: LinkTarget) => {
    const request = documentLinkTarget(target, latest.current.baseUri ?? "");
    if (!request) return [];
    const answer = projectLinkAnswer(latest.current.index, request);
    return answer.kind === "ambiguous" ? answer.candidates : [];
  }, []);

  const inFlight = useRef(new Set<AbortController>());
  const currentFollow = useRef<AbortController | null>(null);
  /**
   * Which follow the shown outcome belongs to. Several follows share one
   * surface reporter, so a follow may only clear what it reported: a background
   * follow opening must not wipe the pane follow's checking dialog, and a pane
   * follow opening must not wipe a background follow's missing dialog before
   * the writer can press Create.
   */
  const shownBy = useRef<AbortController | null>(null);

  /** Abort one follow, taking down the outcome it is showing; nobody else will. */
  const abortFollow = useCallback(
    (controller: AbortController) => {
      controller.abort();
      inFlight.current.delete(controller);
      if (shownBy.current === controller) {
        shownBy.current = null;
        reporter.clear();
      }
    },
    [reporter],
  );

  const abortAll = useCallback(() => {
    for (const controller of [...inFlight.current]) abortFollow(controller);
    currentFollow.current = null;
  }, [abortFollow]);

  // Unmounting leaves nobody to answer, and a hidden surface has nobody to
  // answer to. A different cache is a different surface.
  useEffect(() => abortAll, [abortAll, resolution]);
  useEffect(() => {
    if (!active) abortAll();
  }, [abortAll, active]);

  // The answer a follow is waiting on is about the project and Work it was
  // clicked in. A catalog or base URI change re-asks it; moving to another
  // project or Work is a different question and aborts. A pending scope
  // becoming known is not a move: that is the answer the follow waited for.
  const answeredScope = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const key = `${projectId}\u0000${workId ?? ""}`;
    if (answeredScope.current !== null && answeredScope.current !== key) abortAll();
    answeredScope.current = key;
  }, [abortAll, projectId, workId]);

  const follow = useCallback(
    (target: LinkTarget, gesture: LinkFollowDisposition = "current") => {
      // Without a scope no resolver is registered, and asking anyway would
      // report "could not be checked" about a question nobody could ask.
      if (!resolution || !active || (!projectId && !pending)) return;
      const controller = new AbortController();
      if (gesture === "current") {
        if (currentFollow.current) abortFollow(currentFollow.current);
        currentFollow.current = controller;
      }
      inFlight.current.add(controller);
      const owned: FollowReporter = {
        report(outcome) {
          shownBy.current = controller;
          reporter.report(outcome);
        },
        clear() {
          if (shownBy.current !== controller) return;
          shownBy.current = null;
          reporter.clear();
        },
      };
      const scopeReady = projectId
        ? undefined
        : new Promise<void>((release) => {
            scopeWaiters.current.add(release);
            controller.signal.addEventListener(
              "abort",
              () => {
                scopeWaiters.current.delete(release);
                release();
              },
              { once: true },
            );
          });
      void followProjectLink({
        target,
        gesture,
        resolution,
        open,
        reporter: owned,
        signal: controller.signal,
        scopeReady,
        candidates,
      }).finally(() => {
        inFlight.current.delete(controller);
        if (currentFollow.current === controller) currentFollow.current = null;
      });
    },
    [abortFollow, active, candidates, open, pending, projectId, reporter, resolution],
  );

  const cancel = useCallback(() => {
    // Abort first: the procedure clears the outcome itself right before it
    // opens, so clearing first would leave a window where an answer lands,
    // opens, and the writer's Cancel meant nothing.
    shownBy.current = null;
    abortAll();
    reporter.clear();
  }, [abortAll, reporter]);

  const followable = scope !== null;
  const canFollow = useCallback(
    (target: LinkTarget) =>
      followable &&
      isInternalLinkTarget(target) &&
      (target.kind !== "relative" || baseUri !== null),
    [baseUri, followable],
  );

  return useMemo(() => ({ follow, cancel, canFollow }), [cancel, canFollow, follow]);
}
