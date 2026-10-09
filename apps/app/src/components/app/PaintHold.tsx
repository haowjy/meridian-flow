/** Pane continuity: retain the last finished paint while visible content loads. */
import type { ReactNode } from "react";
import { Component, createContext, createRef, useContext, useLayoutEffect } from "react";

type Hold = { kind: "idle"; paint: null } | { kind: "holding"; paint: Paint };
type Surface = { surface: string; state?: "painted" | "pending" | "failed" };
type FrameProps = { status: string; className?: string; children: ReactNode };
type Paint = { kind: "captured" | "painted"; html: string; scrolls: number[]; focused: boolean };
const FrameContext = createContext<PaintHold | null>(null);
const ScopeContext = createContext(true);

export class PaintHold extends Component<FrameProps, Hold> {
  static contextType = ScopeContext;
  state: Hold = { kind: "idle", paint: null };
  private page = createRef<HTMLDivElement>();
  private frame = createRef<HTMLDivElement>();
  private status = createRef<HTMLParagraphElement>();
  private cover = createRef<HTMLDivElement>();
  private pending = new Set<object>();
  private lastPainted: Paint | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  capture = (refresh = false) => {
    const page = this.page.current;
    if (!page || !this.context || this.state.kind === "holding" || this.pending.size) return;
    if (this.lastPainted?.kind === "captured" && !refresh) {
      this.lastPainted.focused = page.contains(document.activeElement);
      return;
    }
    const copy = page.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll('[data-paint-scope="inactive"]')) node.remove();
    for (const node of copy.querySelectorAll("[id]")) node.removeAttribute("id");
    this.lastPainted = {
      kind: refresh ? "painted" : "captured",
      html: copy.innerHTML,
      scrolls: Array.from(page.querySelectorAll<HTMLElement>(".meridian-editor"))
        .filter((node) => !node.closest('[data-paint-scope="inactive"]'))
        .map((node) => node.scrollTop),
      focused: page.contains(document.activeElement),
    };
  };
  mark = (token: object, pending: boolean) => {
    if (pending) this.pending.add(token);
    else this.pending.delete(token);
    this.forceUpdate();
  };
  componentDidUpdate(_props: Readonly<typeof this.props>, previous: Readonly<typeof this.state>) {
    if (!this.context) this.lastPainted = null;
    const paint = this.state.paint;
    if (!paint && this.lastPainted && this.pending.size) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setState({ kind: "holding", paint: this.lastPainted });
      this.timer = setTimeout(() => {
        this.lastPainted = null;
        this.setState({ kind: "idle", paint: null });
      }, 10_000);
    } else if (paint && !this.pending.size) {
      clearTimeout(this.timer);
      this.setState({ kind: "idle", paint: null });
    } else if (!paint && this.lastPainted && !this.raf) {
      // A synchronous layout dispatch must reuse the frame actually painted,
      // not the intermediate DOM of a commit the browser has never shown.
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.capture(true);
      });
    }
    if (paint && this.cover.current) {
      for (const [index, node] of this.cover.current
        .querySelectorAll<HTMLElement>(".meridian-editor")
        .entries()) {
        node.scrollTop = paint.scrolls[index] ?? 0;
      }
      if (paint.focused && !previous.paint) this.status.current?.focus({ preventScroll: true });
    } else if (!paint && document.activeElement === this.status.current) {
      this.frame.current?.focus({ preventScroll: true });
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
          ref={this.frame}
          className={`${this.props.className ?? ""} outline-none`}
          tabIndex={-1}
        >
          <div
            ref={this.page}
            className="contents"
            data-paint-page
            inert={paint ? true : undefined}
          >
            {this.props.children}
          </div>
          <p ref={this.status} role="status" tabIndex={-1} className="sr-only outline-none">
            {paint ? this.props.status : ""}
          </p>
          {paint ? (
            <div
              ref={this.cover}
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

class Capture extends Component<Surface & { frame: PaintHold | null; active: boolean }> {
  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>) {
    if (
      previous.active &&
      this.props.active &&
      previous.state !== "pending" &&
      previous.surface !== this.props.surface
    )
      this.props.frame?.capture();
    return null;
  }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (previous.surface !== this.props.surface) this.props.frame?.forceUpdate();
  }
  render() {
    return null;
  }
}
export function PaintCapture({ surface, state = "painted" }: Surface) {
  usePaintPending(state === "pending");
  return (
    <Capture
      surface={surface}
      state={state}
      frame={useContext(FrameContext)}
      active={useContext(ScopeContext)}
    />
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
