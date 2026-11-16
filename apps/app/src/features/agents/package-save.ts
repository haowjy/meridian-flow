/**
 * What the writer's last Save or Undo of each Agent package did, said on every surface that shows
 * the package. The package's state is never kept here: it is the files query's. A word holds only
 * while the state it speaks of does (see `heldWord`).
 */
import {
  type AgentFinding,
  type AgentPackageStatus,
  type AgentsLevel,
  agentsFileOf,
  type SaveOutcome,
  shownFindings,
} from "@meridian/contracts/agents";
import { notifyManager, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { saveAgentPackages, undoAgentSave } from "@/client/api/agents-api";
import { invalidateAgentReads, latestAgentFiles } from "@/client/query/useAgentFiles";
import { useAccountId } from "@/features/project/context/account-feature-context";

export type PackageRef = { level: AgentsLevel; folder: string };

export type PackageWord =
  /** `settled` false: shown at once, before the server answers. */
  | { kind: "saved"; outcome: SaveOutcome; settled: boolean }
  | { kind: "failed"; outcome: SaveOutcome; settled: boolean }
  /**
   * New chats are back on the version before and its files are back, an edit made since kept.
   * `settled` false until the files have been read again. Shown only while the package reads
   * Unsaved: when it reads Saved, the saved state says it all.
   */
  | { kind: "undone"; settled: boolean }
  /** The request never got an answer: nothing changed. */
  | { kind: "unreached" };

type Entry = {
  word: PackageWord;
  /**
   * The package the word speaks of: as pressed, until a settled Save's or Undo's files are read
   * again; `null` while that read is outstanding, when the word holds whatever the files say.
   */
  basis: string | null;
  ref: PackageRef;
};

/** The package a level-relative path belongs to: an import's folder, or the level's own files. */
export function packageFolderOf(path: string): string {
  const [dir, name, ...rest] = path.split("/");
  return dir === "packages" && name && rest.length > 0 ? `packages/${name}/` : "";
}

/** The level's own files read `.agents/` and `~/.agents/`; an import its folder's name. */
export function packageLabel({ level, folder }: PackageRef): string {
  const root = level === "project" ? ".agents/" : "~/.agents/";
  return folder ? `${root}${folder}` : root;
}

export const importName = (folder: string) => folder.replace(/^packages\//, "").replace(/\/$/, "");

export const errorsOf = (findings: readonly AgentFinding[]) =>
  findings.filter((finding) => finding.severity === "error");

/**
 * The package-relative Agent and skill files with an Error, whose edit a Save does not use. Any
 * other Error (a broken `mars.toml`) fails the whole Save.
 */
export function itemsWithErrors(findings: readonly AgentFinding[]): string[] {
  return [
    ...new Set(
      errorsOf(findings)
        .map((finding) => finding.file)
        .filter((file) => agentsFileOf(file) !== null),
    ),
  ];
}

/** The Errors that leave nothing of the package readable (a broken `mars.toml`): its Save fails. */
export const packageErrorsOf = (findings: readonly AgentFinding[]) =>
  errorsOf(findings).filter((finding) => agentsFileOf(finding.file) === null);

export const failsSave = (status: AgentPackageStatus) =>
  status.state === "cant-save" || packageErrorsOf(status.findings).length > 0;

export const statusOf = (
  packages: readonly AgentPackageStatus[] | undefined,
  { level, folder }: PackageRef,
) => packages?.find((item) => item.level === level && item.folder === folder);

const signature = (status: AgentPackageStatus | undefined) =>
  status
    ? JSON.stringify([status.state, status.saveId, status.changes, status.findings])
    : "missing";

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revision = 0;

function publish() {
  revision++;
  for (const listener of listeners) listener();
}

/**
 * Publishes a change made from a read of the files query only after that read has reached the
 * components (the notify batch runs first): published at once, a word whose basis is the new read
 * met the old files for a frame and dropped.
 */
const publishWithRead = (change: () => void) =>
  new Promise<void>((resolve) =>
    notifyManager.schedule(() => {
      change();
      publish();
      resolve();
    }),
  );

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The writer's own level is the same in every project; a project's only in its own.
const keyOf = (projectId: string, { level, folder }: PackageRef) =>
  `${level === "user" ? "" : projectId}|${level}|${folder}`;

function set(projectId: string, entry: Entry) {
  entries.set(keyOf(projectId, entry.ref), entry);
}

/**
 * The word a package shows now: until the package changes from what the word speaks of. A
 * settled Save's or Undo's basis is the package as the files read after it, so typing after it,
 * or putting a file back by hand, reads as a change; a failure's is the package as pressed.
 */
function heldWord(entry: Entry, status: AgentPackageStatus | undefined): PackageWord | null {
  const { word, basis } = entry;
  if (!status) return word;
  const unchanged = signature(status) === basis;
  switch (word.kind) {
    case "saved":
      return !word.settled || basis === null || unchanged ? word : null;
    case "failed":
      return !word.settled || unchanged ? word : null;
    case "undone":
      return !word.settled || (unchanged && status.state !== "saved") ? word : null;
    case "unreached":
      return unchanged ? word : null;
  }
}

/**
 * What a Save of these files will answer, said before it does: a package-level Error fails it;
 * an Agent or skill file with an Error is not used, its errors listed first. Whether that item
 * keeps an earlier saved version is the server's to say, so the prediction holds none; what is
 * shown of it (the count of what is out of use) is read from the files, so it does not wait.
 */
function predicted(status: AgentPackageStatus): PackageWord {
  const errors = errorsOf(status.findings);
  const fails = failsSave(status);
  const leftOut = fails ? [] : itemsWithErrors(status.findings);
  // A Save whose every change is to an item it holds back saves nothing new.
  const held = (path: string) =>
    leftOut.some((item) => {
      const file = `${status.folder}${item}`;
      const skill = agentsFileOf(item)?.kind === "skill" ? file.replace(/SKILL\.md$/, "") : null;
      return path === file || (skill !== null && path.startsWith(skill));
    });
  const nothingNew = !fails && status.changes.every((change) => held(change.path));
  const outcome: SaveOutcome = {
    level: status.level,
    folder: status.folder,
    outcome: fails ? "failed" : nothingNew ? "unchanged" : "saved",
    changes: status.changes,
    findings: fails
      ? errors
      : [
          ...errors,
          ...shownFindings(status.findings).filter((finding) => finding.severity !== "error"),
        ],
    kept: [],
    leftOut,
    renamed: [],
    savedBefore: status.savedAt !== null,
  };
  return fails
    ? { kind: "failed", outcome, settled: false }
    : { kind: "saved", outcome, settled: false };
}

async function save(
  queryClient: QueryClient,
  accountId: string,
  projectId: string,
  statuses: readonly AgentPackageStatus[],
) {
  if (statuses.length === 0) return;
  const bases = new Map<string, Entry>();
  for (const status of statuses) {
    const ref = { level: status.level, folder: status.folder };
    const entry: Entry = {
      word: predicted(status),
      basis: signature(status),
      ref,
    };
    bases.set(keyOf(projectId, ref), entry);
    set(projectId, entry);
  }
  publish();
  try {
    const outcomes = await saveAgentPackages(
      projectId,
      statuses.map(({ level, folder }) => ({ level, folder })),
    );
    for (const outcome of outcomes) {
      const ref = { level: outcome.level, folder: outcome.folder };
      const key = keyOf(projectId, ref);
      const before = bases.get(key);
      // A Save with nothing new still says which edits it kept out of use.
      if (outcome.outcome === "unchanged" && outcome.kept.length + outcome.leftOut.length === 0) {
        entries.delete(key);
        continue;
      }
      // A failed Save changed nothing, so it speaks of the package as pressed; a Save, of the
      // package as the read after it finds it.
      set(projectId, {
        ref,
        basis: outcome.outcome === "failed" ? (before?.basis ?? null) : null,
        word:
          outcome.outcome === "failed"
            ? { kind: "failed", outcome, settled: true }
            : { kind: "saved", outcome, settled: true },
      });
      bases.delete(key);
    }
    // A package the server had nothing to say of had nothing to save.
    for (const key of bases.keys()) entries.delete(key);
  } catch {
    for (const entry of bases.values()) set(projectId, { ...entry, word: { kind: "unreached" } });
    publish();
    void invalidateAgentReads(queryClient, projectId, accountId);
    return;
  }
  publish();
  await invalidateAgentReads(queryClient, projectId, accountId);
  // A Save's word speaks of the package as the Save left it, read once the files are read again.
  const after = latestAgentFiles(queryClient, projectId)?.packages;
  await publishWithRead(() => {
    for (const status of statuses) {
      const ref = { level: status.level, folder: status.folder };
      const entry = entries.get(keyOf(projectId, ref));
      if (entry?.word.kind !== "saved" || !entry.word.settled) continue;
      set(projectId, { ...entry, basis: signature(statusOf(after, ref)) });
    }
  });
}

const undoStates = new Map<string, "failed" | "pending">();

async function undo(
  queryClient: QueryClient,
  accountId: string,
  projectId: string,
  ref: PackageRef,
  saveId: string,
) {
  const key = keyOf(projectId, ref);
  const held = entries.get(key);
  const holds = held?.word.kind === "saved" && held.word.outcome.saveId === saveId ? held : null;
  const mark = (state: "failed" | "pending") => {
    undoStates.set(saveId, state);
    publish();
  };
  mark("pending");
  try {
    const { undone } = await undoAgentSave(projectId, ref.level, saveId);
    if (undone) {
      set(projectId, { ref, basis: null, word: { kind: "undone", settled: false } });
    } else if (holds) {
      entries.delete(key);
    }
    await invalidateAgentReads(queryClient, projectId, accountId);
    // The word speaks of the package as Undo left it: its files may read Saved or Unsaved now.
    if (undone && entries.get(key)?.word.kind === "undone") {
      const after = statusOf(latestAgentFiles(queryClient, projectId)?.packages, ref);
      await publishWithRead(() =>
        set(projectId, {
          ref,
          basis: signature(after),
          word: { kind: "undone", settled: true },
        }),
      );
    }
    undoStates.delete(saveId);
    publish();
  } catch {
    mark("failed");
  }
}

/** Saves and Undoes, with what they said; every caller of one package shares the same word. */
export function usePackageSaves(projectId: string) {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const seen = useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision,
  );
  return {
    /** Changes with every Save and Undo: a memo of what these answer keys on it. */
    revision: seen,
    wordOf: (ref: PackageRef, status: AgentPackageStatus | undefined) => {
      const entry = entries.get(keyOf(projectId, ref));
      return entry ? heldWord(entry, status) : null;
    },
    /** Whether `PackageSave` has anything to say of the package. */
    shows: (ref: PackageRef, status: AgentPackageStatus | undefined) => {
      const entry = entries.get(keyOf(projectId, ref));
      return Boolean(
        (entry && heldWord(entry, status)) ||
          status?.undoable ||
          (status && status.state !== "saved"),
      );
    },
    save: (statuses: readonly AgentPackageStatus[]) =>
      save(queryClient, accountId, projectId, statuses),
    undo: (ref: PackageRef, saveId: string) => undo(queryClient, accountId, projectId, ref, saveId),
    /** Only requests in flight and failed requests awaiting retry live here. */
    undoOf: (saveId: string) => undoStates.get(saveId),
  };
}
