/**
 * The follow procedure's outcomes, on the real resolution cache and a fake
 * clock: what the writer sees after clicking an internal link, and when.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLinkResolution,
  type InternalLinkResolver,
  type LinkResolution,
  type LinkTarget,
} from "@/core/editor/links";

import { CHECKING_DELAY_MS, type FollowReporter, followProjectLink } from "./follow-link";

const KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "manuscript",
  path: "cast/Kael.md",
  uri: "manuscript://cast/Kael.md",
  workId: null,
};

const target: LinkTarget = { kind: "wikilink", name: "Kael" };

/** Everything the writer can observe, in the order it happened. */
let events: string[];
let resolution: LinkResolution;

const reporter: FollowReporter = {
  report: (outcome) => events.push(`report:${outcome.state}`),
  clear: () => events.push("clear"),
};

const open = async (document: { documentId: string }, gesture: string) => {
  events.push(`open:${document.documentId}:${gesture}`);
};

function follow(gesture: "current" | "new-tab" = "current", signal = new AbortController().signal) {
  return followProjectLink({ target, gesture, resolution, open, reporter, signal, candidates });
}

/** What the scope's index can prove the link matches; none unless a test says so. */
let candidates: (target: LinkTarget) => readonly ResolvedDocumentLink[];

function register(resolver: InternalLinkResolver) {
  resolution.registerResolver(resolver);
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  candidates = () => [];
  resolution = createLinkResolution();
});

afterEach(() => {
  resolution.destroy();
  vi.useRealTimers();
});

describe("followProjectLink", () => {
  it("opens a link already resolved for rendering and says nothing", async () => {
    register(async () => KAEL);
    resolution.request(["[[Kael]]"]);
    await vi.advanceTimersByTimeAsync(0);

    await follow("new-tab");

    expect(events).toEqual(["clear", "open:doc-kael:new-tab"]);
  });

  it("admits it is checking only after the delay, then clears and opens", async () => {
    let answer: (document: ResolvedDocumentLink | null) => void = () => {};
    register(() => new Promise((done) => (answer = done)));

    const followed = follow();
    await vi.advanceTimersByTimeAsync(CHECKING_DELAY_MS - 1);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["report:checking"]);

    answer(KAEL);
    await followed;
    expect(events).toEqual(["report:checking", "clear", "open:doc-kael:current"]);
  });

  it("reports a link nothing answers to as missing", async () => {
    register(async () => null);

    await follow();

    expect(events).toEqual(["report:missing"]);
  });

  it("reports a name several documents carry as ambiguous, with the candidates", async () => {
    const kbKael: ResolvedDocumentLink = { ...KAEL, documentId: "doc-kb-kael", scheme: "kb" };
    register(async () => "ambiguous");
    candidates = () => [KAEL, kbKael];

    await follow();

    expect(events).toEqual(["report:ambiguous"]);
  });

  it("reports a request that could not be made as failed, not missing", async () => {
    register(async () => {
      throw new Error("offline");
    });

    await follow();

    expect(events).toEqual(["report:failed"]);
  });

  it("never reports or opens once aborted, even after the answer lands", async () => {
    let answer: (document: ResolvedDocumentLink | null) => void = () => {};
    register(() => new Promise((done) => (answer = done)));
    const controller = new AbortController();

    const followed = follow("current", controller.signal);
    await vi.advanceTimersByTimeAsync(CHECKING_DELAY_MS - 1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(CHECKING_DELAY_MS);
    answer(KAEL);
    await followed;

    expect(events).toEqual([]);
  });

  it("settles a checking follow into missing in place", async () => {
    let answer: (document: ResolvedDocumentLink | null) => void = () => {};
    register(() => new Promise((done) => (answer = done)));

    const followed = follow();
    await vi.advanceTimersByTimeAsync(CHECKING_DELAY_MS);
    answer(null);
    await followed;

    expect(events).toEqual(["report:checking", "report:missing"]);
  });

  it("leaves an open alone once it has started, whatever the signal does after", async () => {
    register(async () => KAEL);
    const controller = new AbortController();
    let finishOpen: () => void = () => {};
    const destination = vi.fn(
      (document: { documentId: string }, gesture: string) =>
        new Promise<void>((done) => {
          events.push(`open:${document.documentId}:${gesture}`);
          finishOpen = done;
        }),
    );

    const followed = followProjectLink({
      target,
      gesture: "current",
      resolution,
      open: destination,
      reporter,
      signal: controller.signal,
      candidates,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    finishOpen();
    await followed;

    expect(events).toEqual(["clear", "open:doc-kael:current"]);
  });
});
