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
 *
 * ProseMirror is not the only place a key arrives. A layer whose content Radix
 * portals out of the editor holds focus for as long as it is open, and the
 * editor's own `handleKeyDown` never runs for it — so a contribution says how
 * far it reaches (`KeymapReach`) and the kernel listens on the document for the
 * ones that reach past the prose. That is the seam a surface extends instead of
 * adding a document listener of its own, which would be invisible to scope,
 * precedence, and collision validation alike.
 */

import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import type { ChromeContext } from "./chrome-context";

/**
 * Deepest owner first, and each scope names a context it is only live in.
 *
 * A scope is not a priority number with a friendly name: `keymapScopeApplies`
 * enforces it, so a table verb is unreachable with the caret in a paragraph
 * whether or not its lane remembered to check. That is the deepest-owner seam
 * the design promises — if scope were only an ordering, every lane would
 * rediscover its own guard and one missed check would shadow an outer verb
 * across the whole document.
 *
 * A contribution that could sit at two scopes belongs at the deeper one: the
 * cost of losing a key you should have won is a writer pressing something
 * twice, and the cost of winning one you should have lost is a writer who
 * cannot reach the outer verb at all.
 */
export const KEYMAP_SCOPE_ORDER = ["layer", "object", "table", "block", "document"] as const;

export type KeymapScope = (typeof KEYMAP_SCOPE_ORDER)[number];

/** What the kernel knows when a key arrives. */
export type KeymapApplicability = {
  context: ChromeContext;
  /** Transient surfaces open right now. */
  layerCount: number;
};

/**
 * Is a scope live in this state?
 *
 * `block` and `document` are both always live; they differ only in who wins
 * when they collide. Everything above them names a context the writer has to
 * be standing in.
 */
export function keymapScopeApplies(scope: KeymapScope, state: KeymapApplicability): boolean {
  switch (scope) {
    case "layer":
      return state.layerCount > 0;
    case "object":
      return state.context.owner === "object";
    case "table":
      return state.context.chain.includes("table");
    case "block":
    case "document":
      return true;
  }
}

/**
 * How far from the manuscript a keystroke may be for a contribution to hear it.
 *
 * - **`prose`** is ProseMirror's own reach, and the default: the caret is in the
 *   manuscript and the editor's `handleKeyDown` runs the ladder.
 * - **`chrome`** also hears keys pressed while focus sits outside the editor's
 *   DOM, which is where a portalled layer's content puts it. The kernel's
 *   document listener serves those.
 *
 * Only a `layer`-scoped contribution may reach that far, and the registration
 * validator enforces it: a layer's registration lives exactly as long as the
 * surface is open, while an object- or document-scoped binding heard from
 * anywhere would fire on keys the writer typed into the chat composer.
 */
export type KeymapReach = "prose" | "chrome";

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
  /** Where the key may be pressed. `"prose"` when unsaid. */
  reach?: KeymapReach;
  /**
   * Narrows further than the scope, for a contribution that applies to one
   * kind of the scope's context — one object type, one table role. The scope
   * is checked first, so this only ever sees a context the scope admitted.
   */
  appliesTo?: (context: ChromeContext) => boolean;
  /** Keys in ProseMirror's `keymap` spelling: `"Alt-ArrowUp"`, `"Mod-Enter"`. */
  bindings: Readonly<Record<string, KeymapBinding>>;
};

export function keymapContributionApplies(
  contribution: KeymapContribution,
  state: KeymapApplicability,
): boolean {
  if (!keymapScopeApplies(contribution.scope, state)) return false;
  return contribution.appliesTo?.(state.context) ?? true;
}

/**
 * Refuse a contribution the kernel cannot honour, at registration time.
 *
 * Two refusals. `Escape` belongs to the Esc chain (`escStep`), which is a
 * policy about the whole editor rather than a key a surface can own; a surface
 * that wants a step in that walk registers a layer instead. And `chrome` reach
 * belongs to `layer` scope, because that scope's registrations end when the
 * surface does — a binding at any other scope, live wherever focus happens to
 * be, would answer keys the writer typed into the chat composer.
 *
 * Throwing HERE rather than during the merge is the whole point: the stack
 * still names the lane that wrote the binding, and the registry has not been
 * touched, so the refusal costs the offending lane its registration and costs
 * every other lane nothing. Validating late once cost every later registration
 * silently — a guard against silent rejection failing into silent rejection.
 */
export function assertKeymapContribution(contribution: KeymapContribution): void {
  if ("Escape" in contribution.bindings) {
    throw new Error(
      `Keymap contribution "${contribution.id}" bound Escape; the Esc chain owns it — register a chrome layer instead`,
    );
  }
  if (contribution.reach === "chrome" && contribution.scope !== "layer") {
    throw new Error(
      `Keymap contribution "${contribution.id}" asked for chrome reach at "${contribution.scope}" scope; only a layer's keys may outlive the prose's focus`,
    );
  }
}

/**
 * Flatten registered contributions into one ProseMirror keymap. Each key runs
 * its scope ladder in order and stops at the first binding that consumes it,
 * so a contribution that declines (returns false) hands the key down rather
 * than swallowing it — the difference between "not now" and "never again".
 *
 * `reach` says where the keystroke will come from: the prose hears every
 * contribution, while focus parked in portalled chrome hears only the ones that
 * said they reach that far.
 *
 * Applicability is read per keystroke rather than baked in, because the merge
 * is cached across keystrokes and the writer's context is not.
 */
export function mergeKeymapContributions(
  contributions: readonly KeymapContribution[],
  applicability: () => KeymapApplicability,
  reach: KeymapReach = "prose",
): Record<string, KeymapBinding> {
  const byKey = new Map<string, KeymapBinding[]>();

  for (const scope of KEYMAP_SCOPE_ORDER) {
    for (const contribution of contributions) {
      if (contribution.scope !== scope) continue;
      if (reach === "chrome" && contribution.reach !== "chrome") continue;
      for (const [key, binding] of Object.entries(contribution.bindings)) {
        const scoped: KeymapBinding = (state, dispatch, view) =>
          keymapContributionApplies(contribution, applicability()) &&
          binding(state, dispatch, view);
        const bindings = byKey.get(key);
        if (bindings) bindings.push(scoped);
        else byKey.set(key, [scoped]);
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
