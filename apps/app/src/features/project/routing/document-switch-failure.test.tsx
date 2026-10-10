// @vitest-environment jsdom
/** Explicit switch failures stay on the chosen destination, or on the initiating control. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { runDocumentSwitch, useRailSwitchFailure } from "./document-switch-failure";
import {
  type OpenContextRoute,
  ProjectNavigationProvider,
  useOpenContextRoute,
} from "./ProjectNavigationContext";
import type { NavigationSettlement, ProjectHistoryEntry } from "./project-navigation";

function setup() {
  let entry: ProjectHistoryEntry = { href: "/chat", key: "source", state: {} };
  const onSourceFailure = vi.fn();
  const onDestinationFailure = vi.fn();
  const ports = { read: () => entry, isCurrent: () => true, onDestinationFailure };
  const failed = (): NavigationSettlement => ({
    kind: "failed",
    error: new Error("Open failed"),
    ticket: { href: entry.href, key: entry.key, revision: 1 },
  });
  return {
    ports,
    onSourceFailure,
    onDestinationFailure,
    failed,
    freezeDeparture: () => {
      entry = { href: "/chat?work=none", key: "frozen-source", state: {} };
    },
    accept: () => {
      entry = { href: "/editor", key: "destination", state: {} };
    },
  };
}

it("a failure after acceptance presents on the destination, never the source control", async () => {
  const rig = setup();
  await runDocumentSwitch(
    async (onAccepted) => {
      rig.accept();
      onAccepted();
      return rig.failed();
    },
    rig.ports,
    rig.onSourceFailure,
  );
  expect(rig.onDestinationFailure).toHaveBeenCalledOnce();
  expect(rig.onSourceFailure).not.toHaveBeenCalled();
  expect(rig.ports.read().href).toBe("/editor");
});

it.each(["cancelled", "superseded"] as const)("a %s switch presents no failure", async (kind) => {
  const rig = setup();
  await runDocumentSwitch(async () => ({ kind }), rig.ports, rig.onSourceFailure);
  expect(rig.onDestinationFailure).not.toHaveBeenCalled();
  expect(rig.onSourceFailure).not.toHaveBeenCalled();
});

it("a failure before navigation leaves the source page alone and reports on its control", async () => {
  const rig = setup();
  await runDocumentSwitch(async () => rig.failed(), rig.ports, rig.onSourceFailure);
  expect(rig.onSourceFailure).toHaveBeenCalledOnce();
  expect(rig.onDestinationFailure).not.toHaveBeenCalled();
  expect(rig.ports.read().href).toBe("/chat");
});

it("consumes a rejected pre-navigation switch without marking the source page", async () => {
  const rig = setup();
  await expect(
    runDocumentSwitch(
      async () => {
        throw new Error("Dispatch failed");
      },
      rig.ports,
      rig.onSourceFailure,
    ),
  ).resolves.toBeUndefined();
  expect(rig.onSourceFailure).toHaveBeenCalledOnce();
  expect(rig.onDestinationFailure).not.toHaveBeenCalled();
});

it("a stale failure does not cover a newer destination", async () => {
  const rig = setup();
  rig.ports.isCurrent = () => false;
  await runDocumentSwitch(
    async (onAccepted) => {
      rig.accept();
      onAccepted();
      return rig.failed();
    },
    rig.ports,
    rig.onSourceFailure,
  );
  expect(rig.onDestinationFailure).not.toHaveBeenCalled();
  expect(rig.onSourceFailure).not.toHaveBeenCalled();
});

it("an unrelated useOpenContextRoute caller keeps its failed settlement without switch presentation", async () => {
  const rig = setup();
  const result = rig.failed();
  const open = vi.fn<OpenContextRoute>().mockResolvedValue(result);
  const switchPresentation = vi.fn();
  let command: OpenContextRoute | null = null;
  function Consumer() {
    command = useOpenContextRoute();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <ProjectNavigationProvider openContextRoute={open} runDocumentSwitch={switchPresentation}>
        <Consumer />
      </ProjectNavigationProvider>,
    );
  });
  if (!command) throw new Error("Missing command");
  const returned = await (command as OpenContextRoute)({
    scheme: "manuscript",
    path: "/chapter.md",
  });
  expect(returned).toBe(result);
  expect(switchPresentation).not.toHaveBeenCalled();
  const rejection = new Error("Existing caller-owned failure");
  open.mockRejectedValueOnce(rejection);
  await expect(
    (command as OpenContextRoute)({ scheme: "manuscript", path: "/another.md" }),
  ).rejects.toBe(rejection);
  expect(switchPresentation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("freezing a departure entry is not destination acceptance", async () => {
  const rig = setup();
  await runDocumentSwitch(
    async () => {
      rig.freezeDeparture();
      return rig.failed();
    },
    rig.ports,
    rig.onSourceFailure,
  );
  expect(rig.onSourceFailure).toHaveBeenCalledOnce();
  expect(rig.onDestinationFailure).not.toHaveBeenCalled();
});

it("retires a rail failure when another Work replaces its source entry", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Rail({ entryKey }: { entryKey: string }) {
    const [failed, setFailed] = useRailSwitchFailure(entryKey, "work");
    return (
      <button type="button" onClick={() => setFailed("context")}>
        {failed ?? "No failure"}
      </button>
    );
  }
  try {
    await act(async () => root.render(<Rail entryKey="work-A" />));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe("context");
    await act(async () => root.render(<Rail entryKey="work-B" />));
    expect(container.textContent).toBe("No failure");
    await act(async () => root.render(<Rail entryKey="work-A" />));
    expect(container.textContent).toBe("No failure");
  } finally {
    await act(async () => root.unmount());
  }
});
