import {
  SIMPLE_TEXT_TURN_AGUI,
  SIMPLE_TEXT_TURN_ORCHESTRATOR,
  SIMPLE_TOOL_TURN_AGUI,
  SIMPLE_TOOL_TURN_ORCHESTRATOR,
} from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

import { projectOrchestratorEvents } from "../../../threads/index.js";

describe("orchestrator event projector (golden)", () => {
  it("projects simple text turn to the canonical AG-UI stream", () => {
    expect(projectOrchestratorEvents(SIMPLE_TEXT_TURN_ORCHESTRATOR)).toEqual(SIMPLE_TEXT_TURN_AGUI);
  });

  it("projects simple tool turn to the canonical AG-UI stream", () => {
    expect(projectOrchestratorEvents(SIMPLE_TOOL_TURN_ORCHESTRATOR)).toEqual(SIMPLE_TOOL_TURN_AGUI);
  });
});
