/**
 * The quiet mark on text the writer's own action did not take away (design §1 and §2), so what
 * stays doesn't read as theirs or as a failure: a tint, and a tooltip and accessible description
 * that say why it is there. Two things put it on a paragraph:
 *
 * - a paragraph someone deleted while the caret was in it, kept while the caret stays (the binding's
 *   `kept`, "The caret rule");
 * - an edit Ctrl+Z or Ctrl+Shift+Z left in place because someone wrote over it since
 *   (`HistoryRun.kept`), briefly, naming who when their copy is here (`showKept`).
 */
import { t } from "@lingui/core/macro";
import { type KeptEdit, loroSyncKey } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { LocalPresenceFields } from "../local-presence";
import type { PeerUser } from "./peer-carets";

/** How long a stayed edit's mark shows. */
const STAYED_MS = 4_000;

/** Stayed edits shown now: each block's label, until `token` is cleared. */
type Stayed = { token: number; labels: ReadonlyMap<string, string> };
type KeptState = { stayed: Stayed | null; decorations: DecorationSet };
type KeptMeta = { stayed: Stayed | null } | { clear: number };

const keptKey = new PluginKey<KeptState>("kept");
let tokens = 0;

function markOf(pos: number, node: Node, label: string, stayed: boolean): Decoration {
  return Decoration.node(pos, pos + node.nodeSize, {
    class: stayed ? "meridian-kept meridian-kept-stayed" : "meridian-kept",
    title: label,
    "aria-description": label,
  });
}

function decorate(state: EditorState, stayed: Stayed | null): DecorationSet {
  const removed = loroSyncKey.getState(state)?.kept;
  if (!removed?.size && !stayed) return DecorationSet.empty;
  const removedLabel = t`Deleted while you were in it. It stays until you leave it.`;
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    const id = node.attrs.id;
    if (typeof id === "string") {
      if (removed?.has(id)) decorations.push(markOf(pos, node, removedLabel, false));
      else {
        const label = stayed?.labels.get(id);
        if (label) decorations.push(markOf(pos, node, label, true));
      }
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(state.doc, decorations);
}

/** Marks the edits an Undo or Redo left in place, briefly. */
export function showKept(view: EditorView, edits: readonly KeptEdit[]): void {
  if (view.isDestroyed || edits.length === 0) return;
  const nameOf = keptKey.get(view.state)?.spec.nameOf as NameOf | undefined;
  if (!nameOf) return;
  const labels = new Map<string, string>();
  for (const { blocks, by } of edits) {
    const name = by ? nameOf(by) : undefined;
    const label = name
      ? t`${name} wrote over this since. Undo left it as it is.`
      : t`Written over since. Undo left it as it is.`;
    for (const block of blocks) labels.set(block, label);
  }
  const token = ++tokens;
  view.dispatch(
    view.state.tr
      .setMeta(keptKey, { stayed: { token, labels } } satisfies KeptMeta)
      .setMeta("addToHistory", false),
  );
  setTimeout(() => {
    if (!view.isDestroyed)
      view.dispatch(
        view.state.tr
          .setMeta(keptKey, { clear: token } satisfies KeptMeta)
          .setMeta("addToHistory", false),
      );
  }, STAYED_MS);
}

type NameOf = (peer: string) => string | undefined;

export const KeptExtension = Extension.create<{ presence: LocalPresenceFields | null }>({
  name: "kept",
  addOptions: () => ({ presence: null }),
  addProseMirrorPlugins() {
    const { presence } = this.options;
    // A peer's copy here says who it is (`peer-carets.ts` publishes its user).
    const nameOf: NameOf = (peer) => {
      const user = presence?.peers.getStates().get(peer)?.user as PeerUser | undefined;
      return user?.name || undefined;
    };
    return [
      new Plugin<KeptState>({
        key: keptKey,
        nameOf,
        state: {
          init: (_config, state) => ({ stayed: null, decorations: decorate(state, null) }),
          apply(tr, prior, old, next) {
            const meta = tr.getMeta(keptKey) as KeptMeta | undefined;
            let stayed = prior.stayed;
            if (meta && "stayed" in meta) stayed = meta.stayed;
            else if (meta && "clear" in meta && stayed?.token === meta.clear) stayed = null;
            const removed = loroSyncKey.getState(next)?.kept;
            if (
              stayed === prior.stayed &&
              removed === loroSyncKey.getState(old)?.kept &&
              !tr.docChanged
            )
              return prior;
            return { stayed, decorations: decorate(next, stayed) };
          },
        },
        props: { decorations: (state) => keptKey.getState(state)?.decorations },
      }),
    ];
  },
});
