/** Isolates development-only debug sections and logs their render failures. */
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
