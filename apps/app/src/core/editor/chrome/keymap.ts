/** Defines scoped editor keymap registrations and dispatch. */

import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import type { ChromeContext } from "./chrome-context";
import type { ChromeLayer } from "./esc-chain";

/** Deepest owner first, and each scope names a context it is only live in. */
export const KEYMAP_SCOPE_ORDER = ["layer", "object", "table", "block", "document"] as const;

export type KeymapScope = (typeof KEYMAP_SCOPE_ORDER)[number];

/** What the kernel knows when a key arrives. */
export type KeymapApplicability = {
  context: ChromeContext;
  /** Transient surfaces open right now, shallowest first — `chrome.layers` itself. */
  layers: readonly ChromeLayer[];
};

/** Is a scope live in this state? */
export function keymapScopeApplies(scope: KeymapScope, state: KeymapApplicability): boolean {
  switch (scope) {
    case "layer":
      return state.layers.length > 0;
    case "object":
      return state.context.owner === "object";
    case "table":
      return state.context.chain.includes("table");
    case "block":
    case "document":
      return true;
  }
}

/** How far from the manuscript a keystroke may be for a contribution to hear it. */
export type KeymapReach = "prose" | "chrome";

/** ProseMirror's own binding shape: return true to consume the key. */
export type KeymapBinding = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView,
) => boolean;

type KeymapContributionBase = {
  /** The registering surface, e.g. `"slash-menu"`. Names the owner in a trace. */
  id: string;
  /** Where the key may be pressed. `"prose"` when unsaid. */
  reach?: KeymapReach;
  /** Narrows further than the scope, for a contribution that applies to one kind of the scope's context — one object type, one table role. */
  appliesTo?: (context: ChromeContext) => boolean;
  /** Keys in ProseMirror's `keymap` spelling: `"Alt-ArrowUp"`, `"Mod-Enter"`. */
  bindings: Readonly<Record<string, KeymapBinding>>;
};

export type KeymapContribution = KeymapContributionBase &
  (
    | {
        scope: "layer";
        /** The open layer these keys belong to, as `openLayer` handed it back. */
        layer: ChromeLayer | null;
      }
    | { scope: Exclude<KeymapScope, "layer">; layer?: never }
  );

export function keymapContributionApplies(
  contribution: KeymapContribution,
  state: KeymapApplicability,
): boolean {
  // A suggestion lease is live before React mounts its visual layer. Named
  // layers still require their exact token; this exception ends with the lease.
  const pending = contribution.scope === "layer" && contribution.layer === null;
  if (!pending && !keymapScopeApplies(contribution.scope, state)) return false;
  // A layer's keys are live exactly while that layer is. A token missing from
  // the list is a surface already out of the walk home, and its keys go with it.
  if (contribution.layer && !state.layers.includes(contribution.layer)) return false;
  return contribution.appliesTo?.(state.context) ?? true;
}

/** Refuse a contribution the kernel cannot honour, at registration time. */
export function assertKeymapContribution(
  contribution: KeymapContribution,
  registered: readonly KeymapContribution[] = [],
): void {
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
  if (contribution.appliesTo) return;

  for (const other of registered) {
    if (other.appliesTo || !sameKeymapPlace(contribution, other)) continue;
    const collision = Object.keys(contribution.bindings).find((key) => key in other.bindings);
    if (collision === undefined) continue;
    throw new Error(
      `Keymap contribution "${contribution.id}" bound ${collision} at "${contribution.scope}" scope, where "${other.id}" already has it; narrow one with appliesTo, or take a deeper scope`,
    );
  }
}

/** Do these two contributions answer for the same place, so a shared key would always be a collision? */
function sameKeymapPlace(left: KeymapContribution, right: KeymapContribution): boolean {
  if (left.scope !== right.scope) return false;
  if (left.scope !== "layer") return true;
  return left.layer !== null && left.layer === right.layer;
}

/** A registered binding, still paired with the contribution that answers for it. */
type KeymapRung = {
  contribution: KeymapContribution;
  binding: KeymapBinding;
};

/** Flatten registered contributions into one ProseMirror keymap. */
export function mergeKeymapContributions(
  contributions: readonly KeymapContribution[],
  applicability: () => KeymapApplicability,
  reach: KeymapReach = "prose",
): Record<string, KeymapBinding> {
  const byKey = new Map<string, KeymapRung[]>();

  for (const scope of KEYMAP_SCOPE_ORDER) {
    for (const contribution of contributions) {
      if (contribution.scope !== scope) continue;
      if (reach === "chrome" && contribution.reach !== "chrome") continue;
      for (const [key, binding] of Object.entries(contribution.bindings)) {
        const rungs = byKey.get(key);
        if (rungs) rungs.push({ contribution, binding });
        else byKey.set(key, [{ contribution, binding }]);
      }
    }
  }

  return Object.fromEntries(
    [...byKey].map(([key, rungs]): [string, KeymapBinding] => [
      key,
      (state, dispatch, view) => {
        const applies = applicability();
        const live = rungs.filter((rung) => keymapContributionApplies(rung.contribution, applies));
        const answering = answeringLayer(live, applies.layers);
        for (const rung of live) {
          const { scope, layer } = rung.contribution;
          if (scope === "layer" && layer !== answering) continue;
          if (rung.binding(state, dispatch, view)) return true;
        }
        return false;
      },
    ]),
  );
}

/** Which layer answers this chord: the deepest open one that claimed it, or `null` — which is both "no layer claimed it" and the token the keys registered before their popover existed carry, so those answer exactly when no layer does. */
function answeringLayer(
  live: readonly KeymapRung[],
  layers: readonly ChromeLayer[],
): ChromeLayer | null {
  const claimed = new Set(
    live
      .filter((rung) => rung.contribution.scope === "layer")
      .map((rung) => rung.contribution.layer),
  );
  for (let depth = layers.length - 1; depth >= 0; depth -= 1) {
    const layer = layers[depth];
    if (claimed.has(layer)) return layer;
  }
  return null;
}
