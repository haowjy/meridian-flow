// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  CONTEXT_DESK_STORAGE_KEY,
  DeviceContextDeskLedger,
  parseContextDesk,
} from "./context-desk-storage";
import { rehydrateContextDesks, useContextTabsStore } from "./context-tabs-store";

afterEach(() => localStorage.clear());

it("resets a fresh durable account envelope before projecting the next account", async () => {
  localStorage.setItem(
    CONTEXT_DESK_STORAGE_KEY,
    JSON.stringify({
      version: 3,
      accountId: "fresh-account-A",
      deskRevision: 7,
      projects: {},
    }),
  );
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false, _deskRevision: 0 });

  await rehydrateContextDesks("fresh-account-B");

  await vi.waitFor(() => {
    expect(JSON.parse(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY) ?? "null")).toMatchObject({
      accountId: "fresh-account-B",
      deskRevision: 8,
      projects: {},
    });
    expect(useContextTabsStore.getState()).toMatchObject({
      byProject: {},
      _deskHydrated: true,
      _deskRevision: 8,
    });
  });
});

it("resets a non-null old desk and makes a late old-account command stale", async () => {
  const accountA = `nonnull-a-${crypto.randomUUID()}`;
  const accountB = `nonnull-b-${crypto.randomUUID()}`;
  await rehydrateContextDesks(accountA);
  await useContextTabsStore.getState().openTab("old-project", {
    kind: "tracked",
    tabInstanceId: "old-tab",
    documentId: "old-document",
    scheme: "manuscript",
    path: "/old.md",
    name: "old.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  });
  const lateA = new DeviceContextDeskLedger(localStorage, accountA);

  await rehydrateContextDesks(accountB);
  expect(parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY))).toMatchObject({
    accountId: accountB,
    projects: {},
  });
  await expect(
    lateA.apply({
      kind: "open",
      projectId: "late-project",
      tab: {
        kind: "tracked",
        tabInstanceId: "late-tab",
        documentId: "late-document",
        scheme: "manuscript",
        path: "/late.md",
        name: "late.md",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    }),
  ).resolves.toMatchObject({ kind: "stale", snapshot: { accountId: accountB } });
  expect(parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY))).toMatchObject({
    accountId: accountB,
    projects: {},
  });
  expect(useContextTabsStore.getState().byProject).toEqual({});
});
