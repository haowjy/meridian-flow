// @ts-nocheck
/**
 * DebugErrorBoundary — shared error boundary used throughout the dev-only
 * debug overlay.
 *
 * Key decisions:
 * - Catches render errors from any subtree (one section, one store row) and
 *   degrades to "not available — <error>" instead of tearing the overlay down.
 *   The product-lift track is moving hooks under us; a debug tool that crashes
 *   on a moved hook is worse than useless.
 * - Logs to `console.warn` so dev sees the failing surface and can fix the
 *   read.
 * - Single shared implementation — previously duplicated as `SectionBoundary`
 *   in `DebugOverlay.tsx` and `SafeRow` in `sections/StoresSection.tsx`.
 * - i18n exception: DEV-only.
 */
import { Component, type ReactNode } from "react";

type Props = {
  /** Human-readable label used in the console warning and (optionally) above
   *  the fallback message. */
  title: string;
  /** When true, render the title above the fallback (used by StoresSection
   *  rows). When false (the default for full-section wrappers in DebugOverlay),
   *  the surrounding accordion already shows the title. */
  showTitle?: boolean;
  children: ReactNode;
};

type State = { error: string | null };

export class DebugErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(error: unknown): void {
    // Surface to the dev console — overlay errors usually mean a hook moved
    // under us and we should fix the read.
    // eslint-disable-next-line no-console
    console.warn(`[debug-overlay] "${this.props.title}" failed:`, error);
  }

  render(): ReactNode {
    const { title, showTitle, children } = this.props;
    const fallback = (
      <p className="text-meta text-muted-foreground">not available — {this.state.error}</p>
    );
    if (this.state.error) {
      if (showTitle) {
        return (
          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium text-foreground">{title}</div>
            {fallback}
          </div>
        );
      }
      return fallback;
    }
    return children;
  }
}
