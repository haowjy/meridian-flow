// @ts-nocheck

import type { OnboardingState } from "@meridian/contracts";
import type { UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createOnboardingService, shouldRouteToOnboarding } from "./index.js";

const userId = "00000000-0000-4000-8000-000000000001" as UserId;

function serviceHarness(initialState: OnboardingState = {}, projectCount = 0) {
  let state = initialState;
  let created = 0;
  const service = createOnboardingService({
    users: {
      async ensureUser() {
        return userId;
      },
      async getOnboardingState() {
        return state;
      },
      async updateOnboardingState(_userId, next) {
        state = next;
        return state;
      },
    },
    projectRepo: {
      async create() {
        throw new Error("not used");
      },
      async findById() {
        return null;
      },
      async listByUser() {
        return Array.from({ length: projectCount }, (_, index) => ({ id: `project-${index}` }));
      },
      async search() {
        return [];
      },
      async update() {
        throw new Error("not used");
      },
      async softDelete() {
        throw new Error("not used");
      },
      async restore() {
        throw new Error("not used");
      },
      async touch() {},
    },
    projects: {
      async ensureDefaultBootstrap() {
        throw new Error("not used");
      },
      async createOnboardingBootstrap() {
        created += 1;
        return {
          projectId: "00000000-0000-4000-8000-000000000101",
          workId: "00000000-0000-4000-8000-000000000102",
          threadId: "00000000-0000-4000-8000-000000000103",
          documentId: "00000000-0000-4000-8000-000000000104",
          contextSourceId: "00000000-0000-4000-8000-000000000105",
          agentDefinitionId: "00000000-0000-4000-8000-000000000106",
          uri: "work://manuscript/chapter-1.md",
        };
      },
    },
  });
  return { service, created: () => created, state: () => state };
}

describe("onboarding service", () => {
  it("routes empty new users and in-progress users, but not completed users", () => {
    expect(shouldRouteToOnboarding({}, 0)).toBe(true);
    expect(shouldRouteToOnboarding({}, 1)).toBe(false);
    expect(shouldRouteToOnboarding({ status: "in_progress" }, 1)).toBe(true);
    expect(shouldRouteToOnboarding({ status: "completed" }, 0)).toBe(false);
  });

  it("persists progress and creates the setup project thread once", async () => {
    const harness = serviceHarness();

    const first = await harness.service.saveProgress(userId, {
      stepId: "basics",
      answers: { projectName: "Cradle of Stars", writingType: "progression fantasy" },
    });
    const second = await harness.service.saveProgress(userId, {
      stepId: "goals",
      answers: { writingGoal: "Royal Road launch" },
    });

    expect(harness.created()).toBe(1);
    expect(second.state.status).toBe("in_progress");
    expect(second.state.answers).toMatchObject({
      projectName: "Cradle of Stars",
      writingType: "progression fantasy",
      writingGoal: "Royal Road launch",
    });
    expect(first.state.firstThreadId).toBe(second.state.firstThreadId);
  });

  it("completes with the onboarding-created project and thread", async () => {
    const harness = serviceHarness({ status: "in_progress", answers: { projectName: "Saga" } });

    const result = await harness.service.complete(userId, { path: "start_chatting" });

    expect(result.projectId).toBe("00000000-0000-4000-8000-000000000101");
    expect(result.threadId).toBe("00000000-0000-4000-8000-000000000103");
    expect(result.state.status).toBe("completed");
    expect(result.state.selectedPath).toBe("start_chatting");
  });
});
