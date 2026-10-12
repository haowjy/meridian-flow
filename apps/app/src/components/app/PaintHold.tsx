/** Pane continuity: retain the last finished paint while visible content loads. */
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
  private released: ((cover: { scrolledBy: readonly number[] }) => void)[] = [];

  private projection: ((cover: HTMLElement) => void) | null = null;
  private scrolledBy: number[] = [];

  /**
   * The cover is an immutable capture plus the current projection of the
   * writer's intents onto it (`projectCover`). Its markup is set here, not by
   * React, which would reset `innerHTML` on every render.
   */
  private mountCover = (node: HTMLDivElement | null) => {
    this.cover.current = node;
    if (node && this.state.paint)
      this.renderCover(node, this.state.paint, this.state.paint.scrolls);
  };

  private renderCover(cover: HTMLElement, paint: Paint, scrolls: readonly number[]) {
    cover.innerHTML = paint.html;
    this.projection?.(cover);
    lockCover(cover);
    for (const [index, node] of cover.querySelectorAll<HTMLElement>(".meridian-editor").entries())
      node.scrollTop = scrolls[index] ?? 0;
  }

  /**
   * Set how the writer's intents show on a cover (or null for none), replacing
   * the last. A cover up now is rebuilt from its capture, so an intent withdrawn
   * (a refused Discard) comes back; where the reader has scrolled it to is kept.
   */
  projectCover = (project: ((cover: HTMLElement) => void) | null) => {
    this.projection = project;
    const { paint } = this.state;
    if (this.cover.current && paint)
      this.renderCover(this.cover.current, paint, coverScrolls(this.cover.current));
  };

  /** How far each editor of the cover was scrolled from the paint it copies. */
  private measureCover(paint: Paint) {
    this.scrolledBy = coverScrolls(this.cover.current).map(
      (top, index) => top - (paint.scrolls[index] ?? 0),
    );
  }

  /**
   * Run `work` once the cover is gone and the page is live again, in the same
   * task as that release (before the browser paints), told how far the reader
   * scrolled the cover. At once when nothing is covering.
   */
  afterRelease = (work: (cover: { scrolledBy: readonly number[] }) => void) => {
    if (this.state.paint) this.released.push(work);
    else work({ scrolledBy: [] });
  };

  capture = (refresh = false) => {
    const page = this.page.current;
    if (!page || !this.context || this.state.paint || this.pending.size) return;
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
      // A synchronous layout dispatch must reuse the frame actually painted,
      // not the intermediate DOM of a commit the browser has never shown.
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.capture(true);
      });
    }
    if (paint && this.cover.current) {
      if (paint.focused && !previous.paint) this.status.current?.focus({ preventScroll: true });
    } else if (!paint) {
      // First, whatever was waiting for the cover to lift (the content's place
      // and focus); only focus still on the status line is then returned to the frame.
      if (previous.paint) {
        const work = this.released;
        this.released = [];
        const cover = { scrolledBy: this.scrolledBy };
        this.scrolledBy = [];
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

/**
 * The cover can be read: its editors scroll. Nothing else in it answers (it is a
 * copy; its buttons and prose are not the page's), so everything in it but those
 * scroll panes is inert.
 */
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
/** Set how the writer's intents show on the page's cover (see `PaintHold.projectCover`). */
export function usePaintCoverProjection(): (
  project: ((cover: HTMLElement) => void) | null,
) => void {
  const frame = useContext(FrameContext);
  return useCallback((project) => frame?.projectCover(project), [frame]);
}

/** The page's cover, if one holds it: run `work` the moment it lifts (see `PaintHold.afterRelease`). */
export function useAfterPaintRelease(): (
  work: (cover: { scrolledBy: readonly number[] }) => void,
) => void {
  const frame = useContext(FrameContext);
  return useCallback(
    (work) => (frame ? frame.afterRelease(work) : work({ scrolledBy: [] })),
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
