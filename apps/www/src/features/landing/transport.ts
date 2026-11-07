import type { CardStore } from "./card-store";
import type { Layout } from "./film-layout";
import { AUTOPLAY_SECONDS, clamp, ease, lerp, SECTIONS } from "./timeline";

type AutoplayState = "idle" | "playing" | "paused" | "done";

const PLAY_LABELS: Record<AutoplayState, string> = {
  idle: "Play the story",
  playing: "Pause",
  paused: "Resume",
  done: "Play again",
};
const GLIDE_SECONDS = 3;

/**
 * Everything that moves the page for the visitor: autoplay, jump links and the
 * glide after Send answers. Any input of theirs takes the scroll back at once.
 */
export function createTransport(options: {
  root: HTMLElement;
  store: CardStore;
  getLayout: () => Layout;
  /** The page jumped to the start: the film should follow without easing through the story. */
  onRewind: () => void;
  signal: AbortSignal;
}) {
  const { root, store, getLayout, onRewind, signal } = options;
  const html = document.documentElement;
  const playButtons = [...root.querySelectorAll<HTMLElement>("[data-play]")];
  let state: AutoplayState = "idle";
  let time = 0;
  let lastScroll = 0;
  const glide = { active: false, time: 0, from: 0, to: 0 };

  const interpolate = (value: number, from: "y" | "t", to: "y" | "t") => {
    const { stops, documentHeight, height } = getLayout();
    const all = [...stops, { y: documentHeight - height, t: AUTOPLAY_SECONDS }];
    for (let index = 1; index < all.length; index += 1) {
      if (value <= all[index][from]) {
        const a = all[index - 1];
        const b = all[index];
        return lerp(a[to], b[to], (value - a[from]) / Math.max(0.001, b[from] - a[from]));
      }
    }
    return all[all.length - 1][to];
  };

  const setState = (next: AutoplayState) => {
    state = next;
    const label = PLAY_LABELS[state];
    for (const button of playButtons) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    html.dataset.auto = state;
  };

  const interrupt = () => {
    glide.active = false;
    if (state === "playing") setState("paused");
  };

  const togglePlay = () => {
    glide.active = false;
    if (state === "playing") {
      setState("paused");
      return;
    }
    const { documentHeight, height } = getLayout();
    if (state === "done" || scrollY >= documentHeight - height - 2) {
      scrollTo(0, 0);
      onRewind();
      time = 0;
    } else {
      time = interpolate(scrollY, "y", "t");
    }
    lastScroll = scrollY;
    setState("playing");
  };

  const onPlayControl = (event: Event) =>
    event.target instanceof Element && event.target.closest("[data-play]") !== null;

  for (const button of playButtons) button.addEventListener("click", togglePlay, { signal });
  const passive = { passive: true, signal };
  addEventListener("wheel", interrupt, passive);
  addEventListener("touchmove", interrupt, passive);
  addEventListener(
    "pointerdown",
    (event) => {
      if (!onPlayControl(event)) interrupt();
    },
    passive,
  );
  addEventListener(
    "keydown",
    (event) => {
      if (onPlayControl(event) && (event.key === " " || event.key === "Enter")) return;
      interrupt();
    },
    { signal },
  );

  const jumpPosition = (hash: string) => {
    return SECTIONS.find((section) => section.hash === hash)?.jumpTo(getLayout().spans) ?? 0;
  };

  for (const link of root.querySelectorAll<HTMLAnchorElement>(".jumps a, .word")) {
    link.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        interrupt();
        scrollTo(0, jumpPosition(link.hash));
      },
      { signal },
    );
  }

  const stopListening = store.onSend(() => {
    glide.active = true;
    glide.time = 0;
    glide.from = scrollY;
    glide.to = getLayout().spans.hints[1];
  });
  signal.addEventListener("abort", stopListening);

  setState("idle");
  if (location.hash) scrollTo(0, jumpPosition(location.hash));

  return {
    isPlaying: () => state === "playing",
    /** One frame of whatever is moving the page. */
    advance(elapsedMs: number) {
      if (state === "playing") {
        if (Math.abs(scrollY - lastScroll) > 6) {
          setState("paused");
        } else {
          time += elapsedMs / 1000;
          if (time >= AUTOPLAY_SECONDS) {
            setState("done");
          } else {
            scrollTo(0, interpolate(time, "t", "y"));
            lastScroll = scrollY;
          }
        }
      }
      if (glide.active) {
        glide.time += elapsedMs / 1000;
        const amount = ease(clamp(glide.time / GLIDE_SECONDS));
        scrollTo(0, lerp(glide.from, glide.to, amount));
        if (amount >= 1) glide.active = false;
      }
    },
  };
}
