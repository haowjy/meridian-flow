// @vitest-environment jsdom
/** A finished reply's action row: Info shows only with Stats for nerds on. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  plural: (_value: number, forms: { other: string }) => forms.other,
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { locale: "en", _: (message: string) => message } }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { changeStatsForNerds } from "@/lib/stats-for-nerds";
import { AssistantTurnActions } from "./AssistantTurnActions";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  changeStatsForNerds(false);
});

const reply = {
  id: "reply",
  role: "assistant",
  status: "complete",
  blocks: [],
  responses: [{ sequence: 0, model: "mock", inputTokens: 10, outputTokens: 10 }],
} as unknown as Turn;

async function render() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AssistantTurnActions
          threadId="thread"
          turn={reply}
          responseParts={[reply]}
          threadUsage={null}
          markdown="The gate opens."
        />
      </TooltipProvider>,
    ),
  );
}

const info = () => host.querySelector('button[aria-label="Turn information"]');

describe("AssistantTurnActions", () => {
  it("offers no Turn information while Stats for nerds is off", async () => {
    await render();
    expect(host.querySelector('button[aria-label="Copy"]')).not.toBeNull();
    expect(info()).toBeNull();
  });

  it("offers Turn information once Stats for nerds is on, and hides it again when off", async () => {
    changeStatsForNerds(true);
    await render();
    expect(info()).not.toBeNull();
    await act(async () => changeStatsForNerds(false));
    expect(info()).toBeNull();
  });
});
