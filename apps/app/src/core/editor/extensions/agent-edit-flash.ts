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
 * doc took nothing but that turn's write (`remoteAuthors`), the span that differs from before, or
 * the whole block when the batch made it.
 */
function agentRanges(tr: Transaction): { from: number; to: number }[] {
  const authors = remoteAuthors(tr);
  if (!authors) return [];
  const ranges: { from: number; to: number }[] = [];
  for (const id of authors.keys()) {
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
 * The highlight over [from, to) of a write that landed at `at`, its fade `now - at` along: a span
 * the editor redraws (the writer typing inside it) resumes the fade instead of restarting it.
 */
function flash(from: number, to: number, at: number, now: number): Decoration {
  const style = `--agent-flash-ms: ${FLASH_MS}ms; animation-delay: ${at - now}ms`;
  return Decoration.inline(from, to, { class: "meridian-agent-flash", style }, { at });
}

/** `set` with each flash's fade delay brought up to now, after an edit may redraw its span. */
function resumed(set: DecorationSet, doc: Transaction["doc"]): DecorationSet {
  const shown = set.find();
  if (shown.length === 0) return set;
  const now = Date.now();
  return DecorationSet.create(
    doc,
    shown.map((each) => flash(each.from, each.to, each.spec.at, now)),
  );
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
            let set = tr.docChanged
              ? resumed(value.set.map(tr.mapping, tr.doc), tr.doc)
              : value.set;
            if (tr.getMeta(key) === EXPIRE) {
              const cutoff = Date.now() - FLASH_MS;
              set = set.remove(set.find(undefined, undefined, (spec) => spec.at <= cutoff));
            }
            const ranges = agentRanges(tr);
            if (ranges.length === 0)
              return set === value.set ? value : { set, latest: value.latest };
            const at = Date.now();
            const flashes = ranges.map(({ from, to }) => flash(from, to, at, at));
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
