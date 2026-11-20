import { plural, t } from "@lingui/core/macro";
import type { AgentFileChange, AgentPackageStatus } from "@meridian/contracts/agents";
import { FileDiff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { useAgentFileDocument } from "./agent-file-document";
import { FindingsChip } from "./FindingsChip";
import type { PackageRef } from "./package-save";
import { SavedDiffDialog } from "./SavedDiffDialog";

/**
 * A package's files added, changed or deleted since its last save, as a chip that lists them;
 * each opens its text against the saved version. `word` is the chip's word where there is room
 * for one ("Unsaved"); without it the chip is the count.
 */
export function PackageChanges({
  projectId,
  pkg,
  status,
  word,
}: {
  projectId: string;
  pkg: PackageRef;
  status: AgentPackageStatus;
  word?: ReactNode;
}) {
  const [opened, setOpened] = useState<AgentFileChange | null>(null);
  const documentOf = useAgentFileDocument(projectId);
  const { changes } = status;
  if (changes.length === 0) return null;
  const count =
    status.state === "not-saved"
      ? plural(changes.length, {
          one: "# new file, never saved",
          other: "# new files, never saved",
        })
      : plural(changes.length, {
          one: "# file changed since the last save",
          other: "# files changed since the last save",
        });
  return (
    <>
      <FindingsChip
        tone="neutral"
        word={
          word ?? (
            <>
              <FileDiff aria-hidden className="size-3" />
              <span className="tabular-nums">{changes.length}</span>
            </>
          )
        }
        label={word ? undefined : count}
        heading={count}
      >
        {(close) => (
          <ul className="flex max-h-80 flex-col overflow-y-auto">
            {changes.map((change) => (
              <li key={change.path}>
                <button
                  type="button"
                  className="focus-ring flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-ink-fill coarse:min-h-11 coarse:items-center"
                  onClick={() => {
                    close();
                    setOpened(change);
                  }}
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-foreground",
                      change.change === "deleted" && "line-through",
                    )}
                  >
                    {change.path}
                  </span>
                  <ChangeWord change={change.change} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </FindingsChip>
      <SavedDiffDialog
        projectId={projectId}
        pkg={pkg}
        saveId={status.saveId}
        change={opened}
        documentId={opened ? documentOf(pkg.level, opened.path) : null}
        onClose={() => setOpened(null)}
      />
    </>
  );
}

function ChangeWord({ change }: { change: AgentFileChange["change"] }) {
  const [word, tone] =
    change === "added"
      ? [t`added`, "text-jade-text"]
      : change === "deleted"
        ? [t`deleted`, "text-destructive"]
        : [t`changed`, "text-muted-foreground"];
  return <span className={cn("shrink-0", tone)}>{word}</span>;
}
