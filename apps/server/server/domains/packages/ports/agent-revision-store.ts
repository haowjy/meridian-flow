/** Immutable Agent content a chat is bound to. Callers own resource authorization. */
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

/** Whose package a Save is: an account's `~/.agents/` or a project's `.agents/`. */
export type SaveOwner = { userId: string } | { projectId: string };

/** One Save of one package. */
export interface PackageSave {
  id: string;
  /** `""` for the level's own files, `packages/<name>/` for an import. */
  folder: string;
  /** The saved version's files; null when the Save removed the package. */
  packageRevisionId: string | null;
  contentDigest: string | null;
  createdAt: Date;
  undoneSaveId: string | null;
  hasPrevious: boolean;
  savedBy: "writer" | "ai";
}

/** A package's latest Save, with every earlier Save of it that an Undo took back. */
export interface LatestSave extends PackageSave {
  undoneSaveIds: string[];
}

/** An available Agent as one reader version read it. The runtime never sees an unavailable one. */
export interface AgentRevision {
  id: string;
  packageRevisionId: string;
  slug: string;
  grammarVersion: string;
  definition: CompiledAgentDefinition;
}
/** One Agent file as one reader version read it: available (a definition) or unavailable (reasons). */
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
/** Retained per-thread binding; `revision` is null for an agent-less generic subagent. */
export interface AgentRevisionBinding {
  revision: AgentRevision | null;
  configuration: ResolvedAgentConfiguration;
  invocationOverlay: InvocationOverlay | null;
  /** Packaged skills the user invoked in this thread, by slug, pinned as read. */
  invokedSkills: Readonly<Record<string, RetainedSkillReference>>;
}
export interface AgentRevisionStore {
  /**
   * Compiles the files under `grammarVersion` (the running reader by default) and retains them
   * with their Agent rows, once per (coordinate, content digest, reader version). A Save row or a
   * chat's binding is what points at them.
   */
  installSource(
    source: AgentSourceSnapshot,
    grammarVersion?: string,
  ): Promise<{ packageRevisionId: string; definitions: CatalogRevision[] }>;
  /** Adds a Save row: `packageRevisionId` is the package's new saved version, null when removed. */
  savePackage(
    owner: SaveOwner,
    folder: string,
    packageRevisionId: string | null,
    metadata?: { savedBy?: "writer" | "ai"; undoneSaveId?: string },
  ): Promise<PackageSave>;
  /**
   * Settles one package's Save as one operation under its ordering: `decide` gets the package's
   * latest Save row (any, a removal included) and returns the result with, to publish, the new
   * saved version (null: removed). It runs and the row is added in one transaction, so what it
   * read is still the latest when its row lands. `row` is that row, absent when nothing is
   * published. `decide` must not wait on another Save of the same package.
   */
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
  /** Each package's latest Save of `owner`, one row per folder. */
  readSaved(owner: SaveOwner): Promise<LatestSave[]>;
  /**
   * Saves the version before `saveId` again, unless a later Save of that package exists, which
   * leaves everything as it is. `undone` is the Save that was undone, with the new row as
   * `current`. Undefined when `owner` has no such row. `restore` runs after the check and before
   * the row is added, under the package's one ordering and in the same transaction, with the
   * Save and the version before it (null: none); if it throws, nothing changed.
   */
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
  /**
   * The Agent revision, only when a Save of `userId`, or of `projectId` (which the caller has
   * authorized), points at its package: what an account may bind by id.
   */
  readSavedRevision(
    userId: string,
    projectId: string | undefined,
    id: string,
  ): Promise<CatalogRevision | undefined>;
  readSource(packageRevisionId: string): Promise<AgentSourceSnapshot | undefined>;
  /** By id, any reader version. Undefined for an unavailable Agent. */
  readRevision(id: string): Promise<AgentRevision | undefined>;
  /** By id, any reader version, available or not. */
  readCatalogRevision(id: string): Promise<CatalogRevision | undefined>;
  /** The available Agents of one file set, as read by `grammarVersion`. */
  readPackageDefinitions(
    packageRevisionId: string,
    grammarVersion: string,
  ): Promise<AgentRevision[]>;
  /** Every Agent of one file set, as read by `grammarVersion`. */
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
  /**
   * Moves a bound thread onto another revision with its resolved configuration, and re-pins the
   * given skills by slug. The invocation overlay, and a skill pinned since `skillPins` was read,
   * stay. False when the thread has no binding.
   */
  replaceThreadBinding(
    threadId: string,
    revisionId: string,
    configuration: ResolvedAgentConfiguration,
    skillPins: Readonly<Record<string, RetainedSkillReference>>,
  ): Promise<boolean>;
  /** Throws when the bound revision has no definition: null `revision` means the generic subagent. */
  readThreadBinding(threadId: string): Promise<AgentRevisionBinding | undefined>;
  /**
   * Pins a user-invoked skill on the thread's binding, replacing an earlier
   * pin of the same slug. False when the thread has no binding.
   */
  recordInvokedSkill(
    threadId: string,
    slug: string,
    reference: RetainedSkillReference,
  ): Promise<boolean>;
}
