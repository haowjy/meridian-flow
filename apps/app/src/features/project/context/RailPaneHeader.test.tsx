import { File } from "lucide-react";
import { act, useState } from "react";
import { describe, expect, it } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { RailPaneHeader } from "./RailPaneHeader";

describe("RailPaneHeader", () => {
  it("exposes Work identity on the focused control and preserves pane keys", async () => {
    let selectWork: ((name: string) => void) | null = null;
    function Harness() {
      const [expanded, setExpanded] = useState(true);
      const [workName, setWorkName] = useState("Revision A");
      selectWork = setWorkName;
      return (
        <RailPaneHeader
          label="Scratch"
          icon={File}
          ariaLabel={`Scratch for Work ${workName}`}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
      );
    }

    await withReactRoot(<Harness />, async () => {
      const control = paneButton();
      expect(control.getAttribute("aria-label")).toBe("Scratch for Work Revision A");
      control.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
      await act(async () => undefined);
      expect(control.getAttribute("aria-expanded")).toBe("false");

      control.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      await act(async () => undefined);
      expect(control.getAttribute("aria-expanded")).toBe("true");

      await act(async () => selectWork?.("Revision B"));
      expect(control.getAttribute("aria-label")).toBe("Scratch for Work Revision B");
    });
  });
});

function paneButton(): HTMLButtonElement {
  const button = document.querySelector("button[aria-expanded]");
  if (!(button instanceof window.HTMLButtonElement)) throw new Error("Missing pane control");
  return button;
}
