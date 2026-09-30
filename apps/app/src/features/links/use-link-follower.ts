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
 * another, because each is its own tab. A project or Work change, unmount, and
 * `cancel()` abort everything in flight. An abort only stops a follow before
 * it opens; once it opens, the navigation completes.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { LinkFollowDisposition, LinkResolution, LinkTarget } from "@/core/editor/links";

import { type FollowReporter, followProjectLink, type LinkDestination } from "./follow-link";
import { createProjectLinkResolver, type LinkResolutionScope } from "./project-link-resolver";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

export type LinkFollower = {
  follow(target: LinkTarget, gesture?: LinkFollowDisposition): void;
  /** Abort every in-flight follow, then clear its outcome. Order matters: see below. */
  cancel(): void;
};

export function useLinkFollower({
  scope,
  index,
  resolution,
  open,
  reporter,
}: {
  /** Null: no project, or a surface that is not showing; nothing is followable. */
  scope: LinkResolutionScope | null;
  index: LinkableDocumentIndex;
  /** The cache this surface draws its links from. */
  resolution: LinkResolution | null;
  open: LinkDestination;
  reporter: FollowReporter;
}): LinkFollower {
  const projectId = scope?.projectId ?? null;
  const workId = scope?.workId ?? null;
  const baseUri = scope?.baseUri ?? null;

  useEffect(() => {
    if (!resolution || !projectId) return;
    const unregister = resolution.registerResolver(
      createProjectLinkResolver({ projectId, workId, baseUri }, index),
    );
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

  const abortAll = useCallback(() => {
    for (const controller of inFlight.current) controller.abort();
    inFlight.current.clear();
    currentFollow.current = null;
  }, []);

  // The answer a follow is waiting on is about the project and Work it was
  // clicked in. A catalog or base URI change re-asks it; moving to another
  // project or Work is a different question, and unmounting leaves nobody to
  // answer. Both abort.
  useEffect(() => abortAll, [abortAll, projectId, workId]);

  const follow = useCallback(
    (target: LinkTarget, gesture: LinkFollowDisposition = "current") => {
      // Without a scope no resolver is registered, and asking anyway would
      // report "could not be checked" about a question nobody could ask.
      if (!resolution || !projectId) return;
      const controller = new AbortController();
      if (gesture === "current") {
        currentFollow.current?.abort();
        currentFollow.current = controller;
      }
      inFlight.current.add(controller);
      void followProjectLink({
        target,
        gesture,
        resolution,
        open,
        reporter,
        signal: controller.signal,
      }).finally(() => {
        inFlight.current.delete(controller);
        if (currentFollow.current === controller) currentFollow.current = null;
      });
    },
    [open, projectId, reporter, resolution],
  );

  const cancel = useCallback(() => {
    // Abort first: the procedure clears the outcome itself right before it
    // opens, so clearing first would leave a window where an answer lands,
    // opens, and the writer's Cancel meant nothing.
    abortAll();
    reporter.clear();
  }, [abortAll, reporter]);

  return useMemo(() => ({ follow, cancel }), [cancel, follow]);
}
