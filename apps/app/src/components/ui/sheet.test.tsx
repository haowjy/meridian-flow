// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";

describe("Sheet accessibility contract", () => {
  it("exposes the visible title as the modal dialog name", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <Sheet defaultOpen>
          <SheetContent>
            <SheetTitle>Change work for this chat</SheetTitle>
            <SheetDescription>Currently Jade Path</SheetDescription>
          </SheetContent>
        </Sheet>,
      );
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe("Change work for this chat");
    await act(async () => root.unmount());
    host.remove();
  });
});
