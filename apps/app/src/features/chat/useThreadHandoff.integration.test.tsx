// @vitest-environment jsdom
/** Mount-churn coverage for provider-owned first-send settlement. */
import type { SendMessageResponse } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, useCallback, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import {
  type AdmissionFailureKind,
  ThreadAdmissionError,
  ThreadRunController,
} from "@/client/copilot/ThreadRunController";
import {
  type ThreadStoreActions,
  ThreadStoreProvider,
  useThreadActions,
  useThreadStore,
} from "@/client/stores";
import { Composer, type ComposerHandle } from "@/components/app/composer";
import type { ThreadTransport } from "@/core/transport";
import { useThreadHandoff } from "./useThreadHandoff";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@/components/app/composer/placeholders", () => ({
  useComposerPlaceholder: () => "Write",
}));

type Gate = {
  promise: Promise<void>;
  resolve(): void;
  reject(kind: AdmissionFailureKind): void;
};

function gate(): Gate {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    promise,
    resolve,
    reject: (kind) => reject(new ThreadAdmissionError(kind, new Error(`${kind} failure`))),
  };
}

function rejectionGate<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, onReject) => {
    reject = onReject;
  });
  return { promise, reject };
}

function connectedTransport(): ThreadTransport {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    onConnectionState: vi.fn(() => () => {}),
    subscribe: vi.fn(() => () => {}),
    respondInterrupt: vi.fn(),
    cancel: vi.fn(),
    getConnectionToken: vi.fn(() => "conn-test"),
    awaitConnectionToken: vi.fn(async () => "conn-test"),
  };
}

function Destination({
  threadId,
  controller,
}: {
  threadId: string;
  controller: ThreadRunController;
}) {
  const actions = useThreadActions();
  const composerRef = useRef<ComposerHandle>(null);
  const restoreDraft = useCallback(
    (restoration: Parameters<ComposerHandle["restoreDraft"]>[0]) =>
      composerRef.current?.restoreDraft(restoration) ?? false,
    [],
  );
  useThreadHandoff(threadId, controller, actions, undefined, restoreDraft);
  return <Composer ref={composerRef} onSubmit={() => true} />;
}

let capturedActions: ThreadStoreActions | null = null;
let capturedFirstSend: { status: string; text: string } | undefined;
let capturedTurns = 0;

function CaptureActions() {
  capturedActions = useThreadActions();
  capturedFirstSend = useThreadStore((state) => state.firstSendByThreadId["thread-1"] ?? undefined);
  capturedTurns = useThreadStore((state) => state.turns("thread-1")?.length ?? 0);
  return null;
}

let host: HTMLDivElement;
let root: Root;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function renderDestination(
  controller: ThreadRunController | null,
  threadId: string | null,
  strict = false,
) {
  if (threadId && !controller) throw new Error("destination controller unavailable");
  const destination =
    threadId && controller ? <Destination threadId={threadId} controller={controller} /> : null;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThreadStoreProvider now={0}>
          <CaptureActions />
          {strict ? <StrictMode>{destination}</StrictMode> : destination}
        </ThreadStoreProvider>
      </QueryClientProvider>,
    );
  });
}

function stageAndArm(threadId: string, text = "exact first message") {
  if (!capturedActions) throw new Error("thread actions unavailable");
  capturedActions.stageFirstSend({
    threadId,
    text,
    optimisticUserTurnId: `turn_local_${threadId}`,
  });
  capturedActions.armFirstSend(threadId);
}

afterEach(async () => {
  capturedActions = null;
  capturedFirstSend = undefined;
  capturedTurns = 0;
  if (root) await act(async () => root.unmount());
  queryClient.clear();
  document.body.replaceChildren();
});

describe("useThreadHandoff first-send settlement", () => {
  it("rolls back and restores a provider-retained draft after an HTTP 409 refusal", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const admission = rejectionGate<SendMessageResponse>();
    const append = vi.fn(() => admission.promise);

    await renderDestination(null, null);
    if (!capturedActions) throw new Error("thread actions unavailable");
    const actions = capturedActions;
    const optimistic = actions.appendUserTurn("thread-1", "exact first message");
    actions.stageFirstSend({
      threadId: "thread-1",
      text: "exact first message",
      optimisticUserTurnId: optimistic.id,
    });
    actions.armFirstSend("thread-1");
    const controller = new ThreadRunController({
      transport: connectedTransport(),
      actions,
      appendUserMessageFn: append,
    });

    await renderDestination(controller, "thread-1", true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(capturedTurns).toBe(1);
    await renderDestination(controller, null);
    await act(async () => {
      admission.reject(
        new HttpResponseError("Turn already running", 409, {
          statusCode: 409,
          message: "Turn already running",
        }),
      );
    });

    expect(capturedTurns).toBe(0);
    expect(capturedFirstSend).toMatchObject({
      status: "failed",
      text: "exact first message",
    });

    await renderDestination(controller, "thread-1", true);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "exact first message",
    );
    expect(capturedFirstSend).toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("keeps a delayed definite failure through unmount and restores once on remount", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const admission = gate();
    const controller = {
      submit: vi.fn(() => admission.promise),
      resume: vi.fn(),
    } as unknown as ThreadRunController;

    await renderDestination(controller, null);
    await act(async () => stageAndArm("thread-1"));
    await renderDestination(controller, "thread-1", true);
    expect(controller.submit).toHaveBeenCalledTimes(1);

    await renderDestination(controller, null);
    await act(async () => admission.reject("definite"));
    expect(capturedActions).not.toBeNull();

    await renderDestination(controller, "thread-1", true);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "exact first message",
    );
    expect(controller.submit).toHaveBeenCalledTimes(1);

    await renderDestination(controller, null);
    await renderDestination(controller, "thread-1", true);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not deliver a failed draft to a Composer for another thread", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const admission = gate();
    const controller = {
      submit: vi.fn(() => admission.promise),
      resume: vi.fn(),
    } as unknown as ThreadRunController;

    await renderDestination(controller, null);
    await act(async () => stageAndArm("thread-1", "thread one draft"));
    await renderDestination(controller, "thread-1");
    await renderDestination(controller, "thread-2");
    await act(async () => admission.reject("definite"));
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");

    await renderDestination(controller, "thread-1");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("thread one draft");
  });

  it("quarantines an ambiguous settlement across remount without restoring or retrying", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const admission = gate();
    const controller = {
      submit: vi.fn(() => admission.promise),
      resume: vi.fn(),
    } as unknown as ThreadRunController;

    await renderDestination(controller, null);
    await act(async () => stageAndArm("thread-1"));
    await renderDestination(controller, "thread-1", true);
    await renderDestination(controller, null);
    await act(async () => admission.reject("ambiguous"));
    await renderDestination(controller, "thread-1", true);

    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(controller.submit).toHaveBeenCalledTimes(1);
  });
});
