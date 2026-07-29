/**
 * The editor's keymap seam: where a surface contributes keys, and who wins
 * when two want the same one.
 *
 * TipTap resolves key conflicts by extension priority — a number, decided once
 * at construction, invisible from the surface that loses. This turns that into
 * data: a contribution names its scope, the scopes are an ordered list, and
 * the deepest owner is tried first (law 4). A surface open right now beats the
 * object under it, which beats the table around it, which beats the document.
 *
 * Above all of it sits `UndoRedoKeymapExtension` at TipTap priority 1100,
 * which is not part of this ladder and must not be: undo is the writer's
 * recovery over LLM writes (ruling 17), so no contribution can shadow it.
 * The kernel mounts at priority 1050 — under undo, over everything else.
 *
 * Contributions register at runtime, which is the point: a slash menu needs
 * the arrow keys only while it is open, and an extension priority cannot say
 * "only while open".
 */

import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Deepest owner first. A contribution that could sit at two scopes belongs at
 * the deeper one: the cost of losing a key you should have won is a writer
 * pressing something twice, and the cost of winning one you should have lost
 * is a writer who cannot reach the outer verb at all.
 */
export const KEYMAP_SCOPE_ORDER = ["layer", "object", "table", "block", "document"] as const;

export type KeymapScope = (typeof KEYMAP_SCOPE_ORDER)[number];

/** ProseMirror's own binding shape: return true to consume the key. */
export type KeymapBinding = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView,
) => boolean;

export type KeymapContribution = {
  /** The registering surface, e.g. `"slash-menu"`. Names the owner in a trace. */
  id: string;
  scope: KeymapScope;
  /** Keys in ProseMirror's `keymap` spelling: `"Alt-ArrowUp"`, `"Mod-Enter"`. */
  bindings: Readonly<Record<string, KeymapBinding>>;
};

/**
 * Refuse a contribution the kernel cannot honour, at registration time.
 *
 * `Escape` is the one refusal. It belongs to the Esc chain (`escStep`), which
 * is a policy about the whole editor rather than a key a surface can own; a
 * surface that wants a step in that walk registers a layer instead.
 *
 * Throwing HERE rather than during the merge is the whole point: the stack
 * still names the lane that wrote the binding, and the registry has not been
 * touched, so the refusal costs the offending lane its registration and costs
 * every other lane nothing. Validating late once cost every later registration
 * silently — a guard against silent rejection failing into silent rejection.
 */
export function assertKeymapContribution(contribution: KeymapContribution): void {
  if (!("Escape" in contribution.bindings)) return;
  throw new Error(
    `Keymap contribution "${contribution.id}" bound Escape; the Esc chain owns it — register a chrome layer instead`,
  );
}

/**
 * Flatten registered contributions into one ProseMirror keymap. Each key runs
 * its scope ladder in order and stops at the first binding that consumes it,
 * so a contribution that declines (returns false) hands the key down rather
 * than swallowing it — the difference between "not now" and "never again".
 */
export function mergeKeymapContributions(
  contributions: readonly KeymapContribution[],
): Record<string, KeymapBinding> {
  const byKey = new Map<string, KeymapBinding[]>();

  for (const scope of KEYMAP_SCOPE_ORDER) {
    for (const contribution of contributions) {
      if (contribution.scope !== scope) continue;
      for (const [key, binding] of Object.entries(contribution.bindings)) {
        const bindings = byKey.get(key);
        if (bindings) bindings.push(binding);
        else byKey.set(key, [binding]);
      }
    }
  }

  return Object.fromEntries(
    [...byKey].map(([key, bindings]) => [
      key,
      (state, dispatch, view) => bindings.some((binding) => binding(state, dispatch, view)),
    ]),
  );
}
