/** Operation lifecycle contracts without React mounts or admission-age expiry. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import type { NamespaceIntent, ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { afterEach, expect, it, vi } from "vitest";
import { operationLifecycle, RenameOperationLifecycle } from "./rename-operation-lifecycle";

const subject = { kind: "file" as const, id: "document" };
const receipt = {
  operationId: "move",
  command: {
    kind: "move",
    sourceUri: "manuscript://old.md",
    destinationUri: "manuscript://Book/new.md",
    expected: { kind: "file", nodeId: "entry" },
  },
  result: { ok: true, value: { destinationPath: "Book/new.md" } },
} satisfies Extract<ContextOperationReceipt, { command: { kind: "move" } }>;

function intent(overrides: Partial<NamespaceIntent> = {}): NamespaceIntent {
  return {
    handle: "handle",
    projectId: "project",
    intentId: "intent",
    operationId: "move",
    sequence: 1,
    identityRevision: 1,
    desired: {
      kind: "set-location",
      destination: { parent: { kind: "folder", folderId: "Book" }, name: "new.md" },
    },
    attempts: [],
    state: "pending",
    ...overrides,
  };
}
function settled(overrides: Partial<NamespaceIntent> = {}): NamespaceIntent {
  return intent({
    state: "settled",
    settledAt: 10_000,
    attempts: [
      {
        attemptId: "attempt",
        request: {
          kind: "move",
          scheme: "manuscript",
          sourceWorkSlug: null,
          destinationWorkSlug: null,
          body: {
            operationId: "move",
            path: "old.md",
            expected: { kind: "file", nodeId: "entry" },
            destinationScheme: "manuscript",
            destinationFolderPath: "Book",
          },
        },
        outcome: { kind: "operation", receipt },
      },
    ],
    ...overrides,
  });
}
function projection(intents: NamespaceIntent[], terminal = false): ResourceProjectionSnapshot {
  return {
    records: [
      {
        resource: {
          handle: "handle",
          aliases: {},
          identity: { documentId: "document" },
          lifecycle: { kind: terminal ? "terminal" : "acknowledged" },
        },
        intents,
      },
    ],
    folders: [],
    catalogs: [],
  } as unknown as ResourceProjectionSnapshot;
}
function harness() {
  let emit: (snapshot: ResourceProjectionSnapshot) => void = () => {};
  const stop = vi.fn();
  const store = new RenameOperationLifecycle({
    readKnownDocument: async () => ({
      key: { handle: "handle" },
      record: projection([]).records[0] as ResourceProjectionSnapshot["records"][number],
    }),
    observeProjection: (_project, listener) => {
      emit = listener;
      return stop;
    },
  });
  return { store, stop, emit: (snapshot: ResourceProjectionSnapshot) => emit(snapshot) };
}
afterEach(() => vi.useRealTimers());

it("retires a refused move's cancelled successor without settlement or a mounted note", async () => {
  const { store, emit, stop } = harness();
  await store.remember("project", subject, "successor");
  emit(
    projection([
      intent({ state: "needs-repair", settledAt: 10_000 }),
      intent({ operationId: "successor", sequence: 2, state: "cancelled" }),
    ]),
  );
  expect(store.get("project", subject)).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
  expect(operationLifecycle([intent({ state: "needs-repair" })], "move", 10_000)).toEqual({
    kind: "retired",
  });
});

it("settles while unmounted and expires by settlement time, not admission time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const { store, emit, stop } = harness();
  await store.remember("project", subject, "move");
  emit(projection([intent()]));
  vi.advanceTimersByTime(9_000);
  expect(store.get("project", subject)?.operationId).toBe("move");
  emit(projection([settled()]));
  expect(store.get("project", subject)?.feedback?.deadline).toBe(14_000);
  expect(stop).not.toHaveBeenCalled();
  vi.advanceTimersByTime(3_999);
  expect(store.get("project", subject)).not.toBeNull();
  vi.advanceTimersByTime(1);
  expect(store.get("project", subject)).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
});

it("uses the rebased successor even when the historical match comes first", async () => {
  const historical = settled({ state: "superseded", sequence: 1, settledAt: 1_000 });
  const successor = intent({ sequence: 2 });
  expect(operationLifecycle([historical, successor], "move", 10_000)).toEqual({ kind: "pending" });
  expect(operationLifecycle([settled({ sequence: 2 }), historical], "move", 10_000)).toEqual({
    kind: "feedback",
    feedback: { receipt, deadline: 14_000 },
  });
});

it("retires deletion and scopes pending watches to the account lifetime", async () => {
  const { store, emit, stop } = harness();
  await store.remember("project", subject, "move");
  emit(projection([intent()], true));
  expect(store.get("project", subject)).toBeNull();
  await store.remember("project", subject, "another");
  store.dispose();
  expect(store.get("project", subject)).toBeNull();
  expect(stop).toHaveBeenCalledTimes(2);
  await store.remember("project", subject, "after-account-close");
  expect(store.get("project", subject)).toBeNull();
});

it("does not mistake a cached pre-admission projection for a refused operation", async () => {
  const { store, emit } = harness();
  await store.remember("project", subject, "move");
  emit(projection([]));
  expect(store.get("project", subject)?.operationId).toBe("move");
  emit(projection([intent()]));
  expect(store.get("project", subject)?.feedback).toBeNull();
  store.dispose();
});

it("retires feedback immediately when the resource is deleted before its deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const { store, emit, stop } = harness();
  await store.remember("project", subject, "move");
  emit(projection([settled()]));
  emit(projection([settled()], true));
  expect(store.get("project", subject)).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a folder watch until its folder is seen, and ends it once the folder is gone", async () => {
  const { store, emit, stop } = harness();
  const folder = { kind: "folder" as const, id: "folder" };
  const withFolder = (present: boolean) =>
    ({
      ...projection([]),
      folders: present ? [{ folderId: "folder", intents: [intent()] }] : [],
    }) as unknown as ResourceProjectionSnapshot;
  await store.remember("project", folder, "move");
  emit(withFolder(false));
  expect(store.get("project", folder)?.operationId).toBe("move");
  emit(withFolder(true));
  emit(withFolder(false));
  expect(store.get("project", folder)).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
});
