/**
 * A surface's link follower: the resolution scope registered on the surface's
 * cache, and the follow procedure bound to the surface's destination and host.
 *
 * **An answer belongs to a scope, not to a href.** `{ projectId, workId,
 * baseUri }` and the index's revision are the whole semantic input to a
 * resolution, so the resolver is registered once per scope and registered
 * again whenever any of them changes. Registering is the cache's only
 * invalidation: it forgets every answer and every failure the previous scope
 * produced. Nothing else in the app pokes this cache.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { LinkFollowDisposition, LinkResolution, LinkTarget } from "@/core/editor/links";

import { type FollowReporter, followProjectLink, type LinkDestination } from "./follow-link";
import { createProjectLinkResolver, type LinkResolutionScope } from "./project-link-resolver";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

export type LinkFollower = {
  follow(target: LinkTarget, gesture?: LinkFollowDisposition): void;
  /** Abort every in-flight follow, then clear its outcome. */
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
    return resolution.registerResolver(
      createProjectLinkResolver({ projectId, workId, baseUri }, index),
    );
    // `index` stays the same object while its revision does, so a different one
    // is a different catalog: registering against it is how an answer about the
    // old one becomes unreachable.
  }, [baseUri, index, projectId, resolution, workId]);

  const inFlight = useRef(new Set<AbortController>());

  const follow = useCallback(
    (target: LinkTarget, gesture: LinkFollowDisposition = "current") => {
      if (!resolution) return;
      const controller = new AbortController();
      inFlight.current.add(controller);
      void followProjectLink({
        target,
        gesture,
        resolution,
        open,
        reporter,
        signal: controller.signal,
      }).finally(() => inFlight.current.delete(controller));
    },
    [open, reporter, resolution],
  );

  const cancel = useCallback(() => {
    // Abort first: the procedure clears the outcome itself right before it
    // opens, so clearing first would leave a window where an answer lands,
    // opens, and the writer's Cancel meant nothing.
    for (const controller of inFlight.current) controller.abort();
    inFlight.current.clear();
    reporter.clear();
  }, [reporter]);

  return useMemo(() => ({ follow, cancel }), [cancel, follow]);
}
