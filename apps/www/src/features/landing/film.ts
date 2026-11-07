import type { CardStore } from "./card-store";
import { type FilmParts, type Layout, measureLayout } from "./film-layout";
import type { ProductSlot } from "./ProductPlaceholder";
import { createSky, type SkyFrame } from "./sky";
import { type BeatProgress, beatProgress, clamp, ease, lerp, progress, SECTIONS } from "./timeline";
import { createTransport } from "./transport";

/** A touch device's address bar resizes the window by less than this. */
const ADDRESS_BAR_HEIGHT = 120;

const show = (element: HTMLElement | SVGElement, opacity: number) => {
  element.style.opacity = String(opacity);
  element.style.visibility = opacity > 0.002 ? "visible" : "hidden";
};

/** Reveals `element`'s text a character at a time, holding its layout from the start. */
function typewriter(element: HTMLElement, caretClass: string) {
  const original = element.innerHTML;
  const characters: { char: string; italic: boolean }[] = [];
  const collect = (node: Node, italic: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        for (const char of child.textContent ?? "") characters.push({ char, italic });
      } else {
        collect(child, italic || child.nodeName === "I");
      }
    }
  };
  collect(element, false);

  const shown = document.createElement("span");
  const caret = document.createElement("i");
  const rest = document.createElement("span");
  caret.className = `car ${caretClass}`;
  caret.hidden = true;
  rest.style.visibility = "hidden";
  element.replaceChildren(shown, caret, rest);

  const fill = (target: HTMLElement, from: number, to: number) => {
    target.replaceChildren();
    for (let index = from; index < to; ) {
      const italic = characters[index].italic;
      let end = index;
      while (end < to && characters[end].italic === italic) end += 1;
      const text = characters
        .slice(index, end)
        .map((c) => c.char)
        .join("");
      if (italic) target.append(Object.assign(document.createElement("i"), { textContent: text }));
      else target.append(text);
      index = end;
    }
  };

  let last = -1;
  return {
    set(amount: number, caretVisible: boolean) {
      caret.hidden = !caretVisible;
      const count = Math.round(amount * characters.length);
      if (count === last) return;
      last = count;
      fill(shown, 0, count);
      fill(rest, count, characters.length);
    },
    restore() {
      element.innerHTML = original;
    },
  };
}

/** Reduced motion: the stacked page over a still night sky. */
function startStill(root: HTMLElement, store: CardStore, signal: AbortSignal) {
  const stopListening = store.onSend(() => root.querySelector("#the-twist")?.scrollIntoView());
  signal.addEventListener("abort", stopListening);
  const sky = createSky(root.querySelector("#sky") as HTMLCanvasElement, signal);
  const frame: SkyFrame = {
    lampX: 0.2,
    lampY: -0.26,
    rotation: 0.7,
    trail: 0,
    dawn: 0,
    horizon: -0.26,
    veil: 0.12,
    zoom: 1,
    lamp: 0.6,
    width: 0,
    aurora: 1,
  };
  const render = () => {
    sky.resize();
    sky.draw(frame, 3);
  };
  render();
  addEventListener("resize", render, { signal });
}

function skyFrame(beats: BeatProgress, raw: number, velocity: number, layout: Layout): SkyFrame {
  const { home, workspace, windowWidth, height, endTop, documentHeight } = layout;
  const push = ease(beats.push);
  const dawn = ease(beats.dawn);
  const toEnd = ease(
    progress(raw, endTop - height * 0.8, Math.min(documentHeight - height, endTop)),
  );
  const homeCenter = (home.x + home.w / 2 - windowWidth / 2) / height;
  const workspaceCenter = (workspace.x + workspace.w / 2 - windowWidth / 2) / height;
  const spread =
    lerp(home.w / 2 / height, (workspace.w / 2 / height) * 0.9, dawn) * (1 - push * 0.9);
  const toTwist = ease(progress(beats.twist, 0, 0.5));
  let veil = lerp(0, 0.86, push);
  veil = lerp(veil, 0.62, ease(beats.out));
  veil = lerp(veil, 0.8, ease(progress(beats.ask, 0, 0.2)));
  veil = lerp(veil, 0.34, toTwist);
  veil = lerp(veil, 0, dawn);
  const horizon = -0.25;
  return {
    lampX: lerp(lerp(homeCenter, workspaceCenter, dawn), 0, toEnd),
    lampY: horizon,
    rotation: 0.7 + raw * 0.00011 - ease(progress(beats.twist, 0.1, 1)) * 1.1,
    trail:
      clamp(Math.abs(velocity) * 0.0006, 0, 0.1) +
      ease(progress(beats.twist, 0.15, 0.6)) * (1 - ease(progress(beats.twist, 0.85, 1))) * 0.11,
    dawn,
    horizon,
    veil,
    zoom: lerp(lerp(1, 5.5, push), 1, toTwist),
    lamp: lerp(lerp(0.55, 0.14, push), 0.5, toTwist) * (1 - dawn),
    width: lerp(spread, 0, toEnd),
    aurora:
      lerp(0.72, 0.4, push) +
      ease(progress(beats.twist, 0.05, 0.45)) * (1 - ease(progress(beats.twist, 0.8, 1))) * 1.1,
  };
}

/** Autoplay acts out the card while it plays. */
function demonstrateCard(store: CardStore, asked: number) {
  if (asked <= 0 || asked >= 0.86) return;
  if (asked < 0.3) store.demonstrate(0, null);
  else if (asked < 0.46) store.demonstrate(0, "a");
  else if (asked < 0.62) store.demonstrate(1, null);
  else store.demonstrate(1, "a");
}

/**
 * The scroll film. The stage is pinned while the page scrolls through it, and
 * `paint` maps the scroll position to every layer. It writes the DOM directly
 * because it runs per frame. Returns the teardown.
 */
export function startFilm(root: HTMLElement, store: CardStore, slot: ProductSlot) {
  const controller = new AbortController();
  const { signal } = controller;
  const html = document.documentElement;

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    html.classList.remove("cine");
    startStill(root, store, signal);
    return () => controller.abort();
  }
  html.classList.add("cine");

  const one = <T extends Element = HTMLElement>(selector: string) =>
    root.querySelector(selector) as T;
  const all = <T extends HTMLElement = HTMLElement>(selector: string) => [
    ...root.querySelectorAll<T>(selector),
  ];

  const hero = one("#hero");
  const chapter = one("#chapter");
  const team = one("#the-team");
  const twist = one("#the-twist");
  const caption = one("#the-workspace");
  const captionShade = one("#capshade");
  const ask = one("#your-decisions");
  const card = one("#card");
  const world = one("#the-world");
  const worldNotes = all(".wn");
  const agents = all(".ag");
  const subtitles = all(".sub li");
  const jumpLinks = all<HTMLAnchorElement>(".jumps a");
  const sectionLabel = one("#herel");
  const parts: FilmParts = {
    stage: one(".stage"),
    film: one("#film"),
    end: one("#end"),
    blockHome: one(".slotwrap"),
    block: slot.element,
    caption,
    chapter,
    chapterOpening: one(".open"),
    lastTypedParagraph: one("#p3"),
    turnParagraphs: { a: one("#r-a"), b: one("#r-b") },
    hub: one(".hub"),
    agents,
    teamLines: one<SVGSVGElement>("#lines"),
    worldNotes,
    worldLines: one<SVGSVGElement>("#wlines"),
  };

  const sky = createSky(one<HTMLCanvasElement>("#sky"), signal);
  const typers = [
    typewriter(one("#ty1"), "ai"),
    typewriter(one("#ty2"), "ai"),
    typewriter(one("#ty3"), "me"),
  ] as const;
  const turnTypers = { a: typewriter(one("#tra"), "me"), b: typewriter(one("#trb"), "me") };
  const worldTypers = ["#w0", "#w1", "#w2", "#w3"].map((id) => typewriter(one(id), "me"));
  const allTypers = [...typers, turnTypers.a, turnTypers.b, ...worldTypers];

  let layout: Layout = measureLayout(parts);
  let needsPaint = true;
  const measure = () => {
    chapter.style.transform = "none";
    layout = measureLayout(parts);
    sky.resize();
    needsPaint = true;
  };

  function paint(at: number, beats: BeatProgress) {
    const { spans, height, width, home, workspace, blockLayoutWidth, isPhone } = layout;
    const { world: worldP, open, write, out, back, ask: asked, turn, twist: twistP } = beats;
    const { dawn: dawnP, hints, leave } = beats;
    const push = ease(beats.push);

    show(hero, 1 - clamp(push * 2.4));
    hero.style.transform = `translateY(${-push * 70}px)`;

    const rise = ease(progress(dawnP, 0.15, 1));
    let x: number;
    let y: number;
    let blockWidth: number;
    let opacity: number;
    let grade: number;
    if (dawnP <= 0) {
      blockWidth = home.w * lerp(1, 2.5, push);
      x = lerp(home.x, width / 2 - blockWidth * 0.5, push);
      y = lerp(home.y, height * 0.5 - blockWidth * 0.3, push);
      opacity = 1 - clamp((push - 0.25) / 0.55);
      grade = lerp(0.84, 0.3, push);
    } else {
      blockWidth = workspace.w * lerp(0.8, 1, rise);
      x = workspace.x + (workspace.w - blockWidth) / 2;
      y = lerp(height * 0.86, workspace.y, rise);
      opacity = clamp(dawnP / 0.28);
      grade = lerp(0.42, 1, ease(progress(dawnP, 0.2, 0.95)));
      if (leave > 0) {
        const away = ease(leave);
        y += away * height * 0.75;
        opacity *= 1 - away;
      }
    }
    const block = slot.element;
    block.style.transform = `translate3d(${x - home.x}px,${y - home.y}px,0) scale(${blockWidth / blockLayoutWidth})`;
    show(block, opacity);
    block.style.filter =
      grade < 0.995
        ? `brightness(${grade.toFixed(3)}) saturate(${(1 - (1 - grade) * 0.5).toFixed(3)})`
        : "none";
    block.inert = !(rise > 0.98 && leave < 0.05);
    if (hints > 0) slot.set("hints", progress(hints, 0.08, 0.95));
    else slot.set("team", 0);

    show(world, ease(progress(push, 0.6, 1)) * (1 - ease(progress(worldP, 0.84, 1))));
    worldTypers.forEach((typer, index) => {
      const from = 0.04 + index * 0.2;
      typer.set(progress(worldP, from, from + 0.22), worldP >= from && worldP < from + 0.22);
      (worldNotes[index].firstElementChild as HTMLElement).style.opacity =
        worldP > from ? "1" : "0";
      const line = layout.worldLines[index - 1];
      if (line) {
        line.path.style.strokeDashoffset = String(
          line.length * (1 - ease(progress(worldP, from, from + 0.2))),
        );
        line.dot.style.opacity = worldP > from ? "1" : "0";
      }
    });

    const chapterIn = ease(progress(open, 0, 0.7));
    const chapterDim =
      asked > 0
        ? clamp(1 - ease(progress(asked, 0, 0.12)) + ease(progress(asked, 0.9, 1)))
        : 1 - ease(progress(out, 0, 0.28));
    show(chapter, chapterIn * chapterDim * (1 - ease(progress(twistP, 0.02, 0.2))));
    const chapterOffset = lerp(
      lerp(layout.chapterFrom, layout.chapterTo, ease(write) * 0.3 + write * 0.7),
      layout.turn[store.whoIsHe()],
      ease(progress(turn, 0, 0.4)),
    );
    chapter.style.transform = `translate3d(0,${-chapterOffset}px,0)`;
    typers[0].set(progress(write, 0.04, 0.42), write > 0.02 && write < 0.42);
    typers[1].set(progress(write, 0.42, 0.9), write >= 0.42 && write < 0.9);
    typers[2].set(progress(write, 0.5, 0.98), write >= 0.5 && write < 0.985);

    const askShown = ease(progress(asked, 0, 0.14)) * (1 - ease(progress(asked, 0.9, 1)));
    show(ask, askShown);
    card.style.transform = `translateY(${(1 - askShown) * 18}px)`;
    turnTypers[store.whoIsHe()].set(progress(turn, 0.2, 1), turn > 0.15 && turn < 1);

    const writeStart = spans.write[0];
    const writeLength = spans.write[1] - spans.write[0];
    const subtitleSpans: Record<string, readonly [number, number]> = {
      s1: [spans.open[0], writeStart + writeLength * 0.2],
      s2: [writeStart + writeLength * 0.24, writeStart + writeLength * 0.7],
      s3: [spans.out[0], spans.out[1]],
      s4: [spans.back[1] - height * 0.2, spans.ask[0] + height * 0.02],
    };
    const fade = height * 0.035;
    for (const subtitle of subtitles) {
      const [from, to] = subtitleSpans[subtitle.dataset.b as string];
      const shown = progress(at, from, from + fade) * (1 - progress(at, to - fade, to));
      show(subtitle, shown);
      subtitle.style.transform = `translateY(${(1 - shown) * 8}px)`;
    }

    const teamShown = ease(progress(out, 0, 0.3)) * (1 - ease(progress(asked, 0, 0.1)));
    show(team, teamShown);
    const reportWindows = [
      [0.1, 0.62],
      [0.3, 0.78],
      [0.2, 0.7],
      [0.05, 0.92],
    ];
    agents.forEach((agent, index) => {
      agent.style.opacity = String(
        isPhone ? 1 : ease(progress(out, 0.25 + index * 0.12, 0.5 + index * 0.12)),
      );
      const [leaves, returns] = reportWindows[index];
      agent.classList.toggle("back", back >= returns);
      const line = layout.teamLines[index];
      if (!line || teamShown === 0) return;
      const drawn = ease(progress(out, 0.1 + index * 0.08, 0.8 + index * 0.04));
      line.path.style.strokeDashoffset = String(line.length * (1 - drawn));
      const returned = progress(back, leaves, returns);
      const point = line.path.getPointAtLength(line.length * (out < 1 ? drawn : 1 - returned));
      line.dot.setAttribute("cx", String(point.x));
      line.dot.setAttribute("cy", String(point.y));
      line.dot.style.opacity = out > 0 && (returned < 1 || out < 1) ? "1" : "0";
    });

    const twistShown = ease(progress(twistP, 0.1, 0.4)) * (1 - ease(progress(twistP, 0.93, 1)));
    show(twist, twistShown);
    twist.style.transform = `scale(${1.06 - twistShown * 0.06})`;

    const captionShown = ease(progress(dawnP, 0.72, 1)) * (1 - ease(progress(leave, 0, 0.4)));
    show(caption, captionShown);
    captionShade.style.opacity = String(captionShown);
    caption.style.transform = `translateY(${(1 - captionShown) * 14}px)`;

    const section = SECTIONS.findLast((candidate) => at >= candidate.startsAt(spans, height));
    const sectionName = section?.label ?? "Jump to";
    if (sectionLabel.textContent !== sectionName) sectionLabel.textContent = sectionName;
    for (const link of jumpLinks) {
      link.setAttribute("aria-current", String(link.hash === section?.hash));
    }
  }

  let current = 0;
  let velocity = 0;
  let lastFrame = performance.now();
  let slowFrames = 0;
  let slowTime = 0;
  let frameRequest = 0;

  const transport = createTransport({
    root,
    store,
    getLayout: () => layout,
    remeasure: measure,
    onRewind: () => {
      current = -layout.filmTop;
    },
    signal,
  });
  const unsubscribe = store.subscribe(() => {
    needsPaint = true;
  });

  function frame(now: number) {
    const elapsed = Math.min(250, now - lastFrame);
    const step = Math.min(64, now - lastFrame);
    lastFrame = now;
    transport.advance(elapsed);

    const raw = scrollY;
    const target = raw - layout.filmTop;
    const previous = current;
    current += (target - current) * (1 - 0.0016 ** ((step / 1000) * 2.2));
    if (Math.abs(target - current) < 0.3) current = target;
    velocity = lerp(velocity, ((current - previous) / Math.max(step, 1)) * 16, 0.2);

    const beats = beatProgress(current, layout.spans);
    if (transport.isPlaying()) demonstrateCard(store, beats.ask);
    if (current !== previous || needsPaint) {
      needsPaint = false;
      paint(current, beats);
    }
    sky.draw(skyFrame(beats, current + layout.filmTop, velocity, layout), now / 1000);

    slowTime += step;
    slowFrames += 1;
    if (slowFrames === 40) {
      if (slowTime / slowFrames > 30) sky.lowerResolution();
      slowFrames = 0;
      slowTime = 0;
    }
    frameRequest = requestAnimationFrame(frame);
  }

  // A phone's address bar firing resize mid-scroll would otherwise rebuild the layout.
  addEventListener(
    "resize",
    () => {
      const isAddressBar =
        "ontouchstart" in window &&
        html.clientWidth === layout.windowWidth &&
        Math.abs(innerHeight - layout.height) < ADDRESS_BAR_HEIGHT;
      if (!isAddressBar) measure();
    },
    { signal },
  );

  sky.resize();
  document.fonts.ready.then(() => {
    if (!signal.aborted) measure();
  });
  current = scrollY - layout.filmTop;
  html.classList.add("film-ready");
  frameRequest = requestAnimationFrame(frame);

  return () => {
    controller.abort();
    cancelAnimationFrame(frameRequest);
    unsubscribe();
    for (const typer of allTypers) typer.restore();
    html.classList.remove("film-ready");
  };
}
