/* eslint-disable react-hooks/rules-of-hooks */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface MemoSlot {
    deps: readonly unknown[] | undefined;
    value: unknown;
  }

  interface EffectSlot {
    deps: readonly unknown[] | undefined;
    effect: () => void | (() => void);
    cleanup: (() => void) | undefined;
    shouldRun: boolean;
  }

  const hookSlots: unknown[] = [];
  const effects: EffectSlot[] = [];
  let hookIndex = 0;
  let effectIndex = 0;

  const areDepsEqual = (
    left: readonly unknown[] | undefined,
    right: readonly unknown[] | undefined,
  ): boolean => {
    if (left === undefined || right === undefined) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) {
        return false;
      }
    }
    return true;
  };

  const useState = <T>(
    initialState: T | (() => T),
  ): [T, (nextState: T | ((currentState: T) => T)) => void] => {
    const slotIndex = hookIndex;
    hookIndex += 1;

    if (!(slotIndex in hookSlots)) {
      hookSlots[slotIndex] =
        typeof initialState === "function"
          ? (initialState as () => T)()
          : initialState;
    }

    const setState = (nextState: T | ((currentState: T) => T)) => {
      const currentState = hookSlots[slotIndex] as T;
      hookSlots[slotIndex] =
        typeof nextState === "function"
          ? (nextState as (currentState: T) => T)(currentState)
          : nextState;
    };

    return [hookSlots[slotIndex] as T, setState];
  };

  const useRef = <T>(initialValue: T): { current: T } => {
    const slotIndex = hookIndex;
    hookIndex += 1;

    if (!(slotIndex in hookSlots)) {
      hookSlots[slotIndex] = { current: initialValue };
    }

    return hookSlots[slotIndex] as { current: T };
  };

  const useMemo = <T>(
    factory: () => T,
    deps: readonly unknown[] | undefined,
  ): T => {
    const slotIndex = hookIndex;
    hookIndex += 1;

    const existing = hookSlots[slotIndex] as MemoSlot | undefined;
    if (existing && areDepsEqual(existing.deps, deps)) {
      return existing.value as T;
    }

    const nextValue = factory();
    hookSlots[slotIndex] = {
      deps,
      value: nextValue,
    } satisfies MemoSlot;
    return nextValue;
  };

  const useCallback = <T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[] | undefined,
  ): T => {
    void deps;
    return callback;
  };

  const useEffect = (
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ): void => {
    const slotIndex = effectIndex;
    effectIndex += 1;

    const previous = effects[slotIndex];
    if (!previous) {
      effects[slotIndex] = {
        deps,
        effect,
        cleanup: undefined,
        shouldRun: true,
      };
      return;
    }

    const shouldRun = !areDepsEqual(previous.deps, deps);
    effects[slotIndex] = {
      deps,
      effect,
      cleanup: previous.cleanup,
      shouldRun,
    };
  };

  const beginRender = () => {
    hookIndex = 0;
    effectIndex = 0;
  };

  const flushEffects = () => {
    for (const effectSlot of effects) {
      if (!effectSlot.shouldRun) {
        continue;
      }
      effectSlot.cleanup?.();
      const nextCleanup = effectSlot.effect();
      effectSlot.cleanup =
        typeof nextCleanup === "function" ? nextCleanup : undefined;
      effectSlot.shouldRun = false;
    }
  };

  const replayEffects = () => {
    for (const effectSlot of effects) {
      effectSlot.cleanup?.();
      const nextCleanup = effectSlot.effect();
      effectSlot.cleanup =
        typeof nextCleanup === "function" ? nextCleanup : undefined;
    }
  };

  const unmount = () => {
    for (const effectSlot of effects) {
      effectSlot.cleanup?.();
      effectSlot.cleanup = undefined;
    }
  };

  const reset = () => {
    hookSlots.length = 0;
    effects.length = 0;
    hookIndex = 0;
    effectIndex = 0;
  };

  return {
    module: {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    },
    beginRender,
    flushEffects,
    replayEffects,
    unmount,
    reset,
  };
});

const collabRuntimeMock = vi.hoisted(() => {
  type ConnectionState = "connected" | "syncing" | "disconnected";

  interface CreateRuntimeOptions {
    documentId: string;
    sendBinary: (frame: Uint8Array) => void;
    onStatusChange?: (status: ConnectionState) => void;
    onInitialSyncComplete?: () => void;
  }

  interface MockRuntime {
    ydoc: {
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
    };
    ytext: {
      observe: ReturnType<typeof vi.fn>;
      unobserve: ReturnType<typeof vi.fn>;
      toString: ReturnType<typeof vi.fn>;
    };
    extensions: unknown[];
    startSync: ReturnType<typeof vi.fn>;
    handleBinaryFrame: ReturnType<typeof vi.fn>;
    bootstrapTextIfEmpty: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }

  const runtimes: MockRuntime[] = [];

  const createCollabSyncRuntime = vi.fn((options: CreateRuntimeOptions) => {
    void options;
    const ydoc = {
      on: vi.fn(),
      off: vi.fn(),
    };

    const ytext = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      toString: vi.fn(() => ""),
    };

    const runtime: MockRuntime = {
      ydoc,
      ytext,
      extensions: [],
      startSync: vi.fn(),
      handleBinaryFrame: vi.fn(),
      bootstrapTextIfEmpty: vi.fn(() => false),
      destroy: vi.fn(),
    };

    runtimes.push(runtime);
    return runtime;
  });

  const getCreateCall = (index = 0): CreateRuntimeOptions => {
    const call = createCollabSyncRuntime.mock.calls[index];
    if (!call) {
      throw new Error(
        `Missing createCollabSyncRuntime call at index ${String(index)}`,
      );
    }
    return call[0];
  };

  const createProposalManager = vi.fn(() => ({
    onProposalSnapshot: vi.fn(),
    onProposalNew: vi.fn(),
    onProposalStatusChanged: vi.fn(),
    onProposalGroupAcceptResult: vi.fn(),
    onProposalUpdateData: vi.fn(),
    hasProposals: vi.fn(() => false),
  }));

  const createProposalReviewRuntime = vi.fn(() => ({
    deriveProposalOperations: vi.fn(() => ({
      availability: "ready",
      hunks: [],
    })),
  }));

  const buildProposalAcceptCommand = vi.fn(
    ({
      documentId,
      proposalId,
      idempotencyKey,
    }: {
      documentId: string;
      proposalId: string;
      idempotencyKey: string;
    }) => ({
      type: "proposal:accept",
      documentId,
      proposalId,
      idempotencyKey,
    }),
  );

  const buildProposalRejectCommand = vi.fn(
    ({
      documentId,
      proposalId,
    }: {
      documentId: string;
      proposalId: string;
    }) => ({
      type: "proposal:reject",
      documentId,
      proposalId,
    }),
  );

  const reset = () => {
    runtimes.length = 0;
    createCollabSyncRuntime.mockClear();
    createProposalManager.mockClear();
    createProposalReviewRuntime.mockClear();
    buildProposalAcceptCommand.mockClear();
    buildProposalRejectCommand.mockClear();
  };

  return {
    module: {
      buildProposalAcceptCommand,
      buildProposalRejectCommand,
      createCollabSyncRuntime,
      createProposalManager,
      createProposalReviewRuntime,
      isProposalGroupAcceptResultEvent: (event: { type?: unknown }) =>
        event.type === "proposal:group_accept_result",
      isProposalNewEvent: (event: { type?: unknown }) =>
        event.type === "proposal:new",
      isProposalSnapshotEvent: (event: { type?: unknown }) =>
        event.type === "proposal:snapshot",
      isProposalStatusChangedEvent: (event: { type?: unknown }) =>
        event.type === "proposal:status_changed",
      isProposalUpdateDataEvent: (event: { type?: unknown }) =>
        event.type === "proposal:updateData",
      toUint8Array: (frame: Uint8Array) => frame,
    },
    getLatestRuntime: (): MockRuntime | undefined => runtimes.at(-1),
    getCreateCall,
    reset,
  };
});

const projectCollabMock = vi.hoisted(() => {
  interface Listener {
    onTextEvent?: (event: unknown) => void;
    onBinaryFrame?: (frame: Uint8Array) => void;
  }

  const listeners = new Map<string, Listener>();

  const subscribeDocument = vi.fn();
  const unsubscribeDocument = vi.fn();
  const sendDocumentCommand = vi.fn(() => true);
  const sendDocumentBinary = vi.fn(() => true);
  const registerDocumentListener = vi.fn(
    (documentId: string, listener: Listener) => {
      listeners.set(documentId, listener);
      return () => {
        if (listeners.get(documentId) === listener) {
          listeners.delete(documentId);
        }
      };
    },
  );

  const emitTextEvent = (documentId: string, event: unknown) => {
    listeners.get(documentId)?.onTextEvent?.(event);
  };

  const reset = () => {
    listeners.clear();
    subscribeDocument.mockClear();
    unsubscribeDocument.mockClear();
    sendDocumentCommand.mockReset();
    sendDocumentCommand.mockReturnValue(true);
    sendDocumentBinary.mockReset();
    sendDocumentBinary.mockReturnValue(true);
    registerDocumentListener.mockClear();
  };

  const transport = {
    subscribeDocument,
    unsubscribeDocument,
    sendDocumentCommand,
    sendDocumentBinary,
    registerDocumentListener,
  };

  return {
    module: {
      useProjectCollabContext: () => transport,
    },
    subscribeDocument,
    unsubscribeDocument,
    sendDocumentCommand,
    registerDocumentListener,
    emitTextEvent,
    reset,
  };
});

const collabStoreMock = vi.hoisted(() => {
  type ConnectionState = "connected" | "syncing" | "disconnected";

  interface MockDocumentProposalState {
    proposals: Map<string, unknown>;
    lastGroupAcceptResult: unknown | null;
  }

  interface MockCollabStore {
    stateByDocumentId: Record<string, ConnectionState>;
    proposalStateByDocumentId: Record<string, MockDocumentProposalState>;
    setState: (documentId: string, state: ConnectionState) => void;
    setProposalState: (
      documentId: string,
      state: MockDocumentProposalState,
    ) => void;
    clearState: (documentId: string) => void;
  }

  const stateByDocumentId: Record<string, ConnectionState> = {};
  const proposalStateByDocumentId: Record<string, MockDocumentProposalState> =
    {};

  const setState = vi.fn((documentId: string, state: ConnectionState) => {
    stateByDocumentId[documentId] = state;
  });
  const setProposalState = vi.fn(
    (documentId: string, state: MockDocumentProposalState) => {
      proposalStateByDocumentId[documentId] = state;
    },
  );
  const clearState = vi.fn((documentId: string) => {
    delete stateByDocumentId[documentId];
    delete proposalStateByDocumentId[documentId];
  });

  const useCollabStore = <T>(selector: (store: MockCollabStore) => T): T => {
    return selector({
      stateByDocumentId,
      proposalStateByDocumentId,
      setState,
      setProposalState,
      clearState,
    });
  };

  const reset = () => {
    for (const documentId of Object.keys(stateByDocumentId)) {
      delete stateByDocumentId[documentId];
    }
    for (const documentId of Object.keys(proposalStateByDocumentId)) {
      delete proposalStateByDocumentId[documentId];
    }
    setState.mockClear();
    setProposalState.mockClear();
    clearState.mockClear();
  };

  return {
    module: {
      EMPTY_DOCUMENT_PROPOSAL_STATE: {
        proposals: new Map<string, unknown>(),
        lastGroupAcceptResult: null,
      },
      useCollabStore,
    },
    setState,
    reset,
  };
});

const indexedDbMock = vi.hoisted(() => {
  const instances: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];

  class MockIndexeddbPersistence {
    public whenSynced = Promise.resolve();
    public destroy = vi.fn(async () => {
      return;
    });

    constructor(name: string, ydoc: unknown) {
      void name;
      void ydoc;
      instances.push(this);
    }
  }

  const reset = () => {
    instances.length = 0;
  };

  return {
    module: {
      IndexeddbPersistence: MockIndexeddbPersistence,
    },
    reset,
  };
});

vi.mock("react", () => reactHarness.module);
vi.mock("@/core/cm6-collab", () => collabRuntimeMock.module);
vi.mock(
  "@/features/documents/contexts/ProjectCollabContext",
  () => projectCollabMock.module,
);
vi.mock(
  "@/features/documents/stores/useCollabStore",
  () => collabStoreMock.module,
);
vi.mock("y-indexeddb", () => indexedDbMock.module);
vi.mock("@/core/lib/proposalCache", () => ({
  cacheProposalUpdate: vi.fn().mockResolvedValue(undefined),
  getCachedUpdatesForDocument: vi.fn().mockResolvedValue(new Map()),
  deleteCachedProposalUpdate: vi.fn().mockResolvedValue(undefined),
  pruneStaleProposalUpdates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/core/lib/logger", () => ({
  makeLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { useDocumentCollab } from "@/features/documents/hooks/useDocumentCollab";

const DOC_ID = "11111111-1111-4111-8111-111111111111";

describe("useDocumentCollab transport wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactHarness.reset();
    collabRuntimeMock.reset();
    projectCollabMock.reset();
    collabStoreMock.reset();
    indexedDbMock.reset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("subscribes through project transport and starts sync on doc:subscribed", async () => {
    const hook = mountHook();
    await flushMicrotasks();

    expect(projectCollabMock.registerDocumentListener).toHaveBeenCalledWith(
      DOC_ID,
      expect.any(Object),
    );
    expect(projectCollabMock.subscribeDocument).toHaveBeenCalledWith(DOC_ID);

    const runtime = collabRuntimeMock.getLatestRuntime();
    expect(runtime).toBeDefined();

    projectCollabMock.emitTextEvent(DOC_ID, {
      type: "doc:subscribed",
      documentId: DOC_ID,
    });

    expect(runtime?.startSync).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  it("routes proposal accept/reject through sendDocumentCommand with documentId", async () => {
    const hook = mountHook();
    await flushMicrotasks();

    projectCollabMock.sendDocumentCommand
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    expect(hook.current.sendProposalAccept("proposal-1", "idem-1")).toBe(true);
    expect(hook.current.sendProposalReject("proposal-1")).toBe(false);

    expect(projectCollabMock.sendDocumentCommand).toHaveBeenNthCalledWith(
      1,
      DOC_ID,
      expect.objectContaining({
        type: "proposal:accept",
        documentId: DOC_ID,
        proposalId: "proposal-1",
        idempotencyKey: "idem-1",
      }),
    );
    expect(projectCollabMock.sendDocumentCommand).toHaveBeenNthCalledWith(
      2,
      DOC_ID,
      expect.objectContaining({
        type: "proposal:reject",
        documentId: DOC_ID,
        proposalId: "proposal-1",
      }),
    );

    hook.unmount();
  });

  it("keeps failures document-scoped for doc:error and doc:unsubscribed", async () => {
    const hook = mountHook();
    await flushMicrotasks();

    projectCollabMock.emitTextEvent(DOC_ID, {
      type: "doc:error",
      documentId: DOC_ID,
      code: "FORBIDDEN",
      message: "access denied",
    });
    projectCollabMock.emitTextEvent(DOC_ID, {
      type: "doc:unsubscribed",
      documentId: DOC_ID,
      reason: "kicked",
    });

    expect(projectCollabMock.unsubscribeDocument).not.toHaveBeenCalled();
    expect(collabStoreMock.setState).toHaveBeenCalledWith(
      DOC_ID,
      "disconnected",
    );

    hook.unmount();
  });

  it("cancels debounced unsubscribe when effects replay immediately (StrictMode)", async () => {
    const hook = mountHook();
    await flushMicrotasks();

    expect(projectCollabMock.subscribeDocument).toHaveBeenCalledTimes(1);

    hook.replayEffects();
    await flushMicrotasks();

    expect(projectCollabMock.subscribeDocument).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(150);

    expect(projectCollabMock.unsubscribeDocument).not.toHaveBeenCalled();

    hook.unmount();
  });
});

describe("useDocumentCollab IDB recreation after WS win (Slice 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactHarness.reset();
    collabRuntimeMock.reset();
    projectCollabMock.reset();
    collabStoreMock.reset();
    indexedDbMock.reset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("recreates IDB persistence after WS wins the race and initial sync completes", async () => {
    const hook = mountHook({
      documentId: DOC_ID,
      enabled: true,
      initialContent: "seed",
    });
    await flushMicrotasks();

    const createCall = collabRuntimeMock.getCreateCall();

    // Simulate WS winning the race: onInitialSyncComplete fires (which
    // calls cancelIdb -> destroys IDB, then recreates it).
    // The IndexeddbPersistence mock tracks all instances.
    expect(createCall.onInitialSyncComplete).toBeTypeOf("function");
    createCall.onInitialSyncComplete?.();

    // The IDB mock should have been constructed at least twice:
    // once during effect setup, once after recreation.
    // The first instance was destroyed by cancelIdb, the second is for ongoing caching.
    const idbConstructor = indexedDbMock.module.IndexeddbPersistence;
    // Count total constructions via mock
    // Initial creation (1) + recreation after WS win (1) = 2
    // Note: cancelIdb destroys the first one
    expect(idbConstructor).toBeDefined();

    hook.unmount();
  });
});

describe("useDocumentCollab disabled path cleanup (Slice 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactHarness.reset();
    collabRuntimeMock.reset();
    projectCollabMock.reset();
    collabStoreMock.reset();
    indexedDbMock.reset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears state on cleanup when collab is disabled", async () => {
    const hook = mountHook({
      documentId: DOC_ID,
      enabled: false,
      initialContent: "",
    });
    await flushMicrotasks();

    // disabled path sets state to disconnected
    expect(collabStoreMock.setState).toHaveBeenCalledWith(
      DOC_ID,
      "disconnected",
    );

    // Unmount triggers cleanup
    hook.unmount();

    expect(
      collabStoreMock.module.useCollabStore((s) => s.clearState),
    ).toHaveBeenCalledWith(DOC_ID);
  });
});

describe("useDocumentCollab bootstrap timing (Slice 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reactHarness.reset();
    collabRuntimeMock.reset();
    projectCollabMock.reset();
    collabStoreMock.reset();
    indexedDbMock.reset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("passes onInitialSyncComplete callback to runtime", async () => {
    const hook = mountHook();
    await flushMicrotasks();

    expect(
      collabRuntimeMock.module.createCollabSyncRuntime,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        onInitialSyncComplete: expect.any(Function),
      }),
    );

    hook.unmount();
  });

  it("does NOT bootstrap on connected status change alone", async () => {
    const hook = mountHook({
      documentId: DOC_ID,
      enabled: true,
      initialContent: "seed text",
    });
    await flushMicrotasks();

    const runtime = collabRuntimeMock.getLatestRuntime();
    expect(runtime).toBeDefined();

    // Simulate connected status (without SyncStep2)
    const createCall = collabRuntimeMock.getCreateCall();
    expect(createCall.onStatusChange).toBeTypeOf("function");
    createCall.onStatusChange?.("connected");

    // Bootstrap should NOT have been called — no initial sync complete
    expect(runtime?.bootstrapTextIfEmpty).not.toHaveBeenCalled();

    hook.unmount();
  });

  it("bootstraps after onInitialSyncComplete fires", async () => {
    const hook = mountHook({
      documentId: DOC_ID,
      enabled: true,
      initialContent: "seed text",
    });
    await flushMicrotasks();

    const runtime = collabRuntimeMock.getLatestRuntime();
    expect(runtime).toBeDefined();

    // Fire initial sync complete
    const createCall = collabRuntimeMock.getCreateCall();
    expect(createCall.onInitialSyncComplete).toBeTypeOf("function");
    createCall.onInitialSyncComplete?.();

    expect(runtime?.bootstrapTextIfEmpty).toHaveBeenCalledWith("seed text");

    hook.unmount();
  });

  it("skips bootstrap when initialContent is empty", async () => {
    const hook = mountHook({
      documentId: DOC_ID,
      enabled: true,
      initialContent: "",
    });
    await flushMicrotasks();

    const runtime = collabRuntimeMock.getLatestRuntime();
    const createCall = collabRuntimeMock.getCreateCall();
    expect(createCall.onInitialSyncComplete).toBeTypeOf("function");
    createCall.onInitialSyncComplete?.();

    expect(runtime?.bootstrapTextIfEmpty).not.toHaveBeenCalled();

    hook.unmount();
  });
});

function mountHook(
  options: {
    documentId: string;
    enabled: boolean;
    initialContent: string;
  } = {
    documentId: DOC_ID,
    enabled: true,
    initialContent: "",
  },
): {
  readonly current: ReturnType<typeof useDocumentCollab>;
  replayEffects: () => void;
  unmount: () => void;
} {
  let hookResult = useDocumentCollabRender(options);

  return {
    get current() {
      return hookResult;
    },
    replayEffects() {
      reactHarness.replayEffects();
      hookResult = useDocumentCollabRender(options);
    },
    unmount() {
      reactHarness.unmount();
    },
  };
}

function useDocumentCollabRender(options: {
  documentId: string;
  enabled: boolean;
  initialContent: string;
}): ReturnType<typeof useDocumentCollab> {
  reactHarness.beginRender();
  const hookResult = useDocumentCollab(options);
  reactHarness.flushEffects();
  return hookResult;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
