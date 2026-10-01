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
 * **One owner per shown outcome.** Follows share the surface's reporter, so
 * the follower records which follow owns what is shown. A follow may only
 * clear its own outcome; `dismiss()` stops only the owner; `retry()` makes the
 * new follow the owner before it says anything, so a fast answer can clear
 * the failure it replaces.
 *
 * **What aborts a follow.** A newer `current` follow aborts the previous one:
 * the pane can only go one place. A `new-tab` follow is never aborted by a
 * newer follow and aborts nothing, because each is its own tab. Dismissing a
 * follow's checking dialog aborts that follow. Unmounting, a different cache,
 * a project or Work change, and the surface hiding abort everything in flight;
 * hiding also dismisses what is shown. An abort only stops a follow before it
 * opens; once it opens, the navigation completes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  createLinkResolution,
  isInternalLinkTarget,
  type LinkFollowDisposition,
  type LinkResolution,
  type LinkTarget,
} from "@/core/editor/links";

import { type FollowReporter, followProjectLink, type LinkDestination } from "./follow-link";
import { createProjectLinkResolver, type LinkResolutionScope } from "./project-link-resolver";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

export type LinkFollower = {
  follow(target: LinkTarget, gesture?: LinkFollowDisposition): void;
  /** Close what is shown; if its follow is still asking, stop that follow. */
  dismiss(): void;
  /** Follow the shown outcome's link again, as the new owner of the dialog. */
  retry(): void;
  /**
   * Internal, and relative only with a base URI. Independent of loading: a
   * link that can be followed once the scope arrives is followable now.
   */
  canFollow(target: LinkTarget): boolean;
};

type Shown = {
  owner: AbortController;
  target: LinkTarget;
  gesture: LinkFollowDisposition;
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
   * never answered from a guessed one. Null: no project, or the surface is not
   * showing; nothing is followable.
   */
  scope: LinkResolutionScope | "pending" | null;
  index: LinkableDocumentIndex;
  /**
   * The cache this surface draws its links from. Omitted, the follower owns
   * one: created once and never destroyed, because `destroy()` drops listeners
   * and a StrictMode remount would keep using it. Unregistering is the cleanup.
   */
  resolution?: LinkResolution | null;
  /** False while the surface is mounted but hidden: follows abort, and what is shown is dismissed. */
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

  // The latest host callbacks, read when a follow needs them. A host passing a
  // fresh `open` or reporter object each render must not restart or abort
  // anything.
  const latest = useRef({ open, reporter });
  useLayoutEffect(() => {
    latest.current = { open, reporter };
  });

  /** Follows clicked while the scope was pending, released once it registers. */
  const scopeWaiters = useRef(new Set<() => void>());

  useEffect(() => {
    if (!resolution || !projectId) return;
    const unregister = resolution.registerResolver(
      createProjectLinkResolver({ projectId, workId, baseUri }, index),
      { baseUri },
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

  const inFlight = useRef(new Set<AbortController>());
  const currentFollow = useRef<AbortController | null>(null);
  const shown = useRef<Shown | null>(null);

  const clearShown = useCallback(() => {
    shown.current = null;
    latest.current.reporter.clear();
  }, []);

  /** Abort one follow, taking down the outcome it is showing; nobody else will. */
  const abortFollow = useCallback(
    (controller: AbortController) => {
      controller.abort();
      inFlight.current.delete(controller);
      if (currentFollow.current === controller) currentFollow.current = null;
      if (shown.current?.owner === controller) clearShown();
    },
    [clearShown],
  );

  const abortAll = useCallback(() => {
    for (const controller of [...inFlight.current]) abortFollow(controller);
  }, [abortFollow]);

  // Unmounting leaves nobody to answer, and a different cache is a different
  // surface.
  useEffect(() => abortAll, [abortAll, resolution]);

  // A hidden surface has nobody to answer to, and a dialog it left up would
  // float over whatever replaced it.
  useEffect(() => {
    if (active) return;
    abortAll();
    if (shown.current) clearShown();
  }, [abortAll, active, clearShown]);

  // The answer a follow is waiting on is about the project and Work it was
  // clicked in. A catalog or base URI change re-asks it; moving to another
  // project or Work, or the scope going away, is a different question and
  // aborts. A pending scope becoming known is not a move: that is the answer
  // the follow waited for.
  const answeredScope = useRef<string | null>(null);
  const scopeKey = ready ? `${ready.projectId}\u0000${ready.workId ?? ""}` : pending ? null : "";
  useEffect(() => {
    if (scopeKey === null) return;
    if (answeredScope.current !== null && answeredScope.current !== scopeKey) {
      abortAll();
      if (!scopeKey && shown.current) clearShown();
    }
    answeredScope.current = scopeKey;
  }, [abortAll, clearShown, scopeKey]);

  const start = useCallback(
    // `retrying`: Try again. It owns the shown outcome from the start, so a
    // fast answer can clear the failure it replaces.
    (target: LinkTarget, gesture: LinkFollowDisposition, retrying: boolean) => {
      // Without a scope no resolver is registered, and asking anyway would
      // report "could not be checked" about a question nobody could ask.
      if (!resolution || !active || (!projectId && !pending)) return;
      const controller = new AbortController();
      if (gesture === "current") {
        if (currentFollow.current) abortFollow(currentFollow.current);
        currentFollow.current = controller;
      }
      inFlight.current.add(controller);
      if (retrying) shown.current = { owner: controller, target, gesture };
      const owned: FollowReporter = {
        report(outcome) {
          shown.current = { owner: controller, target, gesture };
          latest.current.reporter.report(outcome);
        },
        clear() {
          if (shown.current?.owner === controller) clearShown();
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
        open: (document, how) => latest.current.open(document, how),
        reporter: owned,
        signal: controller.signal,
        scopeReady,
      }).finally(() => {
        inFlight.current.delete(controller);
        if (currentFollow.current === controller) currentFollow.current = null;
      });
    },
    [abortFollow, active, clearShown, pending, projectId, resolution],
  );

  const follow = useCallback(
    (target: LinkTarget, gesture: LinkFollowDisposition = "current") =>
      start(target, gesture, false),
    [start],
  );

  const dismiss = useCallback(() => {
    // Abort before clearing: the procedure clears the outcome itself right
    // before it opens, so clearing first would leave a window where the answer
    // lands, opens, and the writer's Cancel meant nothing.
    const owner = shown.current?.owner;
    // Aborting the owner takes its outcome down with it.
    if (owner && inFlight.current.has(owner)) abortFollow(owner);
    else clearShown();
  }, [abortFollow, clearShown]);

  const retry = useCallback(() => {
    const again = shown.current;
    if (again) start(again.target, again.gesture, true);
  }, [start]);

  const followable = scope !== null;
  const canFollow = useCallback(
    (target: LinkTarget) =>
      followable &&
      isInternalLinkTarget(target) &&
      (target.kind !== "relative" || baseUri !== null),
    [baseUri, followable],
  );

  return useMemo(
    () => ({ follow, dismiss, retry, canFollow }),
    [canFollow, dismiss, follow, retry],
  );
}
