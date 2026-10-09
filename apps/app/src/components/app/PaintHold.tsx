/** Pane continuity: retain the last finished paint while visible content loads. */
import { Component, createContext, type ReactNode, useContext, useLayoutEffect } from "react";

type Paint = { html: string; scrolls: number[]; focused: boolean };
const FrameContext = createContext<PaintHold | null>(null);
const ScopeContext = createContext(true);

export class PaintHold extends Component<
  {
    status: string;
    className?: string;
    children: ReactNode;
  },
  { paint: Paint | null }
> {
  state = { paint: null as Paint | null };
  private page: HTMLDivElement | null = null;
  private frame: HTMLDivElement | null = null;
  private status: HTMLParagraphElement | null = null;
  private cover: HTMLDivElement | null = null;
  private pending = new Set<object>();
  private captured: Paint | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  capture = () => {
    if (this.state.paint || this.pending.size || this.captured || !this.page) return;
    const copy = this.page.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-paint-scope="inactive"]').forEach((node) => {
      node.remove();
    });
    copy.querySelectorAll("[id]").forEach((node) => {
      node.removeAttribute("id");
    });
    this.captured = {
      html: copy.innerHTML,
      scrolls: Array.from(this.page.querySelectorAll<HTMLElement>(".meridian-editor"))
        .filter((node) => !node.closest('[data-paint-scope="inactive"]'))
        .map((node) => node.scrollTop),
      focused: this.page.contains(document.activeElement),
    };
  };
  decide = () => this.forceUpdate();
  mark = (token: object, pending: boolean) => {
    if (pending) this.pending.add(token);
    else this.pending.delete(token);
    this.decide();
  };
  componentDidUpdate(_props: Readonly<typeof this.props>, previous: Readonly<typeof this.state>) {
    const paint = this.state.paint;
    if (!paint && this.captured && this.pending.size) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setState({ paint: this.captured });
      this.timer = setTimeout(() => {
        this.captured = null;
        this.setState({ paint: null });
      }, 10_000);
    } else if (paint && !this.pending.size) {
      clearTimeout(this.timer);
      this.captured = null;
      this.setState({ paint: null });
    } else if (!paint && this.captured && !this.raf) {
      // A synchronous layout dispatch must reuse the frame actually painted,
      // not the intermediate DOM of a commit the browser has never shown.
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (!this.state.paint) this.captured = null;
      });
    }
    if (paint && this.cover) {
      this.cover.querySelectorAll<HTMLElement>(".meridian-editor").forEach((node, index) => {
        node.scrollTop = paint.scrolls[index] ?? 0;
      });
      if (paint.focused && !previous.paint) this.status?.focus({ preventScroll: true });
    } else if (!paint && document.activeElement === this.status) {
      this.frame?.focus({ preventScroll: true });
    }
  }
  componentWillUnmount() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
  }
  render() {
    const { paint } = this.state;
    return (
      <FrameContext.Provider value={this}>
        <div
          ref={(node) => {
            this.frame = node;
          }}
          className={`${this.props.className ?? ""} outline-none`}
          tabIndex={-1}
        >
          <div
            ref={(node) => {
              this.page = node;
            }}
            className="contents"
            data-paint-page
            inert={paint ? true : undefined}
          >
            {this.props.children}
          </div>
          <p
            ref={(node) => {
              this.status = node;
            }}
            role="status"
            tabIndex={-1}
            className="sr-only outline-none"
          >
            {paint ? this.props.status : ""}
          </p>
          {paint ? (
            <div
              ref={(node) => {
                this.cover = node;
              }}
              data-paint-hold
              inert
              aria-hidden
              className="absolute inset-0 z-40 flex flex-col overflow-hidden bg-background"
              dangerouslySetInnerHTML={{ __html: paint.html }}
            />
          ) : null}
        </div>
      </FrameContext.Provider>
    );
  }
}

class Capture extends Component<{ surface: string; frame: PaintHold | null; active: boolean }> {
  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>) {
    if (this.props.active && previous.surface !== this.props.surface) this.props.frame?.capture();
    return null;
  }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (previous.surface !== this.props.surface) this.props.frame?.decide();
  }
  render() {
    return null;
  }
}
export function PaintCapture({ surface }: { surface: string }) {
  return (
    <Capture surface={surface} frame={useContext(FrameContext)} active={useContext(ScopeContext)} />
  );
}
export function PaintScope({ active, children }: { active: boolean; children: ReactNode }) {
  const visible = useContext(ScopeContext) && active;
  return (
    <ScopeContext.Provider value={visible}>
      <div className="contents" data-paint-scope={visible ? "active" : "inactive"}>
        {children}
      </div>
    </ScopeContext.Provider>
  );
}
export function usePaintPending(pending = true) {
  const frame = useContext(FrameContext);
  const active = useContext(ScopeContext);
  useLayoutEffect(() => {
    if (!frame || !active || !pending) return;
    const token = {};
    frame.mark(token, true);
    return () => frame.mark(token, false);
  }, [frame, active, pending]);
}
