import type { CardStore } from "./card-store";
import { createDragonActor } from "./dragon-actor";
import { createFight } from "./fight";
import { type FilmParts, type Layout, measureLayout } from "./film-layout";
import { createFire } from "./fire";
import { createForest } from "./forest";
import type { ProductSlot } from "./ProductPlaceholder";
import { createSky, STILL_SKY, skyFrame } from "./sky";
import {
  ASK,
  type BeatProgress,
  beatProgress,
  CAMP,
  clamp,
  ease,
  lerp,
  progress,
  SECTIONS,
  smooth,
  TURN,
  TWIST,
  WORLD_TYPED,
  WRITE_TYPED,
} from "./timeline";
import { createTransport } from "./transport";

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

  fill(rest, 0, characters.length);

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
  const end = root.querySelector("#end") as HTMLElement;
  const stopListening = store.onSend(() => end.scrollIntoView());
  signal.addEventListener("abort", stopListening);
  const reached = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) store.assignIfUnanswered();
  });
  reached.observe(end);
  signal.addEventListener("abort", () => reached.disconnect());
  for (const button of root.querySelectorAll("[data-rekindle]")) {
    button.addEventListener(
      "click",
      () => {
        store.reset();
        root.querySelector("#the-world")?.scrollIntoView();
      },
      { signal },
    );
  }
  const sky = createSky(root.querySelector("#sky") as HTMLCanvasElement, signal);
  const render = () => {
    sky.resize();
    sky.draw(STILL_SKY, 0);
  };
  render();
  addEventListener("resize", render, { signal });
}

/** The product's height over its width. */
const BLOCK_ASPECT = 0.62;
/** Just under the phone header, where the fire reveals the product. */
const PHONE_REVEAL_TOP = 62;
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
  const caption = one("#knowledge-base");
  const captionShade = one("#capshade");
  const ask = one("#your-decisions");
  const skill = one("#skill");
  const question = one(".s-take");
  const card = one("#card");
  const world = one("#the-world");
  const worldNotes = all(".wn");
  const agents = all(".ag");
  const subtitles = all(".sub li");
  const jumpLinks = all<HTMLAnchorElement>(".jumps a");
  const sectionLabel = one("#herel");
  const parts: FilmParts = {
    stage: one(".stage"),
    blockHome: one(".slotwrap"),
    workspaceSpot: one(".workspot"),
    block: slot.element,
    chapterOpening: one(".open"),
    lastTypedParagraph: one("#p3"),
    turnParagraph: one("#p4"),
    hub: one(".hub"),
    agents,
    teamLines: one<SVGSVGElement>("#lines"),
    worldNotes,
    worldLines: one<SVGSVGElement>("#wlines"),
  };

  const actor = createDragonActor(root);
  const forest = createForest(root);
  const fight = createFight(root);
  const fire = createFire(one<HTMLCanvasElement>("#flame"));
  const skyCanvas = one<HTMLCanvasElement>("#sky");
  const sky = createSky(skyCanvas, signal);
  const typers = [
    typewriter(one("#ty1"), "ai"),
    typewriter(one("#ty2"), "ai"),
    typewriter(one("#ty3"), "me"),
  ] as const;
  const turnTyper = typewriter(one("#ty4"), "me");
  const worldTypers = ["#w0", "#w1", "#w2", "#w3"].map((id) => typewriter(one(id), "me"));
  const allTypers = [...typers, turnTyper, ...worldTypers];

  let layout: Layout = measureLayout(parts);
  let current = 0;
  let needsPaint = true;
  const measureLayers = () => {
    actor.measure(layout);
    forest.measure(layout);
    fight.measure(layout);
    fire?.resize(layout.width, layout.height);
  };
  measureLayers();
  const measure = () => {
    const scrollEnd = layout.documentHeight - layout.height;
    const share = scrollY / scrollEnd;
    layout = measureLayout(parts);
    nightKept = false;
    measureLayers();
    sky.resize();
    needsPaint = true;
    // The film's length follows the window's height: keep the visitor's place in the story.
    const nextEnd = layout.documentHeight - layout.height;
    if (nextEnd !== scrollEnd) {
      scrollTo(0, share * nextEnd);
      current = scrollY;
    }
  };

  function paint(at: number, beats: BeatProgress) {
    const { spans, height, width, home, workspace, blockLayoutWidth, isPhone } = layout;
    const { world: worldBeat, open, out, back, ask: asked, turn, twist: twistP } = beats;
    const worldP = progress(worldBeat, 0, WORLD_TYPED);
    const write = progress(beats.write, 0, WRITE_TYPED);
    const { dawn: dawnP, hints, leave } = beats;
    const push = ease(beats.push);
    const askLift = smooth(asked, ...ASK.lift);

    show(hero, 1 - clamp(push * 2.4));
    hero.style.transform = `translateY(${-push * 70}px)`;

    let x: number;
    let y: number;
    let blockWidth: number;
    let opacity: number;
    let grade: number;
    if (twistP < TWIST.reveals) {
      blockWidth = home.w * lerp(1, 2.5, push);
      x = lerp(home.x, width / 2 - blockWidth * 0.5, push);
      y = lerp(home.y, height * 0.5 - blockWidth * 0.3, push);
      opacity = 1 - clamp((push - 0.25) / 0.55);
      grade = lerp(0.84, 0.3, push);
    } else {
      const returned = 1 - ease(smooth(asked, 0, 0.1));
      const settle = ease(smooth(dawnP, 0.5, 0.8)) * returned;
      const barHeight = 55;
      const fullWidth = Math.min(width * 0.94, (height - barHeight - 44) / BLOCK_ASPECT);
      blockWidth = lerp(fullWidth, workspace.w, settle);
      x = lerp((width - fullWidth) / 2, workspace.x, settle);
      y = lerp((height + barHeight - fullWidth * BLOCK_ASPECT) / 2, workspace.y, settle);
      opacity = 1;
      grade = 1 - askLift * (1 - smooth(asked, 0.89, 1)) * 0.3;
      if (isPhone) {
        // No room beside the headline, so the product fills the screen and then slides down for it.
        blockWidth = workspace.w;
        x = workspace.x;
        y = lerp(PHONE_REVEAL_TOP, workspace.y, ease(smooth(beats.lore, 0.06, 0.24)) * returned);
      }
      if (leave > 0) {
        const away = ease(leave);
        y += away * height * 0.75;
        opacity *= 1 - away;
      }
    }
    const block = slot.element;
    const stretched = isPhone && twistP >= TWIST.reveals && leave <= 0;
    block.style.height = stretched
      ? `${((height - y - 12) * blockLayoutWidth) / blockWidth}px`
      : "";
    block.style.transform = `translate3d(${x - home.x}px,${y - home.y}px,0) scale(${blockWidth / blockLayoutWidth})`;
    show(block, opacity);
    block.style.filter =
      grade < 0.995
        ? `brightness(${grade.toFixed(3)}) saturate(${(1 - (1 - grade) * 0.5).toFixed(3)})`
        : "none";
    block.inert = !(push < 0.08 || (dawnP > 0.7 && leave < 0.05));
    if (hints > 0) slot.set("hints", progress(hints, 0.08, 0.95));
    else if (asked > 0) slot.set("ask", 0);
    else if (beats.lore > 0) slot.set("lore", beats.lore);
    else slot.set(twistP < TWIST.reveals ? "start" : "team", 0);

    show(world, smooth(beats.sky, 0.9, 1) * (1 - smooth(worldBeat, 0.9, 1)));
    worldTypers.forEach((typer, index) => {
      const from = 0.04 + index * 0.18;
      typer.set(progress(worldP, from, from + 0.22), worldP >= from && worldP < from + 0.22);
      (worldNotes[index].firstElementChild as HTMLElement).style.opacity =
        worldP > from ? "1" : "0";
      const line = layout.worldLines[index - 1];
      if (line) {
        line.path.style.strokeDashoffset = String(
          line.length * (1 - smooth(worldP, from, from + 0.2)),
        );
        line.dot.style.opacity = worldP > from ? "1" : "0";
      }
    });

    const chapterIn = smooth(open, 0, 0.7);
    const chapterDim = turn > 0 ? smooth(turn, 0, 0.16) : 1 - smooth(out, 0, 0.28);
    // The chapter gives way just before it breathes, so the perch has the screen.
    const chapterGone = smooth(turn, TURN.perch[0] - 0.08, TURN.perch[0]);
    show(chapter, chapterIn * chapterDim * (1 - chapterGone));
    const chapterOffset = lerp(
      lerp(layout.chapterFrom, layout.chapterTo, ease(write) * 0.3 + write * 0.7),
      layout.turn,
      smooth(turn, 0, 0.3),
    );
    chapter.style.transform = `translate3d(0,${-chapterOffset}px,0)`;
    typers[0].set(progress(write, 0.04, 0.42), write > 0.02 && write < 0.42);
    typers[1].set(progress(write, 0.42, 0.9), write >= 0.42 && write < 0.9);
    typers[2].set(progress(write, 0.5, 0.98), write >= 0.5 && write < 0.985);

    const askGone = smooth(asked, ASK.assigns, 1);
    show(ask, clamp(askLift * 5) * (1 - askGone));
    block.classList.toggle("s-lifted", askLift > 0);
    if (askLift > 0 && askLift < 1) {
      const from = question.getBoundingClientRect();
      const box = ask.getBoundingClientRect();
      const offsetX = (from.left - box.left - card.offsetLeft) * (1 - askLift);
      const offsetY = (from.top - box.top - card.offsetTop) * (1 - askLift);
      const scale = lerp(from.width / card.offsetWidth, 1, askLift);
      card.style.transform = `translate(${offsetX}px,${offsetY}px) scale(${scale})`;
    } else {
      card.style.transform = `translateY(${askGone * 18}px)`;
    }
    turnTyper.set(progress(turn, 0.12, 0.44), turn > 0.09 && turn < 0.44);

    const fade = height * 0.035;
    for (const subtitle of subtitles) {
      const [from, to] = layout.subtitles[subtitle.dataset.b as string];
      const shown = progress(at, from, from + fade) * (1 - progress(at, to - fade, to));
      show(subtitle, shown);
      subtitle.style.transform = `translateY(${(1 - shown) * 8}px)`;
    }

    const teamShown = smooth(out, 0, 0.3) * (1 - smooth(beats.camp, 0, CAMP.sits[1]));
    show(team, teamShown);
    const reportWindows = [
      [0.1, 0.62],
      [0.3, 0.78],
      [0.2, 0.7],
      [0.05, 0.92],
    ];
    agents.forEach((agent, index) => {
      agent.style.opacity = String(
        isPhone ? 1 : smooth(out, 0.25 + index * 0.12, 0.5 + index * 0.12),
      );
      const [leaves, returns] = reportWindows[index];
      agent.classList.toggle("back", back >= returns);
      const line = layout.teamLines[index];
      if (!line || teamShown === 0) return;
      const drawn = smooth(out, 0.1 + index * 0.08, 0.8 + index * 0.04);
      line.path.style.strokeDashoffset = String(line.length * (1 - drawn));
      const returned = progress(back, leaves, returns);
      const point = line.path.getPointAtLength(line.length * (out < 1 ? drawn : 1 - returned));
      line.dot.setAttribute("cx", String(point.x));
      line.dot.setAttribute("cy", String(point.y));
      line.dot.style.opacity = out > 0 && (returned < 1 || out < 1) ? "1" : "0";
    });

    // The System window doesn't fade in: it opens all at once, the way a status window does.
    skill.classList.toggle("on", beats.skill > 0.04 && leave < 0.5);

    // The box opens the way the System's windows do: from a bright line, all at once.
    const opened = smooth(twistP, 0.03, 0.1);
    show(twist, smooth(twistP, 0.02, 0.04) * (1 - smooth(twistP, 0.95, 1)));
    twist.style.transform =
      opened < 1 ? `scale(${lerp(0.03, 1, opened)},${lerp(0.4, 1, opened)})` : "";
    twist.style.filter = opened < 1 ? `brightness(${lerp(2.4, 1, opened)})` : "";

    const captionShown =
      (isPhone ? smooth(beats.lore, 0.2, 0.4) : smooth(beats.lore, 0.08, 0.32)) *
      (1 - smooth(asked, 0, 0.06));
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

  let lastFrame = performance.now();
  let slowFrames = 0;
  let slowTime = 0;
  let frameRequest = 0;

  const transport = createTransport({
    root,
    store,
    getLayout: () => layout,
    onJump: () => {
      current = scrollY;
      needsPaint = true;
    },
    signal,
  });
  let nightKept = false;

  function frame(now: number) {
    const elapsed = Math.min(250, now - lastFrame);
    const step = Math.min(64, now - lastFrame);
    lastFrame = now;
    transport.advance(elapsed);

    const target = scrollY;
    const previous = current;
    current += (target - current) * (1 - 0.0016 ** ((step / 1000) * 2.2));
    if (Math.abs(target - current) < 0.3) current = target;

    const beats = beatProgress(current, layout.spans);
    // Before the night is kept: its still takes the trees from where they stand now.
    const party = forest.update(current, beats);
    if (!nightKept && beats.twist > 0.2) {
      const [start, end] = layout.spans.twist;
      const lastNight = lerp(start, end, TWIST.reveals) - 1;
      sky.draw(
        skyFrame(beatProgress(lastNight, layout.spans), lastNight / layout.height),
        now / 1000,
      );
      fire?.keepNight(forest.withTrees(skyCanvas));
      fire?.keepWords(actor.wordsStill());
      nightKept = true;
      needsPaint = true;
    }
    const dragon = actor.update(now / 1000, current, beats);
    fire?.draw(fight.update(now / 1000, current, beats, party, dragon) ?? dragon.burn);
    if (beats.ask >= ASK.assigns) store.assignIfUnanswered();
    else store.withdrawPass();
    if (current !== previous || needsPaint) {
      needsPaint = false;
      paint(current, beats);
      sky.draw(skyFrame(beats, current / layout.height), now / 1000);
      slowTime += step;
      slowFrames += 1;
      if (slowFrames === 40) {
        if (slowTime / slowFrames > 30 && sky.lowerResolution()) needsPaint = true;
        slowFrames = 0;
        slowTime = 0;
      }
    } else {
      sky.breathe(now / 1000);
    }
    frameRequest = requestAnimationFrame(frame);
  }

  // A phone's address bar resizes the window but not the stage, which is `100svh`.
  addEventListener(
    "resize",
    () => {
      if (html.clientWidth !== layout.windowWidth || parts.stage.clientHeight !== layout.height) {
        measure();
      }
    },
    { signal },
  );

  sky.resize();
  document.fonts.ready.then(() => {
    if (!signal.aborted) measure();
  });
  current = scrollY;
  html.classList.add("film-ready");
  frameRequest = requestAnimationFrame(frame);

  return () => {
    controller.abort();
    cancelAnimationFrame(frameRequest);
    for (const typer of allTypers) typer.restore();
    html.classList.remove("cine", "film-ready");
    delete html.dataset.auto;
    html.style.removeProperty("--filmh");
  };
}
