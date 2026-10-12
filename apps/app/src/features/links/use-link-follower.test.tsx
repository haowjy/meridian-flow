// @vitest-environment jsdom
/** What aborts a follow, and what survives a registration change. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentLinks } from "@/client/api/document-links-api";
import { createLinkAnswerCache, type LinkAnswerCache, type LinkTarget } from "@/core/editor/links";

import { CHECKING_DELAY_MS, type FollowReporter, type LinkDestination } from "./follow-link";
import type { LinkResolutionScope } from "./project-link-resolver";
import { type LinkFollower, useLinkFollower } from "./use-link-follower";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

vi.mock("@/client/api/document-links-api", () => ({ resolveDocumentLinks: vi.fn() }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const server = vi.mocked(resolveDocumentLinks);

const IDS: Record<string, string> = {
  first: "00000000-0000-4000-8000-000000000001",
  second: "00000000-0000-4000-8000-000000000002",
  pane: "00000000-0000-4000-8000-000000000003",
};

function doc(name: string): ResolvedDocumentLink {
  return {
    documentId: IDS[name] ?? "",
    title: name,
    scheme: "manuscript",
    path: `${name}.md`,
    uri: `manuscript://${name}.md`,
    workId: "no-work",
  };
}

/** Server answers the test releases by name. */
let pending: Map<string, (document: ResolvedDocumentLink | null) => void>;
let events: string[];
let resolution: LinkAnswerCache;
let root: Root;
let host: HTMLDivElement;
let follower: LinkFollower;

const scope: LinkResolutionScope = { projectId: "project-1", workId: "no-work", baseUri: null };
const reporter: FollowReporter = {
  report: (outcome) => events.push(`report:${outcome.state}`),
  clear: () => events.push("clear"),
};
const open: LinkDestination = async (document, gesture) => {
  events.push(`open:${document.documentId}:${gesture}`);
};

/** Incomplete, so every question reaches the (mocked) server. */
function catalog(revision: string): LinkableDocumentIndex {
  return { documents: [], revision, complete: false };
}

function Probe({
  scope: probed,
  index,
}: {
  scope: LinkResolutionScope;
  index: LinkableDocumentIndex;
}) {
  follower = useLinkFollower({ scope: probed, index, resolution, open, reporter });
  return null;
}

function render({
  scope: rendered,
  index,
}: {
  scope: LinkResolutionScope;
  index: LinkableDocumentIndex;
}) {
  act(() => root.render(<Probe scope={rendered} index={index} />));
}

const address = (name: string): LinkTarget => ({ kind: "scheme", uri: `manuscript://${name}.md` });

async function answer(name: string, document: ResolvedDocumentLink | null) {
  await act(async () => {
    pending.get(name)?.(document);
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  pending = new Map();
  events = [];
  resolution = createLinkAnswerCache();
  server.mockReset();
  // One link per batch here: each follow asks on its own.
  server.mockImplementation(
    (_projectId, { links }) =>
      new Promise((done) => {
        const href = links[0]?.href ?? "";
        pending.set(href.slice("manuscript://".length, -3), (document) =>
          done({
            answers: [
              document
                ? {
                    state: "document",
                    document: { ...document, id: document.documentId },
                    inDraft: false,
                  }
                : { state: "missing", uri: href },
            ],
          }),
        );
      }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resolution.destroy();
  vi.useRealTimers();
});

describe("useLinkFollower", () => {
  it("lets the latest current follow win", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(address("First")));
    act(() => follower.follow(address("Second")));

    await answer("Second", doc("second"));
    await answer("First", doc("first"));

    // Nothing was shown, so the second follow has nothing of its own to clear.
    expect(events).toEqual([`open:${IDS.second}:current`]);
  });

  it("never opens a follow cancelled while checking", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(address("Pane")));
    await elapse(CHECKING_DELAY_MS);

    act(() => follower.dismiss());
    await answer("Pane", doc("pane"));

    expect(events).toEqual(["report:checking", "clear"]);
  });
});
