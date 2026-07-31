/**
 * The store on its own, with no editor anywhere near it.
 *
 * The lane's own tests ([`../editor/links/link-resolution-decorations.test.ts`])
 * prove what a manuscript DRAWS; these prove what the store answers, which is
 * the half the chat transcript now leans on. The two states nothing else can
 * see from the outside are here: a failed request caching nothing, and an
 * answer from a retired generation coming back null rather than stale.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { createLinkResolution } from "./link-resolution";

const found: ResolvedDocumentLink = {
  documentId: "document-1",
  title: "The Second Gate",
  fileType: "markdown",
  scheme: "manuscript",
  path: "/the-second-gate.md",
  uri: "manuscript://the-second-gate.md",
  workId: null,
};

/** Lets every queued question settle before the assertion reads an answer. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what the store answers", () => {
  it("says nothing at all until a port registers", () => {
    const resolution = createLinkResolution();

    expect(resolution.available).toBe(false);
    expect(resolution.read("[[The Second Gate]]")).toBeNull();
  });

  it("keys two spellings of one target to a single question", async () => {
    const resolve = vi.fn(async () => found);
    const resolution = createLinkResolution();
    resolution.registerResolver(resolve);

    resolution.request(["[[The Second Gate]]", "[[  The Second Gate  ]]"]);
    await settled();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolution.read("[[The Second Gate]]")).toEqual({ state: "resolved", document: found });
  });

  it("calls a target nothing matched unresolved, which is a normal state", async () => {
    const resolution = createLinkResolution();
    resolution.registerResolver(async () => null);

    resolution.request(["[[Chapter 400]]"]);
    await settled();

    expect(resolution.read("[[Chapter 400]]")).toEqual({ state: "unresolved", document: null });
  });

  it("never asks about a link that leaves the app", async () => {
    const resolve = vi.fn(async () => found);
    const resolution = createLinkResolution();
    resolution.registerResolver(resolve);

    resolution.request(["https://example.com"]);
    await settled();

    expect(resolve).not.toHaveBeenCalled();
    expect(resolution.read("https://example.com")).toBeNull();
  });

  it("caches nothing for a question that could not be asked", async () => {
    const resolution = createLinkResolution();
    resolution.registerResolver(async () => {
      throw new Error("no base document URI yet");
    });

    resolution.request(["./cast.md"]);
    await settled();

    // Not "unresolved": the project never said this document is missing.
    expect(resolution.read("./cast.md")).toBeNull();
  });

  it("retries a failure when the writer clicks, because they asked again", async () => {
    const resolve = vi
      .fn<() => Promise<ResolvedDocumentLink | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(found);
    const resolution = createLinkResolution();
    resolution.registerResolver(resolve);

    resolution.request(["[[The Second Gate]]"]);
    await settled();

    await expect(resolution.resolve("[[The Second Gate]]")).resolves.toEqual({
      state: "resolved",
      document: found,
    });
  });

  it("publishes once an answer lands, so a renderer can redraw without an edit", async () => {
    const listener = vi.fn();
    const resolution = createLinkResolution();
    resolution.registerResolver(async () => found);
    resolution.subscribe(listener);

    resolution.request(["[[The Second Gate]]"]);
    const afterAsking = listener.mock.calls.length;
    await settled();

    expect(afterAsking).toBe(1);
    expect(listener.mock.calls.length).toBeGreaterThan(afterAsking);
  });
});

describe("what a re-registration retires", () => {
  it("drops every answer the last catalog produced", async () => {
    const resolution = createLinkResolution();
    resolution.registerResolver(async () => found);
    resolution.request(["[[The Second Gate]]"]);
    await settled();

    resolution.registerResolver(async () => null);

    expect(resolution.read("[[The Second Gate]]")).toBeNull();
  });

  it("answers a waiter from a retired generation with null rather than a stale fact", async () => {
    let release: (document: ResolvedDocumentLink | null) => void = () => {};
    const resolution = createLinkResolution();
    resolution.registerResolver(
      () =>
        new Promise<ResolvedDocumentLink | null>((done) => {
          release = done;
        }),
    );

    const waiting = resolution.resolve("[[The Second Gate]]");
    resolution.registerResolver(async () => null);
    release(found);

    await expect(waiting).resolves.toBeNull();
  });
});
