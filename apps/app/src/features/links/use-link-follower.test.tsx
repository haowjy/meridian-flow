// @vitest-environment jsdom
/** What aborts a follow, and what survives a registration change. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import { createLinkResolution, type LinkResolution, type LinkTarget } from "@/core/editor/links";

import { CHECKING_DELAY_MS, type FollowReporter, type LinkDestination } from "./follow-link";
import type { LinkResolutionScope } from "./project-link-resolver";
import { type LinkFollower, useLinkFollower } from "./use-link-follower";
import type { LinkableDocumentIndex } from "./useLinkableDocuments";

vi.mock("@/client/api/document-links-api", () => ({ resolveDocumentLink: vi.fn() }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const server = vi.mocked(resolveDocumentLink);

function doc(name: string): ResolvedDocumentLink {
  return {
    documentId: `doc-${name}`,
    title: name,
    scheme: "manuscript",
    path: `${name}.md`,
    uri: `manuscript://${name}.md`,
    workId: null,
  };
}

/** Server answers the test releases by name. */
let pending: Map<string, (document: ResolvedDocumentLink | null) => void>;
let events: string[];
let resolution: LinkResolution;
let root: Root;
let host: HTMLDivElement;
let follower: LinkFollower;

const scope: LinkResolutionScope = { projectId: "project-1", workId: null, baseUri: null };
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

function Probe(props: { scope: LinkResolutionScope | null; index: LinkableDocumentIndex }) {
  follower = useLinkFollower({ ...props, resolution, open, reporter });
  return null;
}

function render(props: { scope: LinkResolutionScope | null; index: LinkableDocumentIndex }) {
  act(() => root.render(<Probe {...props} />));
}

const wikilink = (name: string): LinkTarget => ({ kind: "wikilink", name });

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
  resolution = createLinkResolution();
  server.mockReset();
  server.mockImplementation(
    (_projectId, { target }) =>
      new Promise((done) => {
        const name = target.kind === "wikilink" ? target.name : "";
        pending.set(name, (document) => done({ document }));
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
    act(() => follower.follow(wikilink("First")));
    act(() => follower.follow(wikilink("Second")));

    await answer("Second", doc("second"));
    await answer("First", doc("first"));

    expect(events).toEqual(["clear", "open:doc-second:current"]);
  });

  it("never aborts a background follow, and a background follow aborts nothing", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Tab"), "new-tab"));
    act(() => follower.follow(wikilink("Pane")));
    act(() => follower.follow(wikilink("Other tab"), "new-tab"));

    await answer("Pane", doc("pane"));
    await answer("Tab", doc("tab"));
    await answer("Other tab", doc("other"));

    expect(events.filter((event) => event.startsWith("open"))).toEqual([
      "open:doc-pane:current",
      "open:doc-tab:new-tab",
      "open:doc-other:new-tab",
    ]);
  });

  it("cancels everything in flight and clears the outcome", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Pane")));
    act(() => follower.follow(wikilink("Tab"), "new-tab"));
    await elapse(CHECKING_DELAY_MS);

    act(() => follower.cancel());
    await answer("Pane", doc("pane"));
    await answer("Tab", doc("tab"));

    expect(events).toEqual(["report:checking", "report:checking", "clear"]);
  });

  it("reports nothing and opens nothing once unmounted mid-check", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(CHECKING_DELAY_MS);

    act(() => root.render(null));
    await answer("Kael", doc("kael"));
    await elapse(CHECKING_DELAY_MS);

    expect(events).toEqual(["report:checking"]);
  });

  it("does nothing without a scope, rather than saying the link could not be checked", async () => {
    render({ scope: null, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(CHECKING_DELAY_MS * 2);

    expect(events).toEqual([]);
    expect(server).not.toHaveBeenCalled();
  });

  it("opens through a catalog change landing mid-follow", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(CHECKING_DELAY_MS);

    // A rename elsewhere: a new catalog revision, so the scope registers again.
    render({ scope, index: catalog("b") });
    await elapse(0);
    await answer("Kael", doc("kael"));

    expect(server).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["report:checking", "clear", "open:doc-kael:current"]);
  });

  it("drops a follow when the Work changes under it", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));

    render({ scope: { ...scope, workId: "work-2" }, index: catalog("a") });
    await elapse(0);
    await answer("Kael", doc("kael"));
    await elapse(CHECKING_DELAY_MS);

    expect(events).toEqual([]);
  });
});
