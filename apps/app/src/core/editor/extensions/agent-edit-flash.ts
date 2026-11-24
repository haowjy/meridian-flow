import { remoteAuthors } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findBlock } from "../loro-points";

/** How long the text an agent wrote stays highlighted, fading, after its write lands. */
const FLASH_MS = 1800;

/** The flashes showing, and when the newest began, which schedules its expiry. */
type Flashes = { set: DecorationSet; latest: number };

const key = new PluginKey<Flashes>("agentEditFlash");
const EXPIRE = "expire";

/**
 * The text a chat's turn wrote in a peer's batch, as ranges of `tr.doc`: in each block whose text
 * doc the batch's commits name a turn as author (`remoteAuthors`), the span that differs from
 * before, or the whole block when the batch made it.
 */
function agentRanges(tr: Transaction): { from: number; to: number }[] {
  const authors = remoteAuthors(tr);
  if (!authors) return [];
  const ranges: { from: number; to: number }[] = [];
  for (const [id, by] of authors) {
    if (!("turn" in by)) continue;
    const after = findBlock(tr.doc, id);
    if (!after?.node.isTextblock) continue;
    const start = after.pos + 1;
    const before = findBlock(tr.before, id);
    if (!before) {
      ranges.push({ from: start, to: start + after.node.content.size });
      continue;
    }
    const from = before.node.content.findDiffStart(after.node.content);
    const end = before.node.content.findDiffEnd(after.node.content);
    if (from === null || !end) continue;
    ranges.push({ from: start + from, to: start + Math.max(from, end.b) });
  }
  return ranges.filter((range) => range.from < range.to);
}

/**
 * A brief highlight, in the agent colour, over the text a chat's write brings into the editor: in
 * Live, and in a draft where a Draft chat writes. Who wrote a batch comes from its commits, never
 * from timing. Decoration only: the writer's view, caret and typing are untouched, and the
 * highlight rides the writer's edits until it expires.
 */
export const AgentEditFlash = Extension.create({
  name: "agentEditFlash",
  addProseMirrorPlugins() {
    return [
      new Plugin<Flashes>({
        key,
        state: {
          init: () => ({ set: DecorationSet.empty, latest: 0 }),
          apply(tr, value) {
            let set = tr.docChanged ? value.set.map(tr.mapping, tr.doc) : value.set;
            if (tr.getMeta(key) === EXPIRE) {
              const cutoff = Date.now() - FLASH_MS;
              set = set.remove(set.find(undefined, undefined, (spec) => spec.at <= cutoff));
            }
            const ranges = agentRanges(tr);
            if (ranges.length === 0)
              return set === value.set ? value : { set, latest: value.latest };
            const at = Date.now();
            const flashes = ranges.map(({ from, to }) =>
              Decoration.inline(
                from,
                to,
                { class: "meridian-agent-flash", style: `--agent-flash-ms: ${FLASH_MS}ms` },
                { at },
              ),
            );
            return { set: set.add(tr.doc, flashes), latest: at };
          },
        },
        props: { decorations: (state) => key.getState(state)?.set },
        view(view) {
          const timers = new Set<ReturnType<typeof setTimeout>>();
          const expire = (delay: number) => {
            const timer = setTimeout(() => {
              timers.delete(timer);
              if (view.isDestroyed) return;
              // Redrawing the paragraph an IME is composing in breaks the composition.
              if (view.composing) return expire(300);
              view.dispatch(view.state.tr.setMeta(key, EXPIRE).setMeta("addToHistory", false));
            }, delay);
            timers.add(timer);
          };
          return {
            update(_view, previous) {
              const latest = key.getState(view.state)?.latest;
              if (latest !== key.getState(previous)?.latest) expire(FLASH_MS);
            },
            destroy() {
              for (const timer of timers) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
