import type { ReactNode } from "react";
import {
  Component,
  createContext,
  createRef,
  useCallback,
  useContext,
  useLayoutEffect,
} from "react";

type Hold = { paint: Paint | null };
type Surface = { surface: string; state?: "painted" | "pending" | "failed" };
type FrameProps = { status: string; className?: string; children: ReactNode };
type Paint = { kind: "captured" | "painted"; html: string; scrolls: number[]; focused: boolean };
export type CoverAdapter = {
  annotate?: (live: HTMLElement, copy: HTMLElement) => void;
  project?: (cover: HTMLElement) => void;
  read?: (cover: HTMLElement) => unknown;
};
const FrameContext = createContext<PaintHold | null>(null);
const ScopeContext = createContext(true);

export class PaintHold extends Component<FrameProps, Hold> {
  static contextType = ScopeContext;
  state: Hold = { paint: null };
  private page = createRef<HTMLDivElement>();
  private frame = createRef<HTMLDivElement>();
  private status = createRef<HTMLParagraphElement>();
  private cover: { current: HTMLDivElement | null } = { current: null };
  private pending = new Set<object>();
  private lastPainted: Paint | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private released: ((cover: { read: unknown }) => void)[] = [];

  private adapter: CoverAdapter | null = null;
  private coverRead: unknown;

  private mountCover = (node: HTMLDivElement | null) => {
    this.cover.current = node;
    if (node && this.state.paint)
      this.renderCover(node, this.state.paint, this.state.paint.scrolls);
  };

  private renderCover(cover: HTMLElement, paint: Paint, scrolls: readonly number[]) {
    cover.innerHTML = paint.html;
    this.adapter?.project?.(cover);
    lockCover(cover);
    for (const [index, node] of cover.querySelectorAll<HTMLElement>(".meridian-editor").entries())
      node.scrollTop = scrolls[index] ?? 0;
  }

  projectCover = (adapter: CoverAdapter | null) => {
    this.adapter = adapter;
    const { paint } = this.state;
    if (this.cover.current && paint)
      this.renderCover(this.cover.current, paint, coverScrolls(this.cover.current));
  };

  private measureCover(paint: Paint) {
    const cover = this.cover.current;
    const scrolled = coverScrolls(cover).some((top, index) => top !== (paint.scrolls[index] ?? 0));
    this.coverRead = cover && scrolled ? this.adapter?.read?.(cover) : undefined;
  }

  afterRelease = (work: (cover: { read: unknown }) => void) => {
    if (this.state.paint) this.released.push(work);
    else work({ read: undefined });
  };

  capture = (refresh = false) => {
    const page = this.page.current;
    if (!page || !this.context || this.state.paint || this.pending.size) return;
    if (this.lastPainted?.kind === "captured" && !refresh) {
      this.lastPainted.focused = page.contains(document.activeElement);
      return;
    }
    const copy = page.cloneNode(true) as HTMLElement;
    this.adapter?.annotate?.(page, copy);
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
      this.setState({ paint: this.lastPainted });
      this.timer = setTimeout(() => {
        this.lastPainted = null;
        if (this.state.paint) this.measureCover(this.state.paint);
        this.setState({ paint: null });
      }, 10_000);
    } else if (paint && !this.pending.size) {
      clearTimeout(this.timer);
      this.measureCover(paint);
      this.setState({ paint: null });
    } else if (!paint && this.lastPainted && !this.raf) {
      // keep: Wait for the next frame before capturing a synchronous layout dispatch; reuse the painted frame
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.capture(true);
      });
    }
    if (paint && this.cover.current) {
      if (paint.focused && !previous.paint) this.status.current?.focus({ preventScroll: true });
    } else if (!paint) {
      if (previous.paint) {
        const work = this.released;
        this.released = [];
        const cover = { read: this.coverRead };
        this.coverRead = undefined;
        for (const run of work) run(cover);
      }
      if (document.activeElement === this.status.current)
        this.frame.current?.focus({ preventScroll: true });
    }
  }
  componentWillUnmount() {
    this.released = [];
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
  }
  render() {
    const { paint } = this.state;
    return (
      <FrameContext.Provider value={this}>
        <div
          ref={this.frame}
          data-paint-frame
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
          <p
            ref={this.status}
            role="status"
            data-paint-status
            tabIndex={-1}
            className="sr-only outline-none"
          >
            {paint ? this.props.status : ""}
          </p>
          {paint ? (
            <div
              ref={this.mountCover}
              data-paint-hold
              aria-hidden
              className="absolute inset-0 z-40 flex flex-col overflow-hidden bg-background"
            />
          ) : null}
        </div>
      </FrameContext.Provider>
    );
  }
}

function coverScrolls(cover: HTMLElement | null): number[] {
  return Array.from(cover?.querySelectorAll<HTMLElement>(".meridian-editor") ?? []).map(
    (node) => node.scrollTop,
  );
}

function lockCover(node: Element): void {
  for (const child of Array.from(node.children)) {
    if (child.classList.contains("meridian-editor"))
      for (const inner of Array.from(child.children)) inner.setAttribute("inert", "");
    else if (child.querySelector(".meridian-editor")) lockCover(child);
    else child.setAttribute("inert", "");
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
export function usePaintCoverProjection(): (adapter: CoverAdapter | null) => void {
  const frame = useContext(FrameContext);
  return useCallback((adapter) => frame?.projectCover(adapter), [frame]);
}

export function useAfterPaintRelease(): (work: (cover: { read: unknown }) => void) => void {
  const frame = useContext(FrameContext);
  return useCallback(
    (work) => (frame ? frame.afterRelease(work) : work({ read: undefined })),
    [frame],
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
