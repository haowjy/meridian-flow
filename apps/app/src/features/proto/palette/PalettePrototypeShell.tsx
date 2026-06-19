/**
 * THROWAWAY shell for /proto/palette — composes the workspace replica with
 * the floating control panel and the runtime CSS-var overrides hook.
 *
 * Disposable; do not import from production code. The only thing that should
 * survive this prototype is the chosen set of token values pasted into
 * `packages/design-tokens/src/ink-jade.css`.
 */

import { PaletteControlPanel } from "./PaletteControlPanel";
import { usePaletteOverrides } from "./use-palette-overrides";
import { WorkspaceReplica } from "./WorkspaceReplica";

export function PalettePrototypeShell() {
  const { values, presetId, elevated, apply, applyPreset, setElevated, reset } =
    usePaletteOverrides();

  return (
    <div className="relative h-svh w-full overflow-hidden bg-background">
      <WorkspaceReplica elevated={elevated} />
      <PaletteControlPanel
        values={values}
        presetId={presetId}
        elevated={elevated}
        onApply={apply}
        onApplyPreset={applyPreset}
        onSetElevated={setElevated}
        onReset={reset}
      />
    </div>
  );
}
