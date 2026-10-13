// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useChatFollowScroll } from "./useChatFollowScroll";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let release: (() => void) | undefined;
function Transcript({ contentHeight }: { contentHeight: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { releaseFollow } = useChatFollowScroll({ scrollRef: ref, contentHeight });
  release = releaseFollow;
  return <div ref={ref} data-viewport />;
}

describe("useChatFollowScroll", () => {
  it("stops pinning to the bottom once follow is released", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Transcript contentHeight={500} />));
    const viewport = host.querySelector<HTMLElement>("[data-viewport]");
    expect(viewport?.scrollTop).toBe(500);

    await act(async () => release?.());
    await act(async () => root.render(<Transcript contentHeight={800} />));
    expect(viewport?.scrollTop).toBe(500);
    await act(async () => root.unmount());
    host.remove();
  });
});
