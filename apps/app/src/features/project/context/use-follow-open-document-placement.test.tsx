// @vitest-environment jsdom
/**
 * The route follows an open document's placement only while the selection is bound to it.
 *
 * Pins implementation decisions: `projectResourceTab` is mocked to place the document at a new
 * path, since building a resource replica snapshot adds nothing to these cases.
 */
import "fake-indexeddb/auto";

import { beforeEach, expect, it, vi } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import type { ContextRouteSelection } from "./context-removal-protocol";
import { useFollowOpenDocumentPlacement } from "./use-follow-open-document-placement";

const tab: ContextTab = {
  kind: "tracked",
  documentId: "doc-a",
  scheme: "manuscript",
  path: "/old.md",
  name: "old.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  tabInstanceId: "instance-a",
};
const moved = { ...tab, path: "/new.md", name: "new.md" };

vi.mock("./context-tab-from-file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context-tab-from-file")>()),
  projectResourceTab: () => ({ kind: "projected", resourceHandle: "handle-a", tab: moved }),
}));

const locator = { scheme: "manuscript" as const, path: "/old.md", workId: "work-a" };
const bound: ContextRouteSelection = {
  status: "bound",
  revision: 1,
  locator,
  identity: { kind: "server", documentId: "doc-a" },
  by: "navigation",
};
const candidate: ContextRouteSelection = {
  status: "candidate",
  revision: 1,
  locator,
  obligations: [],
  reentryGuard: null,
};

beforeEach(() => {
  useContextTabsStore.setState({
    byProject: { project: { tabs: [tab], selectedTabIdByWork: {} } },
    _workspaceHydrated: true,
  });
});

async function follows(selection: ContextRouteSelection) {
  const open = vi.fn<OpenContextRoute>(async () => ({ kind: "applied" as const }));
  function Host() {
    useFollowOpenDocumentPlacement({
      projectId: "project",
      editorWorkId: "work-a",
      selection,
      activeContextScheme: "manuscript",
      activeContextPath: "/old.md",
      routeDisplayed: true,
      onOpenContextTarget: open,
    });
    return null;
  }
  await withReactRoot(
    <AccountFeatureTestProvider accountId="follow-account">
      <Host />
    </AccountFeatureTestProvider>,
    async () => undefined,
  );
  return open;
}

it("takes the route to the bound document's new placement", async () => {
  const open = await follows(bound);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toMatchObject({ path: "/new.md", documentId: "doc-a" });
});

it("leaves a route that is only a candidate where the writer put it", async () => {
  expect(await follows(candidate)).not.toHaveBeenCalled();
});

it("leaves a review address on its own path, which the live placement does not show", async () => {
  expect(await follows({ ...bound, by: "review" })).not.toHaveBeenCalled();
});
