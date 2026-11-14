import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import { RowWord } from "@/components/app/RowWord";
import {
  endTreeNotice,
  type Said,
  subscribeTreeNotices,
  type TreeNotice,
  type TreeStep,
  treeNotice,
  treeNoticeRevision,
} from "@/core/project-tree/tree-undo";
import { useAccountId } from "./account-feature-context";
import { useEntryActions } from "./entry-drag/entry-actions";

export type TreeNoticeWords = {
  /** The word a node's row shows now, or null. */
  word: (node: string) => ReactNode;
  /** The node is gone (deleted, or restored out of Trash) and its row stays struck through. */
  held: (node: string, gone: "delete" | "restore") => boolean;
  /** The writer acted elsewhere in the sidebar's trees: their notices end. */
  end: () => void;
};

/**
 * What the project's and the account's lists say on their rows (`TreeNotice`): the writer's
 * latest gesture with its Undo, the same step Ctrl+Z takes, or what a press skipped or couldn't
 * take back. Read once per pane; each row asks for its own word.
 */
export function useTreeNoticeWords(projectId: string): TreeNoticeWords {
  const accountId = useAccountId();
  const project = useTreeList({ kind: "project", projectId }).session;
  const account = useTreeList({ kind: "account", userId: accountId }).session;
  const actions = useEntryActions(projectId);
  const revision = useSyncExternalStore(
    subscribeTreeNotices,
    treeNoticeRevision,
    treeNoticeRevision,
  );
  const end = useCallback(() => {
    for (const session of [project, account]) if (session) endTreeNotice(session);
  }, [project, account]);
  return useMemo(() => {
    void revision;
    const shown = [
      { notice: treeNotice(project), list: actions.project },
      { notice: treeNotice(account), list: actions.account },
    ].filter((each): each is { notice: TreeNotice; list: typeof actions.project } =>
      Boolean(each.notice),
    );
    return {
      end,
      held: (node, gone) =>
        shown.some(
          ({ notice }) =>
            notice.kind === "step" &&
            notice.step.gesture === gone &&
            notice.step.nodes.includes(node),
        ),
      word: (node) => {
        for (const { notice, list } of shown) {
          if (notice.kind === "step") {
            if (!notice.step.nodes.includes(node)) continue;
            const { step } = notice;
            return (
              <RowWord
                word={<Trans>Undo</Trans>}
                label={undoLabel(step, node)}
                sentence={stepSentence(step, node)}
                onAction={() => void list.undo(step)}
              />
            );
          }
          const said = notice.said.find((each) => each.nodes.includes(node));
          if (said) return <SaidWord said={said} onRetry={(step) => void list.undo(step)} />;
        }
        return null;
      },
    };
  }, [revision, project, account, actions, end]);
}

function undoLabel(step: TreeStep, node: string): string {
  const name = step.was.get(node)?.name ?? "";
  switch (step.gesture) {
    case "delete":
      return t`Undo delete of ${name}`;
    case "rename":
      return t`Undo rename of ${name}`;
    case "move":
      return t`Undo move of ${name}`;
    case "restore":
      return t`Undo restore of ${name}`;
    case "create":
      return t`Undo`;
  }
}

function stepSentence(step: TreeStep, node: string): string {
  const count = step.nodes.length;
  const was = step.was.get(node);
  switch (step.gesture) {
    case "delete":
      return count > 1
        ? t`Deleted ${count} items just now. Undo puts them back.`
        : t`Deleted just now. Undo puts it back.`;
    case "rename": {
      const name = was?.name ?? "";
      return t`Renamed from ${name} just now. Undo puts the old name back.`;
    }
    case "move": {
      if (count > 1) return t`Moved ${count} items just now. Undo puts them back.`;
      const folder = was?.folder;
      return folder
        ? t`Moved from ${folder} just now. Undo puts it back.`
        : t`Moved just now. Undo puts it back.`;
    }
    case "restore":
      return count > 1
        ? t`Restored ${count} items from Trash just now. Undo puts them back in Trash.`
        : t`Restored from Trash just now. Undo puts it back in Trash.`;
    case "create":
      return "";
  }
}

/** What a press has to say on a row: a step it skipped, or an Apply it couldn't fully take back. */
function SaidWord({
  said,
  onRetry,
}: {
  said: Said;
  onRetry: (step: Extract<Said, { kind: "failed" }>["step"]) => void;
}) {
  const { name } = said;
  switch (said.kind) {
    case "skipped":
      return (
        <RowWord
          tone="warning"
          word={<Trans>Skipped</Trans>}
          sentence={
            said.of === "apply"
              ? t`Undo skipped applying ${name}: the tree changed since.`
              : t`Undo skipped your change to ${name}: it was changed again since.`
          }
        />
      );
    case "partial": {
      const stayed = plural(said.textLeft, {
        one: "# text change stayed: it was edited since.",
        other: "# text changes stayed: they were edited since.",
      });
      return (
        <RowWord
          tone="warning"
          word={<Trans>Partly undone</Trans>}
          sentence={`${t`Undid applying ${name}.`} ${stayed}`}
        />
      );
    }
    case "failed":
      return (
        <RowWord
          tone="warning"
          word={<Trans>Retry</Trans>}
          label={t`Retry undoing applying ${name}`}
          sentence={t`Couldn't undo applying ${name}. Retry tries again.`}
          onAction={() => onRetry(said.step)}
        />
      );
  }
}
