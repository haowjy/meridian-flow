import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from "react";
import { useTreeList } from "@/client/query/useProjectTree";
import { type GoneRow, RowWord } from "@/components/app/RowWord";
import {
  type Bounce,
  endTreeNotice,
  subscribeTreeNotices,
  type TreeStep,
  treeBounces,
  treeNotice,
  treeNoticeRevision,
  type Was,
} from "@/core/project-tree/tree-undo";
import type { TreeView } from "@/core/project-tree/tree-view";
import { useShellTreeVersion } from "../tree-version";
import { useAccountId } from "./account-feature-context";
import { useEntryActions } from "./entry-drag/entry-actions";

export type TreeNoticeWords = {
  /**
   * The word a drawn row shows now, or null. On a row the writer's delete or restore just took
   * (`gone`), its Undo takes the focus the row had.
   */
  word: (node: string, gone?: boolean) => ReactNode;
  /**
   * The rows gone from under `parent` (a folder's or a source's id) that still say something: the
   * latest delete's, and the creates the server bounced, where the writer made them.
   */
  deleted: (parent: string) => GoneRow<Was>[];
  /** The node was restored out of Trash by the latest gesture: its Trash row stays, struck through. */
  restored: (node: string) => boolean;
  /** What has no row drawn to say it on, for the list's heading. */
  header: ReactNode;
  /** The writer acted elsewhere in the sidebar's trees: their notices end. */
  end: () => void;
};

/** Where a list draws a node's row, so a word whose row isn't drawn goes to one that is. */
export type NoticePlace = {
  /** The list has a row for it, drawn or under a closed folder: a source's id counts. */
  holds: (node: string) => boolean;
  /** The folder or source it is listed under; null in a flat list. */
  parent: (node: string) => string | null;
  /** The folder's rows are drawn: always so for a source's top. */
  open: (folder: string) => boolean;
};

/** A source's tree as a place: its rows are drawn while every folder above them is open. */
export function treePlace(tree: TreeView, isExpanded: (folder: string) => boolean): NoticePlace {
  const root = tree.root.entryId;
  return {
    holds: (node) => node === root || tree.entry(node) !== null,
    parent: (node) => (node === root ? null : (tree.entry(node)?.parentId ?? null)),
    open: (folder) => folder === root || isExpanded(folder),
  };
}

/** A list that holds no tree rows. */
export const NOWHERE: NoticePlace = { holds: () => false, parent: () => null, open: () => false };

/** A word the writer's own delete or restore just made takes the focus, once per step. */
const focused = new WeakSet<TreeStep>();

/** The drawn row of a tree or Trash node: where focus goes when an Undo brings it back. */
export const entryRowOf = (node: string) =>
  document.querySelector<HTMLElement>(
    `[data-entry-key="file:${CSS.escape(node)}"], [data-entry-key="folder:${CSS.escape(node)}"]`,
  );

/**
 * What the project's and the account's lists say on a list's rows (`TreeNotice`): the writer's
 * latest gesture with its Undo, the same step Ctrl+Z takes, or what a press or a row's Undo
 * skipped or couldn't take back. A word goes on its row when the list draws it, else on the
 * nearest drawn folder above it, else on the list's heading; a list that doesn't hold the node
 * says nothing. A change the server bounced (`treeBounces`) says so on its own row while the list
 * draws it, and nowhere else; on a row with two words the bounce, which came later, wins. Read
 * once per list.
 */
export function useTreeNoticeWords(projectId: string, place: NoticePlace): TreeNoticeWords {
  const accountId = useAccountId();
  const project = useTreeList({ kind: "project", projectId }).session;
  const account = useTreeList({ kind: "account", userId: accountId }).session;
  const actions = useEntryActions(projectId);
  const workName = useShellTreeVersion()?.name ?? null;
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
    ].flatMap(({ notice, list }) => (notice ? [{ notice, list }] : []));
    const steps = shown.flatMap(({ notice, list }) =>
      notice.kind === "step" ? [{ step: notice.step, list }] : [],
    );
    const bounced = [project, account].flatMap((session) => treeBounces(session));
    // A row the latest delete took, or a create the server bounced, stays drawn, struck through,
    // where it was.
    const gone = new Map<string, Was>();
    for (const { step } of steps)
      if (step.gesture === "delete")
        for (const node of step.nodes) {
          const was = step.was.get(node);
          if (was) gone.set(node, was);
        }
    for (const { record, made } of bounced) if (made) gone.set(record.node, made);
    const parentOf = (node: string) =>
      place.holds(node) ? place.parent(node) : (gone.get(node)?.parent ?? null);
    const holds = (node: string): boolean => {
      if (place.holds(node)) return true;
      const was = gone.get(node);
      return was !== undefined && place.holds(was.parent);
    };
    const drawn = (node: string): boolean => {
      for (let at = node, hops = 0; hops < 1000; hops += 1) {
        const above = parentOf(at);
        if (above === null) return holds(at);
        if (!place.open(above)) return false;
        at = above;
      }
      return false;
    };
    const words = new Map<string, (gone: boolean) => ReactNode>();
    let header: ReactNode = null;
    // Each word on its own drawn rows, or the nearest drawn folder above the first, or the heading.
    const put = (nodes: readonly string[], word: (node: string, gone: boolean) => ReactNode) => {
      const own = nodes.filter((node) => holds(node) && drawn(node));
      for (const node of own) if (!words.has(node)) words.set(node, (gone) => word(node, gone));
      const first = nodes.find(holds);
      if (own.length > 0 || first === undefined) return;
      let above = parentOf(first);
      while (above !== null && !drawn(above)) above = parentOf(above);
      if (above !== null && place.parent(above) !== null && !words.has(above))
        words.set(above, () => word(first, false));
      else header ??= word(first, false);
    };
    // The latest bounce of a node speaks for it, before any other word.
    for (const bounce of [...bounced].reverse())
      if (holds(bounce.record.node) && drawn(bounce.record.node) && !words.has(bounce.record.node))
        words.set(bounce.record.node, () => (
          <BounceWord key={bounce.record.node} bounce={bounce} work={workName} />
        ));
    for (const { step, list } of steps) {
      const takes = step.gesture === "delete" || step.gesture === "restore";
      put(step.nodes, (node, gone) => (
        <RowWord
          key={node}
          word={<Trans>Undo</Trans>}
          label={undoLabel(step, node)}
          sentence={stepSentence(step, node)}
          onAction={() => void list.undo(step)}
          focus={
            takes && gone
              ? {
                  take: () => {
                    if (focused.has(step) || step.nodes[0] !== node) return false;
                    focused.add(step);
                    return true;
                  },
                  back: () => entryRowOf(node),
                }
              : undefined
          }
        />
      ));
    }
    return {
      end,
      header,
      word: (node, gone = false) => words.get(node)?.(gone) ?? null,
      deleted: (parent) =>
        [...gone].flatMap(([node, was]) =>
          was.parent === parent ? [{ key: node, row: was, after: was.after }] : [],
        ),
      restored: (node) =>
        steps.some(({ step }) => step.gesture === "restore" && step.nodes.includes(node)),
    };
  }, [revision, project, account, actions, end, place, workName]);
}

/**
 * What a bounced change says: what didn't happen ("Not created", "Not renamed", "Not moved", "Not
 * deleted"), why, and the Copy it offers when the writer typed something it can hand back (a
 * created document's text, a rename's name). `work` is the Work that was closed, when the shell
 * knows it. A row's word and a not-created document's tab say it the same.
 */
export function bounceSaying(
  bounce: Bounce,
  work: string | null,
): {
  word: ReactNode;
  sentence: string;
  copy: { word: ReactNode; label: string; take: () => void } | null;
} {
  const closed = work ? t`${work} was closed.` : t`The Work was closed.`;
  const { record, typed } = bounce;
  if (typed) {
    const created = record.type === "create";
    const lead = created ? t`Not created:` : t`Not renamed:`;
    const takes = created ? t`Copy takes what you typed.` : t`Copy takes the name you typed.`;
    const word = <Trans>Copy</Trans>;
    return {
      word,
      sentence: `${lead} ${closed} ${takes}`,
      copy: {
        word,
        label: created ? t`Copy what you typed` : t`Copy the name you typed`,
        take: () => void navigator.clipboard.writeText(typed),
      },
    };
  }
  return {
    word:
      record.type === "create" ? (
        <Trans>Not created</Trans>
      ) : record.type === "move" ? (
        <Trans>Not moved</Trans>
      ) : record.type === "delete" ? (
        <Trans>Not deleted</Trans>
      ) : record.type === "restore" ? (
        <Trans>Not restored</Trans>
      ) : (
        <Trans>Not renamed</Trans>
      ),
    sentence: closed,
    copy: null,
  };
}

function BounceWord({ bounce, work }: { bounce: Bounce; work: string | null }) {
  const { word, sentence, copy } = bounceSaying(bounce, work);
  return copy ? (
    <RowWord word={copy.word} label={copy.label} sentence={sentence} onAction={copy.take} />
  ) : (
    <RowWord tone="warning" word={word} sentence={sentence} />
  );
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
