import type {
  InvocationOverlay,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import type {
  AgentSourceSnapshot,
  CompiledAgentDefinition,
  PackageDiagnostic,
} from "../domain/compile-package.js";

export type SaveOwner = { userId: string } | { projectId: string };

export interface PackageSave {
  id: string;
  folder: string;
  packageRevisionId: string | null;
  contentDigest: string | null;
  createdAt: Date;
  undoneSaveId: string | null;
  hasPrevious: boolean;
  savedBy: "writer" | "ai";
}

export interface LatestSave extends PackageSave {
  undoneSaveIds: string[];
}

export interface AgentRevision {
  id: string;
  packageRevisionId: string;
  slug: string;
  grammarVersion: string;
  definition: CompiledAgentDefinition;
}
export interface CatalogRevision {
  id: string;
  packageRevisionId: string;
  slug: string;
  grammarVersion: string;
  name: string;
  description: string;
  diagnostics: PackageDiagnostic[];
  definition: CompiledAgentDefinition | null;
}
export interface AgentRevisionBinding {
  revision: AgentRevision | null;
  configuration: ResolvedAgentConfiguration;
  invocationOverlay: InvocationOverlay | null;
  invokedSkills: Readonly<Record<string, RetainedSkillReference>>;
}
export interface AgentRevisionStore {
  installSource(
    source: AgentSourceSnapshot,
    grammarVersion?: string,
  ): Promise<{ packageRevisionId: string; definitions: CatalogRevision[] }>;
  savePackage(
    owner: SaveOwner,
    folder: string,
    packageRevisionId: string | null,
    metadata?: { savedBy?: "writer" | "ai"; undoneSaveId?: string },
  ): Promise<PackageSave>;
  settleSave<T>(
    owner: SaveOwner,
    folder: string,
    decide: (latest: PackageSave | undefined) => Promise<{
      value: T;
      publish?: {
        packageRevisionId: string | null;
        savedBy?: "writer" | "ai";
        undoneSaveId?: string;
      };
    }>,
  ): Promise<{ value: T; row?: PackageSave }>;
  readSaved(owner: SaveOwner): Promise<LatestSave[]>;
  undoSave(
    owner: SaveOwner,
    saveId: string,
    restore: (undone: PackageSave, target: PackageSave | null) => Promise<void>,
  ): Promise<
    | {
        current: PackageSave;
        undone: PackageSave | null;
        reason?: "already-undone" | "later-save" | "not-undoable";
      }
    | undefined
  >;
  readSavedRevision(
    userId: string,
    projectId: string | undefined,
    id: string,
  ): Promise<CatalogRevision | undefined>;
  readSource(packageRevisionId: string): Promise<AgentSourceSnapshot | undefined>;
  readRevision(id: string): Promise<AgentRevision | undefined>;
  readCatalogRevision(id: string): Promise<CatalogRevision | undefined>;
  readPackageDefinitions(
    packageRevisionId: string,
    grammarVersion: string,
  ): Promise<AgentRevision[]>;
  readPackageCatalogRevisions(
    packageRevisionId: string,
    grammarVersion: string,
  ): Promise<CatalogRevision[]>;
  bindThread(
    threadId: string,
    revisionId: string | null,
    configuration: ResolvedAgentConfiguration,
    invocationOverlay: InvocationOverlay | null,
  ): Promise<boolean>;
  replaceThreadBinding(
    threadId: string,
    revisionId: string,
    configuration: ResolvedAgentConfiguration,
    skillPins: Readonly<Record<string, RetainedSkillReference>>,
  ): Promise<boolean>;
  readThreadBinding(threadId: string): Promise<AgentRevisionBinding | undefined>;
  recordInvokedSkill(
    threadId: string,
    slug: string,
    reference: RetainedSkillReference,
  ): Promise<boolean>;
}
