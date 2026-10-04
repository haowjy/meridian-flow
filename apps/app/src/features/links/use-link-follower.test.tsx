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

function Probe({ index }: { index: LinkableDocumentIndex }) {
  follower = useLinkFollower({ scope, index, resolution, open, reporter });
  return null;
}

function render({ index }: { scope: LinkResolutionScope; index: LinkableDocumentIndex }) {
  act(() => root.render(<Probe index={index} />));
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
  resolution = createLinkResolution();
  server.mockReset();
  server.mockImplementation(
    (_projectId, { target }) =>
      new Promise((done) => {
        const name = target.kind === "scheme" ? target.uri.slice("manuscript://".length, -3) : "";
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
    act(() => follower.follow(address("First")));
    act(() => follower.follow(address("Second")));

    await answer("Second", doc("second"));
    await answer("First", doc("first"));

    // Nothing was shown, so the second follow has nothing of its own to clear.
    expect(events).toEqual(["open:doc-second:current"]);
  });

  it("never opens a follow cancelled while checking", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(address("Pane")));
    await elapse(CHECKING_DELAY_MS);

    act(() => follower.dismiss());
    await answer("Pane", doc("pane"));

    expect(events).toEqual(["report:checking", "clear"]);
  });

  it("opens through a catalog change landing mid-follow", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(address("Kael")));
    await elapse(CHECKING_DELAY_MS);

    // A rename elsewhere: a new catalog revision, so the scope registers again.
    render({ scope, index: catalog("b") });
    await elapse(0);
    await answer("Kael", doc("kael"));

    expect(events).toEqual(["report:checking", "clear", "open:doc-kael:current"]);
  });
});
