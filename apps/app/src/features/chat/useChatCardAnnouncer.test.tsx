// @vitest-environment jsdom
/** The one card announcer: each key once when watched, cleared when the card ends. */
import type { ChatCard } from "@meridian/thread-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { announceError, clearAnnouncement, useAnnouncement } from "@/client/stores";
import { useChatCardAnnouncer } from "./useChatCardAnnouncer";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  plural: (_count: number, forms: { one: string }) => forms.one,
}));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const card = (key: string, copy: ChatCard["copy"]): ChatCard => ({
  key,
  copy,
  failure: { category: "reply", source: "bug", actionable: true, cause: { code: "x" } },
  action: null,
  anchor: { turn: key },
  count: 1,
  text: null,
  requestId: null,
});

let alert = "";
function Probe(props: { cards: ChatCard[]; settled: boolean }) {
  useChatCardAnnouncer("t", props.cards, props.settled);
  alert = useAnnouncement().current.assertive;
  return null;
}

async function mount() {
  const root = createRoot(document.createElement("div"));
  const show = async (cards: ChatCard[], settled = true) => {
    await act(async () => root.render(<Probe cards={cards} settled={settled} />));
    await act(async () => {});
  };
  return { show, unmount: () => act(async () => root.unmount()) };
}

describe("useChatCardAnnouncer", () => {
  it("announces a card it watched appear, and takes the alert down when the card ends", async () => {
    // Risk: a "Couldn't stop the reply." alert staying in the page after its card went.
    const view = await mount();
    await view.show([]);
    await view.show([card("s:1", "stop-failed")]);
    expect(alert).toBe("Couldn't stop the reply.");
    // The same occurrence in new words (the Stop's reply ended): the region never keeps the old ones.
    await view.show([card("s:1", "hand-back-failed")]);
    expect(alert).toBe("Couldn't move your queued message to the message box.");
    await view.show([]);
    expect(alert).toBe("");
    // An unrelated alert is left alone when another card ends.
    await view.show([card("f", "reply-failed")]);
    await act(async () => announceError("Something else."));
    await view.show([]);
    expect(alert).toBe("Something else.");
    // The store is a module singleton: leave no alert for the next case.
    await act(async () => {
      announceError("", { key: "end" });
      clearAnnouncement("end");
    });
    await view.unmount();
  });

  it("stays silent for a card first seen when the history settled, as after a reload", async () => {
    // Risk (F1): re-announcing a failure on every reload.
    const view = await mount();
    await view.show([card("f", "reply-failed")], false);
    await view.show([card("f", "reply-failed")]);
    expect(alert).toBe("");
    await view.unmount();
  });
});
