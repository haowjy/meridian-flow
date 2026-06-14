// @ts-nocheck
/**
 * tool-renderers.test — guards invoke skill-run failure classification against
 * the server-side gate strings in skill-tools.ts.
 */

import {
  INVOKE_SKILL_NO_LONGER_AVAILABLE_ERROR_PATTERN,
  INVOKE_UNKNOWN_SKILL_ERROR_PREFIX,
  invokeSkillNoLongerAvailableErrorPrefix,
  invokeUnknownSkillErrorPrefix,
} from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";

import { classifyInvokeSkillFailure, rendererFor } from "./tool-renderers";

describe("classifyInvokeSkillFailure", () => {
  it("recognizes unknown-skill gate output", () => {
    expect(
      classifyInvokeSkillFailure(
        `${invokeUnknownSkillErrorPrefix("segment")}. Available skills: analyze, segment`,
      ),
    ).toBe("unknown");
    expect(INVOKE_UNKNOWN_SKILL_ERROR_PREFIX).toBe('Unknown skill "');
  });

  it("recognizes demoted/deleted skill output", () => {
    expect(
      classifyInvokeSkillFailure(
        `${invokeSkillNoLongerAvailableErrorPrefix("segment")} Available skills: analyze`,
      ),
    ).toBe("no-longer-available");
    expect(
      INVOKE_SKILL_NO_LONGER_AVAILABLE_ERROR_PATTERN.test(
        invokeSkillNoLongerAvailableErrorPrefix("segment"),
      ),
    ).toBe(true);
  });

  it("returns null for non-freeze invoke failures", () => {
    expect(classifyInvokeSkillFailure("invoke requires skillname (string).")).toBeNull();
  });
});

describe("rendererFor", () => {
  it("registers a tier-2 invoke renderer with expand and title", () => {
    const renderer = rendererFor("invoke");
    const fallback = rendererFor("not-a-real-tool");
    expect(renderer).not.toBe(fallback);
    expect(renderer.expand).toBeTypeOf("function");
    expect(renderer.title).toBeTypeOf("function");
  });
});
