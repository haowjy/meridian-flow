/** Small independent notice/binding fixtures shared with non-loop tests. */
import type { Notice, NoticePort } from "../../../notices/index.js";
import type { AgentRevisionStore } from "../../../packages/index.js";
/** Loop fixtures name their bound threads; newly created children remain unbound. */
export function createTestAgentBinding(
  model: string,
  systemPrompt = "",
  boundThreads: () => readonly string[] = () => [],
): Pick<
  AgentRevisionStore,
  "readThreadBinding" | "listInstallations" | "readSource" | "readRevision" | "recordInvokedSkill"
> {
  return {
    async readThreadBinding(threadId) {
      if (!boundThreads().includes(threadId)) return undefined;
      return {
        revision: {
          id: "fixture-definition",
          packageRevisionId: "fixture-source",
          slug: "general",
          definitionDigest: "fixture-digest",
          definition: {
            schemaVersion: 1,
            systemPrompt,
            metadata: { model },
          },
        },
        configuration: {
          model,
          skills: { load: [], available: [] },
          namedTargets: [],
          permission: "edit",
        },
        invocationOverlay: null,
        invokedSkills: {},
      };
    },
    async listInstallations() {
      return [];
    },
    async readSource() {
      return undefined;
    },
    async readRevision() {
      return undefined;
    },
    async recordInvokedSkill(threadId) {
      return boundThreads().includes(threadId);
    },
  };
}

export function createTestNoticePort(initial: Notice[] = []): NoticePort & { rows: Notice[] } {
  const rows = [...initial];
  let nextId = Math.max(0, ...rows.map(({ id }) => id)) + 1;
  return {
    rows,
    async record(input) {
      const notice = { ...input, id: nextId++, createdAt: new Date() };
      rows.push(notice);
    },
    async peek(threadId) {
      return rows.filter((notice) => notice.scope.threadId === threadId);
    },
    async consume(ids) {
      const consumed = new Set(ids);
      for (const notice of rows.filter((notice) => consumed.has(notice.id)))
        rows.splice(rows.indexOf(notice), 1);
    },
  };
}
