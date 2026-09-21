// @vitest-environment jsdom
/**
 * The status label is the only writer-facing rendering of `ThreadStatus`:
 * asleep, generating, and waiting each read as a single fact.
 */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThreadStatusLabel } from "./ThreadStatusLabel";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("ThreadStatusLabel", () => {
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
  });

  it("names asleep, generating, and waiting", async () => {
    await act(async () => root.render(<ThreadStatusLabel status={{ kind: "asleep" }} />));
    expect(host.textContent).toContain("Asleep");

    await act(async () =>
      root.render(
        <ThreadStatusLabel
          status={{ kind: "awake", phase: "generating", cancelRequested: false }}
        />,
      ),
    );
    expect(host.textContent).toContain("Generating");

    await act(async () =>
      root.render(
        <ThreadStatusLabel status={{ kind: "awake", phase: "waiting", cancelRequested: false }} />,
      ),
    );
    expect(host.textContent).toContain("Waiting");
  });
});
