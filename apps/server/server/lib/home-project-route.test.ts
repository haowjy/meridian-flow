/**
 * Home project route tests: last-active preference, personal fallback, and 404 when absent.
 */
import { randomUUID } from "node:crypto";
import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type {
  ProjectBootstrapRepository,
  ProjectRepository,
  UserRepository,
} from "../domains/projects/index.js";
import { handleGetHomeProjectRequest } from "./home-project-route.js";

function project(overrides: Partial<Project> & Pick<Project, "id" | "userId">): Project {
  const now = new Date().toISOString();
  return {
    title: "My Serial",
    name: "My Serial",
    slug: "my-serial",
    description: null,
    systemPrompt: null,
    isPersonal: true,
    settings: {},
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function harness(options: {
  userId: UserId;
  lastActiveProjectId?: ProjectId | null;
  personalProjectId?: ProjectId | null;
  projectsById?: Record<string, Project | null>;
}) {
  const users: UserRepository = {
    async ensureUser() {
      return options.userId;
    },
    async getLastActiveProjectId() {
      return options.lastActiveProjectId ?? null;
    },
    async setLastActiveProjectId() {},
  };

  const projects: ProjectBootstrapRepository = {
    async findPersonalProjectId() {
      return options.personalProjectId ?? null;
    },
    async ensureDefaultBootstrap() {
      throw new Error("not used in home route tests");
    },
  };

  const projectRepo: ProjectRepository = {
    async findById(id) {
      return options.projectsById?.[id] ?? null;
    },
    async create() {
      throw new Error("not implemented");
    },
    async listByUser() {
      return [];
    },
    async search() {
      return [];
    },
    async update() {
      throw new Error("not implemented");
    },
    async softDelete() {
      throw new Error("not implemented");
    },
    async restore() {
      throw new Error("not implemented");
    },
    async touch() {},
  };

  return { users, projects, projectRepo };
}

describe("handleGetHomeProjectRequest", () => {
  const userId = randomUUID() as UserId;

  it("returns last-active project when owned and not deleted", async () => {
    const projectId = randomUUID() as ProjectId;
    const deps = harness({
      userId,
      lastActiveProjectId: projectId,
      personalProjectId: randomUUID() as ProjectId,
      projectsById: {
        [projectId]: project({ id: projectId, userId }),
      },
    });

    await expect(handleGetHomeProjectRequest(deps, userId)).resolves.toEqual({ projectId });
  });

  it("falls back to personal project when last-active is missing", async () => {
    const personalProjectId = randomUUID() as ProjectId;
    const deps = harness({
      userId,
      lastActiveProjectId: null,
      personalProjectId,
    });

    await expect(handleGetHomeProjectRequest(deps, userId)).resolves.toEqual({
      projectId: personalProjectId,
    });
  });

  it("falls back to personal project when last-active is deleted", async () => {
    const deletedId = randomUUID() as ProjectId;
    const personalProjectId = randomUUID() as ProjectId;
    const deps = harness({
      userId,
      lastActiveProjectId: deletedId,
      personalProjectId,
      projectsById: {
        [deletedId]: project({ id: deletedId, userId, deletedAt: new Date().toISOString() }),
      },
    });

    await expect(handleGetHomeProjectRequest(deps, userId)).resolves.toEqual({
      projectId: personalProjectId,
    });
  });

  it("returns 404 when no project exists", async () => {
    const deps = harness({ userId, personalProjectId: null });

    await expect(handleGetHomeProjectRequest(deps, userId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
