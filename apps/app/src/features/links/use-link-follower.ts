import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createLinkSettlements, useOptionalLinkSettlements } from "@/client/link-settlements";
import {
  createLinkAnswerCache,
  isInternalLinkTarget,
  type LinkAnswerCache,
  type LinkTarget,
} from "@/core/editor/links";
import {
  type FollowPolicy,
  type FollowReporter,
  followProjectLink,
  type LinkDestination,
} from "./follow-link";
import { createProjectLinkResolver, type LinkResolutionScope } from "./project-link-resolver";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

export type LinkFollower = {
  follow(target: LinkTarget, ref?: string | null, policy?: FollowPolicy): void;
  dismiss(): void;
  retry(): void;
  canFollow(target: LinkTarget): boolean;
};

type Shown = {
  owner: AbortController;
  target: LinkTarget;
  ref: string | null;
  policy: FollowPolicy | undefined;
};

export function useLinkFollower({
  scope,
  index,
  resolution: providedResolution,
  active = true,
  open,
  reporter,
}: {
  scope: LinkResolutionScope | "pending" | null;
  index: LinkableDocumentIndex;
  resolution?: LinkAnswerCache | null;
  active?: boolean;
  open: LinkDestination;
  reporter: FollowReporter;
}): LinkFollower {
  const [ownedResolution] = useState<LinkAnswerCache | null>(() =>
    providedResolution === undefined ? createLinkAnswerCache() : null,
  );
  const resolution = providedResolution === undefined ? ownedResolution : providedResolution;
  const accountSettlements = useOptionalLinkSettlements();
  const [ownedSettlements] = useState(createLinkSettlements);
  const settlements = accountSettlements ?? ownedSettlements;
  const ready = scope !== null && scope !== "pending" ? scope : null;
  const pending = scope === "pending";
  const projectId = ready?.projectId ?? null;
  const workId = ready?.workId ?? null;
  const rootThreadId = ready?.rootThreadId ?? null;
  const chatThreadId = ready?.chatThreadId ?? null;
  const baseUri = ready?.baseUri ?? null;
  const holderDocumentId = ready?.holderDocumentId ?? null;

  const latest = useRef({ open, reporter });
  useLayoutEffect(() => {
    latest.current = { open, reporter };
  });

  const scopeWaiters = useRef(new Set<() => void>());

  const catalog = useRef(index);
  useLayoutEffect(() => {
    catalog.current = index;
  });
  const revision = index.revision;
  useEffect(() => {
    if (!resolution || !projectId || !workId) return;
    const registered: LinkableDocumentIndex = {
      documents: catalog.current.documents,
      folders: catalog.current.folders,
      trees: catalog.current.trees,
      revision,
      get complete() {
        return catalog.current.complete;
      },
    };
    const unregister = resolution.registerResolver(
      createProjectLinkResolver(
        { projectId, workId, rootThreadId, chatThreadId, baseUri, holderDocumentId },
        registered,
        settlements,
      ),
      { baseUri, projectId },
    );
    for (const release of scopeWaiters.current) release();
    scopeWaiters.current.clear();
    // Defer unregister to a microtask; React runs cleanup and the next registration in one commit, so a synchronous unregister strands a pending click.
    return () => queueMicrotask(unregister);
  }, [
    baseUri,
    holderDocumentId,
    projectId,
    resolution,
    revision,
    rootThreadId,
    chatThreadId,
    settlements,
    workId,
  ]);

  const inFlight = useRef(new Set<AbortController>());
  const currentFollow = useRef<AbortController | null>(null);
  const shown = useRef<Shown | null>(null);

  const clearShown = useCallback(() => {
    shown.current = null;
    latest.current.reporter.clear();
  }, []);

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

  useEffect(() => abortAll, [abortAll, resolution]);

  useEffect(() => {
    if (active) return;
    abortAll();
    if (shown.current) clearShown();
  }, [abortAll, active, clearShown]);

  const answeredScope = useRef<string | null>(null);
  const scopeKey = ready
    ? `${ready.projectId}\u0000${ready.workId}\u0000${ready.rootThreadId ?? ""}\u0000${ready.chatThreadId ?? ""}`
    : pending
      ? null
      : "";
  useEffect(() => {
    if (scopeKey === null) return;
    if (answeredScope.current !== null && answeredScope.current !== scopeKey) {
      abortAll();
      if (!scopeKey && shown.current) clearShown();
    }
    answeredScope.current = scopeKey;
  }, [abortAll, clearShown, scopeKey]);

  const start = useCallback(
    (target: LinkTarget, ref: string | null, retrying: boolean, policy?: FollowPolicy) => {
      if (!resolution || !active || (!projectId && !pending)) return;
      const controller = new AbortController();
      if (currentFollow.current) abortFollow(currentFollow.current);
      currentFollow.current = controller;
      inFlight.current.add(controller);
      if (retrying) shown.current = { owner: controller, target, ref, policy };
      const owned: FollowReporter = {
        report(outcome) {
          if (policy?.missing && outcome.state === "missing") {
            if (shown.current?.owner === controller) clearShown();
            policy.missing();
            return;
          }
          shown.current = { owner: controller, target, ref, policy };
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
        ref,
        resolution,
        open: (document) => (policy?.open ?? latest.current.open)(document),
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
    (target: LinkTarget, ref: string | null = null, policy?: FollowPolicy) =>
      start(target, ref, false, policy),
    [start],
  );

  const dismiss = useCallback(() => {
    // Abort the in-flight follow before clearing the outcome; clearing first leaves a window where the answer lands and opens, making Cancel ineffective.
    const owner = shown.current?.owner;
    if (owner && inFlight.current.has(owner)) abortFollow(owner);
    else clearShown();
  }, [abortFollow, clearShown]);

  const retry = useCallback(() => {
    const again = shown.current;
    if (again) start(again.target, again.ref, true, again.policy);
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
