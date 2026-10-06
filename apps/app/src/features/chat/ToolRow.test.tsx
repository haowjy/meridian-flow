// @vitest-environment jsdom

import type { JsonValue } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toolView } from "./report-test-fixtures";
import { ToolRow } from "./ToolRow";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function refusedWrite(status: string) {
  const result: JsonValue = {
    schema: "meridian.agent-edit.v1",
    command: "replace",
    status,
    path: "ch12.md",
    message: "You last read ch12.md live, but your writes now go to @x's draft.",
  };
  return {
    ...toolView({ toolCallId: "call-1", toolName: "write", result: null }),
    input: { command: "replace", path: "ch12.md", content: "The gate held." },
    result,
    isError: true,
  };
}

describe("ToolRow", () => {
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

  it("shows a write that must re-read first as a quiet step", async () => {
    await act(async () => root.render(<ToolRow tool={refusedWrite("read_required")} />));

    expect(host.textContent).toBe("Paused to rereadch12");
    expect(host.querySelector('[aria-label="Failed"]')).toBeNull();
    expect(host.querySelector("button[aria-expanded]")).toBeNull();
  });
});
