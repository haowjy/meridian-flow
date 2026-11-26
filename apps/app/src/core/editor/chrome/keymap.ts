import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import type { ChromeContext } from "./chrome-context";
import type { ChromeLayer } from "./esc-chain";

export const KEYMAP_SCOPE_ORDER = ["layer", "object", "table", "block", "document"] as const;

export type KeymapScope = (typeof KEYMAP_SCOPE_ORDER)[number];

export type KeymapApplicability = {
  context: ChromeContext;
  layers: readonly ChromeLayer[];
};

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

export type KeymapRoute = "prose" | "chrome" | "native";

export type KeymapBinding = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView,
) => boolean;

type KeymapContributionBase = {
  id: string;
  route?: KeymapRoute;
  appliesTo?: (context: ChromeContext) => boolean;
  bindings: Readonly<Record<string, KeymapBinding>>;
};

export type KeymapContribution = KeymapContributionBase &
  (
    | {
        scope: "layer";
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

export function assertKeymapContribution(
  contribution: KeymapContribution,
  registered: readonly KeymapContribution[] = [],
): void {
  if ("Escape" in contribution.bindings) {
    throw new Error(
      `Keymap contribution "${contribution.id}" bound Escape; the Esc chain owns it — register a chrome layer instead`,
    );
  }
  if (contribution.route === "chrome" && contribution.scope !== "layer") {
    throw new Error(
      `Keymap contribution "${contribution.id}" asked for chrome route at "${contribution.scope}" scope; only a layer's keys may outlive the prose's focus`,
    );
  }
  if (contribution.route === "native" && contribution.scope === "layer") {
    throw new Error(
      `Keymap contribution "${contribution.id}" cannot route layer keys through native input`,
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

function sameKeymapPlace(left: KeymapContribution, right: KeymapContribution): boolean {
  if ((left.route === "native") !== (right.route === "native")) return false;
  if (left.scope !== right.scope) return false;
  if (left.scope !== "layer") return true;
  return left.layer !== null && left.layer === right.layer;
}

type KeymapRung = {
  contribution: KeymapContribution;
  binding: KeymapBinding;
};

export function mergeKeymapContributions(
  contributions: readonly KeymapContribution[],
  applicability: () => KeymapApplicability,
  route: KeymapRoute = "prose",
): Record<string, KeymapBinding> {
  const byKey = new Map<string, KeymapRung[]>();

  for (const scope of KEYMAP_SCOPE_ORDER) {
    for (const contribution of contributions) {
      if (contribution.scope !== scope) continue;
      if ((route === "native") !== (contribution.route === "native")) continue;
      if (route === "chrome" && contribution.route !== "chrome") continue;
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
