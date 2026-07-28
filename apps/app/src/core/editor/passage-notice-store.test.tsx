/** The stale-passage notice outlives whichever document is on screen. */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  dismissPassageNotice,
  reportPassageChanged,
  usePassageNotice,
} from "./passage-notice-store";

/** Reads the notice the way the pane does: through a mounted subscriber. */
function Owed({ documentId, seen }: { documentId: string | null; seen: boolean[] }) {
  seen.push(usePassageNotice(documentId));
  return null;
}

async function showing(documentId: string | null, during?: () => void): Promise<boolean> {
  const seen: boolean[] = [];
  await withReactRoot(<Owed documentId={documentId} seen={seen} />, async () => {
    if (during) await act(async () => during());
  });
  return seen[seen.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  dismissPassageNotice();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("passage notice", () => {
  it("is owed to one document, not to whatever is on screen", async () => {
    reportPassageChanged("chapter-2");

    expect(await showing("chapter-2")).toBe(true);
    expect(await showing("chapter-3")).toBe(false);
    expect(await showing(null)).toBe(false);
  });

  it("expires on its own while its document is nowhere on screen", async () => {
    reportPassageChanged("chapter-2");
    // Nobody renders chapter-2 across this window. The notice must still go,
    // or coming back to that document later greets the writer with a
    // complaint about a search they have long forgotten.
    vi.advanceTimersByTime(7_000);

    expect(await showing("chapter-2")).toBe(false);
  });

  it("lets a newer notice outlive the older one's expiry", async () => {
    reportPassageChanged("chapter-2");
    vi.advanceTimersByTime(6_000);
    reportPassageChanged("chapter-3");
    vi.advanceTimersByTime(2_000);

    expect(await showing("chapter-3")).toBe(true);
    expect(await showing("chapter-2")).toBe(false);
  });

  it("goes when a superseding navigation says so", async () => {
    reportPassageChanged("chapter-2");

    expect(await showing("chapter-2", () => dismissPassageNotice())).toBe(false);
  });
});
