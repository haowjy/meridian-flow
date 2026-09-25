import { describe, expect, it } from "vitest";
import { editorDefaultWorkPending } from "./editor-default-work";

const ready = { workCatalogReady: true };

describe("editorDefaultWorkPending", () => {
  it("waits while the Work catalog itself is not ready, regardless of chat", () => {
    expect(
      editorDefaultWorkPending({
        workCatalogReady: false,
        chatThreadId: null,
        displayedChatFound: false,
        threadsFailed: false,
        threadsUnloaded: false,
      }),
    ).toBe(true);
  });

  it("resolves immediately with no current chat, even when the thread list failed", () => {
    // Regression: the Editor previously fell into the route error boundary on
    // /editor when there was nothing chat-related to wait for at all.
    expect(
      editorDefaultWorkPending({
        ...ready,
        chatThreadId: null,
        displayedChatFound: false,
        threadsFailed: true,
        threadsUnloaded: false,
      }),
    ).toBe(false);
  });

  it("resolves immediately with no current chat, even when the thread list never loaded", () => {
    expect(
      editorDefaultWorkPending({
        ...ready,
        chatThreadId: null,
        displayedChatFound: false,
        threadsFailed: false,
        threadsUnloaded: true,
      }),
    ).toBe(false);
  });

  it("waits for a current chat's thread list to load before resolving its Work", () => {
    // Regression: the Editor previously resolved to No Work immediately and
    // never adopted the chat's Work once the thread list finished loading.
    expect(
      editorDefaultWorkPending({
        ...ready,
        chatThreadId: "thread-a",
        displayedChatFound: false,
        threadsFailed: false,
        threadsUnloaded: true,
      }),
    ).toBe(true);
  });

  it("waits for a current chat's thread list when it errored", () => {
    expect(
      editorDefaultWorkPending({
        ...ready,
        chatThreadId: "thread-a",
        displayedChatFound: false,
        threadsFailed: true,
        threadsUnloaded: false,
      }),
    ).toBe(true);
  });

  it("resolves once the current chat is found in a loaded thread list", () => {
    expect(
      editorDefaultWorkPending({
        ...ready,
        chatThreadId: "thread-a",
        displayedChatFound: true,
        threadsFailed: false,
        threadsUnloaded: false,
      }),
    ).toBe(false);
  });

  it("resolves when the thread list loaded successfully but the chat is genuinely missing", () => {
    // A settled, non-erroring thread list without the chat is a real absence,
    // not a reason to keep waiting.
    expect(
      editorDefaultWorkPending({
        ...ready,
        chatThreadId: "thread-a",
        displayedChatFound: false,
        threadsFailed: false,
        threadsUnloaded: false,
      }),
    ).toBe(false);
  });
});
