// @ts-nocheck
/**
 * useChatThreadSession — binds chat surface lifecycle to the run controller.
 *
 * Rendering now reads `Turn[]` directly from ThreadStore. This hook only tears
 * down the active transport subscription on route switch, marks the active
 * streaming thread for shell chrome, and exposes the scroll parent refs.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadStoreActions } from "@/client/stores";

type Controller = ThreadRunController;

export function useChatThreadSession({
  threadId,
  controller,
  actions,
  isStreaming,
  projectId,
}: {
  threadId: string;
  projectId?: string | null;
  controller: Controller;
  actions: ThreadStoreActions;
  isStreaming: boolean;
}) {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  useEffect(() => {
    return () => {
      controllerRef.current.teardown();
    };
  }, [threadId]);

  useEffect(() => {
    if (!isStreaming) return;
    actions.setStreamingThreadId(threadId, projectId ?? null);
    return () => {
      actions.setStreamingThreadId(null);
    };
  }, [actions, isStreaming, projectId, threadId]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el === null) return;
    setScrollParent((prev) => (prev === el ? prev : el));
  }, []);

  return {
    scrollParent,
    scrollRef: setScrollRef,
  };
}
