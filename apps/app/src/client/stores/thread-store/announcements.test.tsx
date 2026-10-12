// @vitest-environment jsdom
/** Keyed alert ownership, including announcements still queued for publication. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { announceError, clearAnnouncement, useAnnouncement } from "./announcements";

it("clears only the owning alert and cancels its queued publication", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  function Region() {
    return <div role="alert">{useAnnouncement().current.assertive}</div>;
  }
  try {
    await act(async () => root.render(<Region />));
    await act(async () => announceError("First failed", { key: "first" }));
    expect(host.textContent).toBe("First failed");
    await act(async () => announceError("Second failed", { key: "second" }));
    await act(async () => clearAnnouncement("first"));
    expect(host.textContent).toBe("Second failed");
    await act(async () => clearAnnouncement("second"));
    expect(host.textContent).toBe("");
    await act(async () => {
      announceError("Queued failure", { key: "first" });
      clearAnnouncement("first");
    });
    expect(host.textContent).toBe("");
    await act(async () => {
      announceError("Old failure", { key: "first" });
      announceError("Unrelated failure");
      clearAnnouncement("first");
    });
    expect(host.textContent).toBe("Unrelated failure");
  } finally {
    await act(async () => root.unmount());
  }
});
