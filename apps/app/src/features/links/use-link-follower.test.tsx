// @vitest-environment jsdom
/** What aborts a follow, and what survives a registration change. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import {
  createLinkResolution,
  type LinkFollowOutcome,
  type LinkResolution,
  type LinkTarget,
} from "@/core/editor/links";

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
let lastOutcome: LinkFollowOutcome | null;
let resolution: LinkResolution;
let root: Root;
let host: HTMLDivElement;
let follower: LinkFollower;

const scope: LinkResolutionScope = { projectId: "project-1", workId: null, baseUri: null };
const reporter: FollowReporter = {
  report: (outcome) => {
    lastOutcome = outcome;
    events.push(`report:${outcome.state}`);
  },
  clear: () => events.push("clear"),
};
const open: LinkDestination = async (document, gesture) => {
  events.push(`open:${document.documentId}:${gesture}`);
};

/** Incomplete, so every question reaches the (mocked) server. */
function catalog(revision: string): LinkableDocumentIndex {
  return { documents: [], revision, complete: false };
}

type ProbeProps = {
  scope: LinkResolutionScope | "pending" | null;
  index: LinkableDocumentIndex;
  active?: boolean;
  /** Chat's shape: the follower owns its cache. */
  ownCache?: boolean;
};

function Probe({ ownCache, ...props }: ProbeProps) {
  follower = useLinkFollower({
    ...props,
    ...(ownCache ? {} : { resolution }),
    open,
    reporter,
  });
  return null;
}

function render(props: ProbeProps) {
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
  lastOutcome = null;
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

    // Nothing was shown, so the second follow has nothing of its own to clear.
    expect(events).toEqual(["open:doc-second:current"]);
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

  it("dismisses only the follow whose checking is shown, leaving a background follow to open", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Tab"), "new-tab"));
    act(() => follower.follow(wikilink("Pane")));
    await elapse(CHECKING_DELAY_MS);

    act(() => follower.dismiss());
    await answer("Tab", doc("tab"));
    await answer("Pane", doc("pane"));

    expect(events).toEqual(["report:checking", "report:checking", "clear", "open:doc-tab:new-tab"]);
  });

  it("clears a failure when a fast retry opens the document", async () => {
    render({ scope, index: catalog("a") });
    server.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    act(() => follower.follow(wikilink("Kael")));
    await elapse(0);
    expect(events).toEqual(["report:failed"]);

    act(() => follower.retry());
    await answer("Kael", doc("kael"));

    expect(events).toEqual(["report:failed", "clear", "open:doc-kael:current"]);
  });

  it("re-asks only on Try again; a plain follow reads what the cache holds", async () => {
    render({ scope, index: catalog("a") });
    const resolve = vi.spyOn(resolution, "resolve");
    server.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    act(() => follower.follow(wikilink("Kael")));
    await elapse(0);
    expect(resolve).toHaveBeenLastCalledWith("[[Kael]]", { reask: false });

    act(() => follower.retry());
    await answer("Kael", doc("kael"));

    expect(resolve).toHaveBeenLastCalledWith("[[Kael]]", { reask: true });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("dismisses a settled outcome when the surface hides", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));
    await answer("Kael", null);

    render({ scope, index: catalog("a"), active: false });

    expect(events).toEqual(["report:missing", "clear"]);
  });

  it("says a link is followable from the target and base alone", () => {
    const relative: LinkTarget = { kind: "relative", path: "./cast.md" };
    render({ scope: null, index: catalog("a") });
    expect(follower.canFollow(wikilink("Kael"))).toBe(false);

    render({ scope: "pending", index: catalog("a") });
    expect(follower.canFollow(wikilink("Kael"))).toBe(true);
    expect(follower.canFollow(relative)).toBe(false);

    render({ scope: { ...scope, baseUri: "manuscript://chapters/one.md" }, index: catalog("a") });
    expect(follower.canFollow(relative)).toBe(true);
  });

  it("takes its checking outcome down and opens nothing once unmounted", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(CHECKING_DELAY_MS);

    act(() => root.render(null));
    await answer("Kael", doc("kael"));
    await elapse(CHECKING_DELAY_MS);

    expect(events).toEqual(["report:checking", "clear"]);
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

  it("takes down the checking a superseded pane follow was showing", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("First")));
    await elapse(CHECKING_DELAY_MS);

    act(() => follower.follow(wikilink("Second")));

    expect(events).toEqual(["report:checking", "clear"]);
  });

  it("lets a background follow open without wiping the pane follow's checking", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Pane")));
    await elapse(CHECKING_DELAY_MS);

    act(() => follower.follow(wikilink("Tab"), "new-tab"));
    await answer("Tab", doc("tab"));

    expect(events).toEqual(["report:checking", "open:doc-tab:new-tab"]);
  });

  it("lets a pane follow open without wiping a background follow's missing offer", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Tab"), "new-tab"));
    await answer("Tab", null);

    act(() => follower.follow(wikilink("Pane")));
    await answer("Pane", doc("pane"));

    expect(events).toEqual(["report:missing", "open:doc-pane:current"]);
  });

  it("waits for a pending scope, showing checking, and never asks a guessed one", async () => {
    render({ scope: "pending", index: catalog("a"), ownCache: true });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(CHECKING_DELAY_MS);

    expect(events).toEqual(["report:checking"]);
    expect(server).not.toHaveBeenCalled();

    render({ scope: { ...scope, workId: "work-1" }, index: catalog("a"), ownCache: true });
    await elapse(0);
    await answer("Kael", doc("kael"));

    expect(server).toHaveBeenCalledWith("project-1", {
      workId: "work-1",
      target: { kind: "wikilink", name: "Kael" },
    });
    expect(events).toEqual(["report:checking", "clear", "open:doc-kael:current"]);
  });

  it("aborts when the surface hides", async () => {
    render({ scope, index: catalog("a") });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(CHECKING_DELAY_MS);

    render({ scope, index: catalog("a"), active: false });
    await answer("Kael", doc("kael"));

    expect(events).toEqual(["report:checking", "clear"]);
  });

  it("names the documents a shared name matches, from a complete index, without asking the server", async () => {
    const kael = (documentId: string, uri: string) => ({
      documentId,
      uri,
      filename: "Kael.md",
      title: "Kael",
      location: "",
      aliases: [],
      workId: null,
    });
    const complete: LinkableDocumentIndex = {
      documents: [kael("doc-ms", "manuscript://Kael.md"), kael("doc-kb", "kb://Kael.md")],
      revision: "two-kaels",
      complete: true,
    };
    render({ scope, index: complete });
    act(() => follower.follow(wikilink("Kael")));
    await elapse(0);

    expect(server).not.toHaveBeenCalled();
    expect(events).toEqual(["report:ambiguous"]);
    expect(
      lastOutcome?.state === "ambiguous" && lastOutcome.candidates.map((entry) => entry.uri),
    ).toEqual(["manuscript://Kael.md", "kb://Kael.md"]);
  });
});
