import type { CardStore } from "./card-store";
import type { ProductSlot } from "./ProductPlaceholder";
import { createSky, type Sky, type SkyFrame } from "./sky";

const SVG_NS = "http://www.w3.org/2000/svg";
const PHONE_WIDTH = 820;
const WIDE_WINDOW = 2000;
const WIDE_CONTENT = 1600;
const AUTOPLAY_TAIL_SECONDS = 2.5;

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const ease = (t: number) => t * t * (3 - 2 * t);
const progress = (value: number, from: number, to: number) => clamp((value - from) / (to - from));

const show = (element: HTMLElement | SVGElement, opacity: number) => {
  element.style.opacity = String(opacity);
  element.style.visibility = opacity > 0.002 ? "visible" : "hidden";
};

/** Beat name, then its scroll length in viewport heights and its autoplay seconds. */
const BEATS = [
  ["hold", 0.1, 1.2],
  ["push", 0.55, 2],
  ["world", 0.65, 8],
  ["open", 0.2, 2.2],
  ["write", 0.8, 14],
  ["out", 0.45, 3.5],
  ["back", 0.5, 7],
  ["ask", 0.7, 10],
  ["turn", 0.4, 6],
  ["twist", 0.6, 5],
  ["dawn", 0.8, 4.5],
  ["hints", 0.8, 9],
  ["leave", 0.45, 3],
] as const;
type Beat = (typeof BEATS)[number][0];

type Rect = { x: number; y: number; w: number };
type Line = { path: SVGPathElement; dot: SVGCircleElement; length: number };

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

/** Keeps the story text in step with the card. Runs with or without the film. */
export function bindStoryChoice(root: HTMLElement, store: CardStore) {
  const part = (selector: string) => root.querySelector(selector) as HTMLElement;
  const sync = () => {
    const isReplaced = store.whoIsHe() === "a";
    part("#r-a").hidden = !isReplaced;
    part("#r-b").hidden = isReplaced;
    part("#tw-a").hidden = !isReplaced;
    part("#tw-b").hidden = isReplaced;
  };
  sync();
  return store.subscribe(sync);
}

/** Reduced motion: the stacked page over a still night sky. */
function startStill(root: HTMLElement, signal: AbortSignal) {
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
    startStill(root, signal);
    return () => controller.abort();
  }
  html.classList.add("cine");

  const one = <T extends HTMLElement>(selector: string) => root.querySelector(selector) as T;
  const all = <T extends HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];

  const sky: Sky = createSky(one<HTMLCanvasElement>("#sky"), signal);
  const film = one("#film");
  const end = one("#end");
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
  const worldLines = root.querySelector("#wlines") as unknown as SVGSVGElement;
  const teamLines = root.querySelector("#lines") as unknown as SVGSVGElement;
  const agents = all(".ag");
  const subtitles = all(".sub li");
  const jumpLinks = all<HTMLAnchorElement>(".jumps a");
  const playButtons = all("[data-play]");
  const sectionLabel = one("#herel");

  const typers = [
    typewriter(one("#ty1"), "ai"),
    typewriter(one("#ty2"), "ai"),
    typewriter(one("#ty3"), "me"),
  ] as const;
  const turnTypers = { a: typewriter(one("#tra"), "me"), b: typewriter(one("#trb"), "me") };
  const worldTypers = ["#w0", "#w1", "#w2", "#w3"].map((id) => typewriter(one(id), "me"));
  const allTypers = [...typers, turnTypers.a, turnTypers.b, ...worldTypers];

  let wideWindow = 0;
  let width = 0;
  let height = 0;
  let isPhone = false;
  let barHeight = 56;
  let heroRect: Rect = { x: 0, y: 0, w: 1 };
  let workspaceRect: Rect = { x: 0, y: 0, w: 1 };
  let layoutWidth = 1240;
  let chapterFrom = 0;
  let chapterTo = 0;
  const beats = {} as Record<Beat, readonly [number, number, number]>;
  let filmTop = 0;
  let endTop = 0;
  let documentHeight = 1;
  let teamPaths: Line[] = [];
  let worldPaths: Line[] = [];
  let stops: { y: number; t: number }[] = [];
  let totalSeconds = 0;

  const makeLine = (svg: SVGSVGElement, d: string) => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    const dot = document.createElementNS(SVG_NS, "circle");
    svg.append(dot);
    const length = Math.max(1, path.getTotalLength());
    path.style.strokeDasharray = String(length);
    return { path, dot, length };
  };

  const middleOf = (element: HTMLElement) => element.offsetTop + element.offsetHeight / 2;

  /** Lays out the team cards around the chapter, with a curve from each to the page. */
  function layoutTeam(hubY: number) {
    teamLines.replaceChildren();
    teamPaths = [];
    if (isPhone) return;
    const rowHeight = height - barHeight;
    const cardWidth = Math.min(width * 0.25, 340);
    const margin = width * 0.045;
    const spots = [
      [margin, rowHeight * 0.08],
      [width - cardWidth - margin, rowHeight * 0.08],
      [margin, rowHeight * 0.52],
      [width - cardWidth - margin, rowHeight * 0.52],
    ];
    agents.forEach((agent, index) => {
      const [left, top] = spots[index];
      agent.style.left = `${left}px`;
      agent.style.top = `${top}px`;
      const endX = index % 2 ? left : left + cardWidth;
      const endY = top + 50;
      const startX = width / 2;
      const midX = startX + (endX - startX) * 0.5;
      const line = makeLine(
        teamLines,
        `M${startX} ${hubY} C${midX} ${hubY},${midX} ${endY},${endX} ${endY}`,
      );
      line.dot.setAttribute("r", "4.5");
      teamPaths.push(line);
    });
  }

  /** Joins the world notes like a constellation. No line may touch a note: with no such path, no lines. */
  function layoutWorld() {
    worldLines.replaceChildren();
    worldPaths = [];
    if (isPhone) return;
    const left = clamp(width * 0.06, 28, 90);
    const span = Math.min(width - 2 * left, 1240);
    const top = Math.max(barHeight + 44, height * 0.2);
    const spots = [
      [left + 30, top],
      [left + span * 0.56, top - height * 0.03],
      [left + span * 0.62, height * 0.6],
      [left + span * 0.08, height * 0.58],
    ];
    worldNotes.forEach((note, index) => {
      note.style.left = `${spots[index][0]}px`;
      note.style.top = `${spots[index][1]}px`;
    });
    const boxes = worldNotes.map((note) => ({
      l: note.offsetLeft,
      t: note.offsetTop,
      r: note.offsetLeft + note.offsetWidth,
      b: note.offsetTop + note.offsetHeight,
    }));
    type Point = readonly [number, number];
    const onScreen = ([x, y]: Point) =>
      x > 14 && x < width - 14 && y > barHeight + 14 && y < height - 14;
    const anchors = (box: (typeof boxes)[number]): Point[] =>
      (
        [
          [box.l - 18, box.t + 9],
          [box.r + 16, box.t + 9],
          [box.l - 18, box.b - 9],
          [box.r + 16, box.b - 9],
          [(box.l + box.r) / 2, box.t - 18],
          [(box.l + box.r) / 2, box.b + 18],
          [box.l, box.t - 18],
          [box.r, box.t - 18],
          [box.l, box.b + 18],
          [box.r, box.b + 18],
        ] as Point[]
      ).filter(onScreen);
    const crossesNote = (from: Point, to: Point) => {
      for (let step = 0; step <= 48; step += 1) {
        const x = lerp(from[0], to[0], step / 48);
        const y = lerp(from[1], to[1], step / 48);
        for (const box of boxes) {
          if (x > box.l - 10 && x < box.r + 10 && y > box.t - 10 && y < box.b + 10) return true;
        }
      }
      return false;
    };
    let best: Point[] | null = null;
    let bestLength = Number.POSITIVE_INFINITY;
    const walk = (index: number, path: Point[], length: number) => {
      if (length >= bestLength) return;
      if (index === boxes.length) {
        best = path;
        bestLength = length;
        return;
      }
      for (const anchor of anchors(boxes[index])) {
        const previous = path[index - 1];
        if (previous && crossesNote(previous, anchor)) continue;
        const added = previous ? Math.hypot(anchor[0] - previous[0], anchor[1] - previous[1]) : 0;
        walk(index + 1, [...path, anchor], length + added);
      }
    };
    walk(0, [], 0);
    const route = best as Point[] | null;
    if (!route) return;
    for (const [from, to] of [
      [0, 0],
      [0, 1],
      [1, 2],
      [2, 3],
    ]) {
      const line = makeLine(worldLines, `M${route[from]} L${route[to]}`);
      line.dot.setAttribute("cx", String(route[to][0]));
      line.dot.setAttribute("cy", String(route[to][1]));
      line.dot.setAttribute("r", "3.2");
      worldPaths.push(line);
    }
  }

  function measure() {
    wideWindow = html.clientWidth;
    width = wideWindow >= WIDE_WINDOW ? WIDE_CONTENT : wideWindow;
    height = innerHeight;
    isPhone = width < PHONE_WIDTH;
    barHeight = isPhone ? 90 : 56;
    const set = (name: string, value: number) => html.style.setProperty(name, `${value}px`);

    const storySize = isPhone ? Math.min(22, width * 0.057) : clamp(width * 0.0222, 23, 34);
    set("--bigf", storySize);
    set("--bigw", isPhone ? width - 40 : Math.min(width - 160, storySize * 29));

    layoutWidth = isPhone ? 390 : 1240;
    set("--lw", layoutWidth);
    set("--lh", isPhone ? 760 : 775);

    if (isPhone) {
      const columnWidth = width - 40;
      set("--hx", 20);
      set("--hy", barHeight + 18);
      set("--hw", columnWidth);
      set("--cw", columnWidth);
      set("--cy", barHeight + 16);
      heroRect = { x: 12, y: barHeight + 18 + hero.offsetHeight + 16, w: width - 24 };
      workspaceRect = { x: 12, y: barHeight + 16 + caption.offsetHeight + 14, w: width - 24 };
      set("--lh", Math.round((height - heroRect.y - 12) / (heroRect.w / layoutWidth)));
    } else {
      const left = clamp(width * 0.05, 28, 72);
      const heroWidth = clamp(width * 0.3, 300, 440);
      const captionWidth = clamp(width * 0.25, 270, 360);
      set("--hx", left);
      set("--hw", heroWidth);
      set("--cw", captionWidth);
      set("--hy", Math.max(barHeight + 24, (height + barHeight - hero.offsetHeight) / 2));
      set(
        "--cy",
        Math.max(
          barHeight + 24,
          Math.min(
            (height + barHeight - caption.offsetHeight) / 2,
            height * 0.71 - caption.offsetHeight,
          ),
        ),
      );
      const heroBlock = Math.min(
        width - left - heroWidth - 64,
        Math.max(620, (height - barHeight - 64) / 0.625),
        940,
      );
      heroRect = {
        x: width - heroBlock - 36,
        y: Math.max(barHeight + 24, (height + barHeight - heroBlock * 0.625) / 2),
        w: heroBlock,
      };
      const workspaceBlock = Math.min(
        width - left - captionWidth - 72,
        (height - barHeight - 48) / 0.625,
        1020,
      );
      workspaceRect = {
        x: width - workspaceBlock - 36,
        y: Math.max(barHeight + 20, (height + barHeight - workspaceBlock * 0.625) / 2),
        w: workspaceBlock,
      };
    }

    const hubY = (height - barHeight) * 0.4;
    set("--hubY", hubY);
    layoutTeam(hubY);
    layoutWorld();

    chapter.style.transform = "none";
    const anchor = height * 0.44;
    chapterFrom = middleOf(one(".open")) - anchor;
    chapterTo = middleOf(one("#p3")) - anchor;

    let position = 0;
    let seconds = 0;
    stops = [{ y: 0, t: 0 }];
    for (const [name, viewports, duration] of BEATS) {
      beats[name] = [position, position + height * viewports, duration];
      position += height * viewports;
      seconds += duration;
      stops.push({ y: position, t: seconds });
    }
    set("--filmh", position + height);

    filmTop = film.offsetTop;
    endTop = end.offsetTop;
    documentHeight = html.scrollHeight;
    totalSeconds = seconds + AUTOPLAY_TAIL_SECONDS;
    stops.push({ y: documentHeight - height, t: totalSeconds });
    sky.resize();
    needsPaint = true;
  }

  function paint(at: number) {
    const of = (name: Beat) => progress(at, beats[name][0], beats[name][1]);
    const push = ease(of("push"));
    const worldP = of("world");
    const open = of("open");
    const write = of("write");
    const out = of("out");
    const back = of("back");
    const asked = of("ask");
    const turn = of("turn");
    const twistP = of("twist");
    const dawnP = of("dawn");
    const hints = of("hints");
    const leave = of("leave");

    show(hero, 1 - clamp(push * 2.4));
    hero.style.transform = `translateY(${-push * 70}px)`;

    const rise = ease(progress(dawnP, 0.15, 1));
    let x: number;
    let y: number;
    let blockWidth: number;
    let opacity: number;
    let grade: number;
    if (dawnP <= 0) {
      blockWidth = heroRect.w * lerp(1, 2.5, push);
      x = lerp(heroRect.x, width / 2 - blockWidth * 0.5, push);
      y = lerp(heroRect.y, height * 0.5 - blockWidth * 0.3, push);
      opacity = 1 - clamp((push - 0.25) / 0.55);
      grade = lerp(0.84, 0.3, push);
    } else {
      blockWidth = workspaceRect.w * lerp(0.8, 1, rise);
      x = workspaceRect.x + (workspaceRect.w - blockWidth) / 2;
      y = lerp(height * 0.86, workspaceRect.y, rise);
      opacity = clamp(dawnP / 0.28);
      grade = lerp(0.42, 1, ease(progress(dawnP, 0.2, 0.95)));
      if (leave > 0) {
        const away = ease(leave);
        y += away * height * 0.75;
        opacity *= 1 - away;
      }
    }
    const block = slot.element;
    block.style.transform = `translate3d(${x}px,${y}px,0) scale(${blockWidth / layoutWidth})`;
    show(block, opacity);
    block.style.filter =
      grade < 0.995
        ? `brightness(${grade.toFixed(3)}) saturate(${(1 - (1 - grade) * 0.5).toFixed(3)})`
        : "none";
    block.classList.toggle("live", rise > 0.98 && leave < 0.05);
    if (hints > 0) slot.set("hints", progress(hints, 0.08, 0.95));
    else slot.set("team");

    show(world, ease(progress(push, 0.6, 1)) * (1 - ease(progress(worldP, 0.84, 1))));
    worldTypers.forEach((typer, index) => {
      const from = 0.04 + index * 0.2;
      typer.set(progress(worldP, from, from + 0.22), worldP >= from && worldP < from + 0.22);
      (worldNotes[index].firstElementChild as HTMLElement).style.opacity =
        worldP > from ? "1" : "0";
      const line = worldPaths[index];
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
    const turnTarget = middleOf(one(store.whoIsHe() === "a" ? "#r-a" : "#r-b")) - height * 0.44;
    const scrollY_ = lerp(
      lerp(chapterFrom, chapterTo, ease(write) * 0.3 + write * 0.7),
      turnTarget,
      ease(progress(turn, 0, 0.4)),
    );
    chapter.style.transform = `translate3d(0,${-scrollY_}px,0)`;
    typers[0].set(progress(write, 0.04, 0.42), write > 0.02 && write < 0.42);
    typers[1].set(progress(write, 0.42, 0.9), write >= 0.42 && write < 0.9);
    typers[2].set(progress(write, 0.5, 0.98), write >= 0.5 && write < 0.985);

    const askShown = ease(progress(asked, 0, 0.14)) * (1 - ease(progress(asked, 0.9, 1)));
    show(ask, askShown);
    card.style.transform = `translateY(${(1 - askShown) * 18}px)`;
    if (autoplay.state === "playing" && asked > 0 && asked < 0.86) {
      if (asked < 0.3) store.demonstrate(0, null);
      else if (asked < 0.46) store.demonstrate(0, "a");
      else if (asked < 0.62) store.demonstrate(1, null);
      else store.demonstrate(1, "a");
    }
    turnTypers[store.whoIsHe()].set(progress(turn, 0.2, 1), turn > 0.15 && turn < 1);

    const writeStart = beats.write[0];
    const writeLength = beats.write[1] - beats.write[0];
    const subtitleSpans: Record<string, readonly [number, number]> = {
      s1: [beats.open[0], writeStart + writeLength * 0.2],
      s2: [writeStart + writeLength * 0.24, writeStart + writeLength * 0.7],
      s3: [beats.out[0], beats.out[1]],
      s4: [beats.back[1] - height * 0.2, beats.ask[0] + height * 0.02],
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
    team.classList.toggle("on", teamShown > 0);
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
      const line = teamPaths[index];
      if (!line) return;
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

    const section =
      at >= beats.dawn[1] - height * 0.1
        ? 3
        : at >= beats.ask[0] - height * 0.05
          ? 2
          : at >= beats.out[0] - height * 0.1
            ? 1
            : at >= beats.push[1] - height * 0.1
              ? 0
              : -1;
    const sectionName = ["World", "AI Team", "Your decisions", "Workspace"][section] ?? "Jump to";
    if (sectionLabel.textContent !== sectionName) sectionLabel.textContent = sectionName;
    for (const link of jumpLinks) {
      link.setAttribute("aria-current", String(link.hash === SECTION_HASHES[section]));
    }
  }

  function skyFrame(at: number, raw: number): SkyFrame {
    const of = (name: Beat) => progress(at, beats[name][0], beats[name][1]);
    const push = ease(of("push"));
    const out = of("out");
    const asked = of("ask");
    const twistP = of("twist");
    const dawn = ease(of("dawn"));
    const toEnd = ease(
      progress(raw, endTop - height * 0.8, Math.min(documentHeight - height, endTop)),
    );
    const heroCenter = (heroRect.x + heroRect.w / 2 - wideWindow / 2) / height;
    const workspaceCenter = (workspaceRect.x + workspaceRect.w / 2 - wideWindow / 2) / height;
    const spread =
      lerp(heroRect.w / 2 / height, (workspaceRect.w / 2 / height) * 0.9, dawn) * (1 - push * 0.9);
    const toTwist = ease(progress(twistP, 0, 0.5));
    let veil = lerp(0, 0.86, push);
    veil = lerp(veil, 0.62, ease(out));
    veil = lerp(veil, 0.8, ease(progress(asked, 0, 0.2)));
    veil = lerp(veil, 0.34, toTwist);
    veil = lerp(veil, 0, dawn);
    const horizon = -0.25;
    return {
      lampX: lerp(lerp(heroCenter, workspaceCenter, dawn), 0, toEnd),
      lampY: horizon,
      rotation: 0.7 + raw * 0.00011 - ease(progress(twistP, 0.1, 1)) * 1.1,
      trail:
        clamp(Math.abs(velocity) * 0.0006, 0, 0.1) +
        ease(progress(twistP, 0.15, 0.6)) * (1 - ease(progress(twistP, 0.85, 1))) * 0.11,
      dawn,
      horizon,
      veil,
      zoom: lerp(lerp(1, 5.5, push), 1, toTwist),
      lamp: lerp(lerp(0.55, 0.14, push), 0.5, toTwist) * (1 - dawn),
      width: lerp(spread, 0, toEnd),
      aurora:
        lerp(0.72, 0.4, push) +
        ease(progress(twistP, 0.05, 0.45)) * (1 - ease(progress(twistP, 0.8, 1))) * 1.1,
    };
  }

  /* Autoplay */
  type AutoplayState = "idle" | "playing" | "paused" | "done";
  const autoplay: { state: AutoplayState; time: number; lastScroll: number } = {
    state: "idle",
    time: 0,
    lastScroll: 0,
  };
  const PLAY_LABELS: Record<AutoplayState, string> = {
    idle: "Play the story",
    playing: "Pause",
    paused: "Resume",
    done: "Play again",
  };

  const interpolate = (value: number, from: "y" | "t", to: "y" | "t") => {
    for (let index = 1; index < stops.length; index += 1) {
      if (value <= stops[index][from]) {
        const a = stops[index - 1];
        const b = stops[index];
        return lerp(a[to], b[to], (value - a[from]) / Math.max(0.001, b[from] - a[from]));
      }
    }
    return stops[stops.length - 1][to];
  };

  const showPlayState = () => {
    const label = PLAY_LABELS[autoplay.state];
    for (const button of playButtons) {
      button.setAttribute("aria-label", label);
      button.title = label;
      const text = button.querySelector("span");
      if (text) text.textContent = label;
    }
    html.dataset.auto = autoplay.state;
  };

  const pause = () => {
    if (autoplay.state !== "playing") return;
    autoplay.state = "paused";
    showPlayState();
  };

  const togglePlay = () => {
    if (autoplay.state === "playing") {
      pause();
      return;
    }
    if (autoplay.state === "done" || scrollY >= documentHeight - height - 2) {
      scrollTo(0, 0);
      current = -filmTop;
      autoplay.time = 0;
    } else {
      autoplay.time = interpolate(scrollY, "y", "t");
    }
    autoplay.lastScroll = scrollY;
    autoplay.state = "playing";
    showPlayState();
  };

  const onPlayControl = (event: Event) =>
    event.target instanceof Element && event.target.closest("[data-play]") !== null;

  for (const button of playButtons) button.addEventListener("click", togglePlay, { signal });
  const passive = { passive: true, signal };
  addEventListener("wheel", pause, passive);
  addEventListener("touchmove", pause, passive);
  addEventListener(
    "pointerdown",
    (event) => {
      const onCard = event.target instanceof Element && event.target.closest("#card");
      if (!onPlayControl(event) && !onCard) pause();
    },
    passive,
  );
  addEventListener(
    "keydown",
    (event) => {
      if (onPlayControl(event) && (event.key === " " || event.key === "Enter")) return;
      pause();
    },
    { signal },
  );

  /* Jump links */
  const jumpTargets = (hash: string) => {
    const along = (name: Beat, share: number) =>
      beats[name][0] + (beats[name][1] - beats[name][0]) * share;
    const targets: Record<string, number> = {
      "#the-world": along("world", 0.5),
      "#the-team": beats.out[1],
      "#your-decisions": along("ask", 0.25),
      "#the-workspace": along("hints", 0.1),
      "#top": 0,
    };
    return targets[hash];
  };
  for (const link of all<HTMLAnchorElement>(".jumps a, .word")) {
    link.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        pause();
        measure();
        scrollTo(0, filmTop + jumpTargets(link.hash));
      },
      { signal },
    );
  }

  /* After Send answers, glide on to the turn in the story. */
  const glide = { active: false, time: 0, from: 0, to: 0 };
  const GLIDE_SECONDS = 1.4;
  store.setOnSend(() => {
    if (autoplay.state === "playing") return;
    glide.active = true;
    glide.time = 0;
    glide.from = scrollY;
    glide.to = filmTop + beats.ask[1] + 1;
  });
  const cancelGlide = () => {
    glide.active = false;
  };
  addEventListener("wheel", cancelGlide, passive);
  addEventListener("touchmove", cancelGlide, passive);
  addEventListener("keydown", cancelGlide, { signal });

  const unsubscribe = store.subscribe(() => {
    needsPaint = true;
  });

  /* Frame loop */
  let needsPaint = true;
  let current = 0;
  let velocity = 0;
  let lastFrame = performance.now();
  let slowFrames = 0;
  let slowTime = 0;
  let frameRequest = 0;

  function frame(now: number) {
    const elapsed = Math.min(250, now - lastFrame);
    const step = Math.min(64, now - lastFrame);
    lastFrame = now;

    if (autoplay.state === "playing") {
      if (Math.abs(scrollY - autoplay.lastScroll) > 6) {
        pause();
      } else {
        autoplay.time += elapsed / 1000;
        if (autoplay.time >= totalSeconds) {
          autoplay.state = "done";
          showPlayState();
        } else {
          scrollTo(0, interpolate(autoplay.time, "t", "y"));
          autoplay.lastScroll = scrollY;
        }
      }
    }
    if (glide.active) {
      glide.time += step / 1000;
      const amount = ease(clamp(glide.time / GLIDE_SECONDS));
      scrollTo(0, lerp(glide.from, glide.to, amount));
      if (amount >= 1) glide.active = false;
    }

    const raw = scrollY;
    const target = raw - filmTop;
    const previous = current;
    current += (target - current) * (1 - 0.0016 ** ((step / 1000) * 2.2));
    if (Math.abs(target - current) < 0.3) current = target;
    velocity = lerp(velocity, ((current - previous) / Math.max(step, 1)) * 16, 0.2);

    if (current !== previous || needsPaint) {
      needsPaint = false;
      paint(current);
    }
    sky.draw(skyFrame(current, current + filmTop), now / 1000);

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
  let measuredWidth = innerWidth;
  addEventListener(
    "resize",
    () => {
      if (innerWidth !== measuredWidth || !("ontouchstart" in window)) {
        measuredWidth = innerWidth;
        measure();
      }
    },
    { signal },
  );

  measure();
  showPlayState();
  document.fonts.ready.then(() => {
    if (!signal.aborted) measure();
  });
  current = scrollY - filmTop;
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

const SECTION_HASHES = ["#the-world", "#the-team", "#your-decisions", "#the-workspace"];
