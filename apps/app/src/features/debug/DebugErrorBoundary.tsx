import { Component, type ReactNode } from "react";

type Props = {
  title: string;
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
    // eslint-disable-next-line no-console
    console.warn(`[debug-overlay] "${this.props.title}" failed:`, error);
  }

  render(): ReactNode {
    const { title, showTitle, children } = this.props;
    const fallback = (
      <p className="text-xs text-muted-foreground">not available — {this.state.error}</p>
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
