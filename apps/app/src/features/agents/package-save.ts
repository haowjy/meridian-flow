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
  | { kind: "saved"; outcome: SaveOutcome; settled: boolean }
  | { kind: "failed"; outcome: SaveOutcome; settled: boolean }
  | { kind: "undone"; settled: boolean }
  | { kind: "unreached" };

type Entry = {
  word: PackageWord;
  basis: string | null;
  ref: PackageRef;
};

export function packageFolderOf(path: string): string {
  const [dir, name, ...rest] = path.split("/");
  return dir === "packages" && name && rest.length > 0 ? `packages/${name}/` : "";
}

export function packageLabel({ level, folder }: PackageRef): string {
  const root = level === "project" ? ".agents/" : "~/.agents/";
  return folder ? `${root}${folder}` : root;
}

export const importName = (folder: string) => folder.replace(/^packages\//, "").replace(/\/$/, "");

export const errorsOf = (findings: readonly AgentFinding[]) =>
  findings.filter((finding) => finding.severity === "error");

export function itemsWithErrors(findings: readonly AgentFinding[]): string[] {
  return [
    ...new Set(
      errorsOf(findings)
        .map((finding) => finding.file)
        .filter((file) => agentsFileOf(file) !== null),
    ),
  ];
}

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

const keyOf = (projectId: string, { level, folder }: PackageRef) =>
  `${level === "user" ? "" : projectId}|${level}|${folder}`;

function set(projectId: string, entry: Entry) {
  entries.set(keyOf(projectId, entry.ref), entry);
}

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

function predicted(status: AgentPackageStatus): PackageWord {
  const errors = errorsOf(status.findings);
  const fails = failsSave(status);
  const leftOut = fails ? [] : itemsWithErrors(status.findings);
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
      if (outcome.outcome === "unchanged" && outcome.kept.length + outcome.leftOut.length === 0) {
        entries.delete(key);
        continue;
      }
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
    for (const key of bases.keys()) entries.delete(key);
  } catch {
    for (const entry of bases.values()) set(projectId, { ...entry, word: { kind: "unreached" } });
    publish();
    void invalidateAgentReads(queryClient, projectId, accountId);
    return;
  }
  publish();
  await invalidateAgentReads(queryClient, projectId, accountId);
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

export function usePackageSaves(projectId: string) {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const seen = useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision,
  );
  return {
    revision: seen,
    wordOf: (ref: PackageRef, status: AgentPackageStatus | undefined) => {
      const entry = entries.get(keyOf(projectId, ref));
      return entry ? heldWord(entry, status) : null;
    },
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
    undoOf: (saveId: string) => undoStates.get(saveId),
  };
}
