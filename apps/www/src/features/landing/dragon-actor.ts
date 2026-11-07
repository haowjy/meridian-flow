import { MARKETING_SKY } from "@meridian/design-tokens/marketing-sky";
import {
  catmullRom,
  DRAGON_HEAD_ANGLE,
  DRAGON_POSES,
  dragonGroundSheet,
  dragonMouth,
  dragonSheet,
  GROUND_FEET,
  GROUND_POSES,
  groundMouth,
} from "./dragon";
import type { Layout } from "./film-layout";
import type { FireFrame } from "./fire";
import { GROUND, onTheShore } from "./ground";
import { GULP_RISE, gulpPhase, rgb } from "./sky";
import {
  along,
  type BeatProgress,
  clamp,
  DAWN,
  DEATH,
  ease,
  envelope,
  FIGHT,
  grounded,
  LORE,
  lerp,
  progress,
  smooth,
  TURN,
} from "./timeline";

type Point = readonly [number, number, number];
/**
 * One point of the dragon's path, in stage pixels at a scroll position. A gliding mark is reached
 * on a curve at an even pace, so a run of them flies without stopping at each.
 */
type Mark = { at: number; x: number; y: number; size: number; facing: number; glide?: boolean };

const BOX = 200;
const ROW_SIZE = 34;
const TURN_RATE = 0.16;
const MAX_LEAN = 0.7;
/** Its size on the ground, in shares of the stage's lesser side: it towers over the party. */
const DESK_STANDING = 0.62;
const PHONE_STANDING = 0.85;
/** How far the burn runs ahead of the mouth, and how far its breath reaches, in stage heights. */
const FRONT_AHEAD = 0.42;
const BREATH_REACH = 0.5;
/** Where the page's picture sits on a phone, in shares of the stage. */
const PHONE_PICTURE_Y = 0.312;
/** Share of the return where the phone dragon settles into the picture's pose (`.s-fig i`). */
const SETTLES_AT = 0.8;
const PICTURE_LEAN = -0.38;
const PICTURE_STROKE = 0.4;
/** The burning words' resolution, per stage pixel. */
const WORDS_SCALE = 2;
/** Matches the `.sys` frame's outer glow in `landing.css`, in CSS pixels. */
const SYSTEM_GLOW = 22;
/** How far ahead of the wall the page's own words hand over to the burning ones, in stage heights. */
const WORDS_HANDOVER = 0.2;
/** The header's height, which the top of the way back stays under. */
const TOP_BAR = 55;
/** The body's rise and fall on each wingbeat, in shares of its size, and its least in stage heights. */
const BOB = 0.1;
const LEAST_BOB = 0.018;
/** The share of the way back after which it comes in front of the product. */
const ENTERS_PRODUCT = 0.93;

/** Where the dragon is this frame, for the fight to aim at and the fire to start from. */
export type Dragon = {
  mouth: readonly [number, number];
  body: { x: number; y: number; size: number };
  burn: FireFrame | null;
};

/** The film's dragon: a speck in the background that grows, burns the page away, then flies on. */
export function createDragonActor(root: HTMLElement) {
  const flyer = root.querySelector("#flyer") as HTMLElement;
  const wings = flyer.firstElementChild as HTMLElement;
  const caption = root.querySelector("#knowledge-base") as HTMLElement;
  const text = document.createRange();
  const words = root.querySelector("#the-death") as HTMLElement;
  const row = root.querySelector("#s-beast-row") as HTMLElement;
  const updraft = root.querySelector("#updraft") as HTMLElement;
  const gulp = updraft.firstElementChild as HTMLElement;
  root.style.setProperty("--dragon-sheet", `url(${dragonSheet().toDataURL()})`);
  root.style.setProperty("--dragon-ground", `url(${dragonGroundSheet().toDataURL()})`);
  root.style.setProperty("--cold-fire", rgb(MARKETING_SKY.fireBody));
  root.style.setProperty("--cold-fire-core", rgb(MARKETING_SKY.fireCore));

  let marks: Mark[] = [];
  let unit = 0;
  let way: Point[] = [];
  let layout: Layout;
  let lastAt = 0;
  let breath = 0;
  let facing = 1;
  let lean = 0;
  let mouth: readonly [number, number] = [0, 0];
  let headUp = 0;

  const measure = (next: Layout) => {
    layout = next;
    const { spans, width: W, height: H } = next;
    unit = Math.min(H, W * 0.62);
    // Where it stands on the shore; phones have no room for the party to give ground, so it holds
    // its place there.
    const fightX = (share: number) => (next.isPhone ? 0.78 : onTheShore(share));
    // A phone's stage is narrow, so its lesser side is short beside the party: it stands bigger.
    const standing = next.isPhone ? PHONE_STANDING : DESK_STANDING;
    // Stood on the beach: its feet on the sand, whatever its size.
    const onShore = (size: number) => GROUND.beach - (GROUND_FEET * size * unit) / H;
    const mark = (
      at: number,
      x: number,
      y: number,
      size: number,
      turn = 1,
      glide = false,
    ): Mark => ({
      at,
      x: x * W,
      y: y * H,
      size: size * unit,
      facing: turn,
      glide,
    });
    marks = [
      mark(0, 0.37, 0.13, 0.01, -1),
      mark(along(spans, "hold", 1), 0.37, 0.13, 0.01, -1),
      // Out left along the aurora while the product fades, then back right across the open sky,
      // in view the whole way.
      mark(along(spans, "push", 0.45), 0.16, 0.17, 0.016, -1, true),
      mark(along(spans, "push", 1), 0.36, 0.27, 0.024, 1, true),
      mark(along(spans, "sky", 0.5), 0.62, 0.3, 0.04, 1, true),
      mark(along(spans, "sky", 1), 0.75, 0.26, 0.05, -1),
      mark(along(spans, "world", 0.5), 0.5, 0.2, 0.055, -1),
      mark(along(spans, "world", 1), 0.25, 0.24, 0.065),
      mark(along(spans, "write", 0.5), 0.55, 0.18, 0.075),
      mark(along(spans, "write", 1), 0.8, 0.24, 0.085, -1),
      mark(along(spans, "out", 1), 0.4, 0.2, 0.1, -1),
      mark(along(spans, "back", 1), 0.7, 0.26, 0.13),
      mark(along(spans, "turn", 0.3), 0.9, 0.34, 0.2, -1),
      mark(along(spans, "turn", TURN.lands), fightX(0.79), onShore(standing), standing, -1),
      // It presses in as they give ground, rears back when the spark lands, then comes down
      // again for the breath that kills them.
      mark(
        along(spans, "fight", FIGHT.spark.eye[1]),
        fightX(0.74),
        onShore(standing),
        standing,
        -1,
      ),
      mark(
        along(spans, "fight", FIGHT.spark.eye[1] + 0.05),
        fightX(0.82),
        onShore(standing) - 0.1,
        standing * 1.08,
        -1,
      ),
      mark(along(spans, "fight", FIGHT.breath[0]), fightX(0.69), onShore(standing), standing, -1),
      mark(spans.flight[0], fightX(0.69), onShore(standing), standing, -1),
      // Up behind the box, one loop small in the far sky, and out at the left to turn.
      mark(along(spans, "flight", DEATH.loop[0]), 0.72, 0.4, 0.2, -1, true),
      mark(along(spans, "flight", DEATH.loop[1]), 0.5, 0.17, 0.1, -1, true),
      mark(along(spans, "flight", DEATH.loop[2]), 0.26, 0.2, 0.11, -1, true),
      mark(spans.burn[0], -0.18, 0.42, 0.3, -1, true),
      mark(along(spans, "burn", DEATH.reveals), -0.35, 0.58, 0.66),
      mark(along(spans, "burn", DEATH.exits), 1.4, 0.46, 0.8),
    ];
    way = wayBack(next);
  };

  /**
   * Back in at the right where it left the burn, climbing away behind the product, small along the top, then down the
   * left of the headline wherever it sits. Each point is x, y and size in stage pixels.
   */
  const wayBack = ({ width: W, height: H, workspace, isPhone }: Layout) => {
    // A phone has no Knowledge Base row: it lands in the picture on the page that opens.
    if (isPhone) {
      return [
        [W + unit * 0.5, H * 0.44, unit * 0.6],
        [W * 0.84, H * 0.22, unit * 0.34],
        [W * 0.5, H * 0.17, unit * 0.2],
        [W * 0.14, H * 0.22, unit * 0.26],
        [W * 0.1, H * 0.36, unit * 0.34],
        [W * 0.5, H * PHONE_PICTURE_Y, unit * 0.68],
      ] satisfies Point[];
    }
    text.selectNodeContents(caption);
    const words = text.getBoundingClientRect();
    const stage = flyer.parentElement?.getBoundingClientRect();
    const originY = stage?.top ?? 0;
    const originX = stage?.left ?? 0;
    const right = workspace.x + workspace.w;
    const margin = (right + W) / 2;
    const top = (TOP_BAR + workspace.y) / 2;
    const left = Math.max(words.left - originX - W * 0.03, unit * 0.05);
    const inner = (words.right - originX + workspace.x) / 2;
    const above = Math.max(words.top - originY - H * 0.05, TOP_BAR + unit * 0.08);
    const below = words.bottom - originY + H * 0.05;
    const across = (share: number) => lerp(left, inner, share);
    const down = (share: number) => lerp(above, below, share);
    const size = (share: number) => share * unit;
    return [
      [W + unit * 0.55, H * 0.44, size(0.72)],
      [margin + W * 0.02, H * 0.34, size(0.38)],
      [margin, H * 0.19, size(0.15)],
      [right - W * 0.04, top, size(0.09)],
      [lerp(right, left, 0.35), top, size(0.085)],
      [lerp(right, left, 0.7), top, size(0.085)],
      [across(0.3), lerp(top, above, 0.6), size(0.1)],
      [left, down(0.5), size(0.14)],
      [across(0.2), below + H * 0.03, size(0.14)],
      [across(0.65), below + H * 0.07, size(0.13)],
    ] satisfies Point[];
  };

  /** The big words drawn where they stand, so the fire can burn them letter by letter. */
  const wordsStill = () => {
    const { width: W, height: H } = layout;
    const canvas = document.createElement("canvas");
    canvas.width = W * WORDS_SCALE;
    canvas.height = H * WORDS_SCALE;
    const pen = canvas.getContext("2d") as CanvasRenderingContext2D;
    pen.scale(WORDS_SCALE, WORDS_SCALE);
    const scaled = words.style.transform;
    words.style.transform = "none";
    const stage = flyer.parentElement?.getBoundingClientRect();
    const left = stage?.left ?? 0;
    const top = stage?.top ?? 0;
    // The System window under the words, so the fire chars its frame and field too.
    for (const frame of words.querySelectorAll<HTMLElement>(".sys")) {
      const style = getComputedStyle(frame);
      const box = frame.getBoundingClientRect();
      const border = Number.parseFloat(style.borderTopWidth);
      const inset = border / 2;
      pen.beginPath();
      pen.roundRect(
        box.left - left + inset,
        box.top - top + inset,
        box.width - border,
        box.height - border,
        Number.parseFloat(style.borderTopLeftRadius),
      );
      pen.fillStyle = style.backgroundColor;
      pen.fill();
      pen.shadowColor = style.borderTopColor;
      pen.shadowBlur = SYSTEM_GLOW;
      pen.lineWidth = border;
      pen.strokeStyle = style.borderTopColor;
      pen.stroke();
      pen.shadowBlur = 0;
    }
    const nodes = document.createTreeWalker(words, NodeFilter.SHOW_TEXT);
    while (nodes.nextNode()) {
      const node = nodes.currentNode as Text;
      const style = getComputedStyle(node.parentElement as Element);
      pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      pen.fillStyle = style.color;
      const metrics = pen.measureText("x");
      const tall = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
      for (const word of node.data.matchAll(/\S+/g)) {
        text.setStart(node, word.index);
        text.setEnd(node, word.index + word[0].length);
        const box = text.getBoundingClientRect();
        const baseline = box.top + (box.height - tall) / 2 + metrics.fontBoundingBoxAscent;
        pen.fillText(word[0], box.left - left, baseline - top);
      }
    }
    words.style.transform = scaled;
    return canvas;
  };

  const place = (at: number) => {
    let index = 1;
    while (index < marks.length - 1 && marks[index].at < at) index += 1;
    const from = marks[index - 1];
    const to = marks[index];
    if (to.glide) {
      const t = progress(at, from.at, to.at);
      const before = marks[Math.max(0, index - 2)];
      const after = marks[Math.min(marks.length - 1, index + 1)];
      return {
        x: catmullRom(before.x, from.x, to.x, after.x, t),
        y: catmullRom(before.y, from.y, to.y, after.y, t),
        size: lerp(from.size, to.size, t),
        facing: lerp(from.facing, to.facing, t),
      };
    }
    const t = ease(progress(at, from.at, to.at));
    return {
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      size: lerp(from.size, to.size, t),
      facing: lerp(from.facing, to.facing, t),
    };
  };

  const returning = (t: number) => {
    const { width: W, height: H } = layout;
    const box = row.getBoundingClientRect();
    const rowY = box.top + box.height / 2;
    const path: Point[] = layout.isPhone
      ? way
      : [
          ...way,
          [box.left - W * 0.05, rowY + H * 0.03, unit * 0.1],
          [box.left + box.width * 0.2, rowY, ROW_SIZE],
        ];
    const scaled = t * (path.length - 1);
    const i = Math.min(Math.floor(scaled), path.length - 2);
    const p = (k: number) => path[clamp(k, 0, path.length - 1)];
    return {
      x: catmullRom(p(i - 1)[0], p(i)[0], p(i + 1)[0], p(i + 2)[0], scaled - i),
      y: catmullRom(p(i - 1)[1], p(i)[1], p(i + 1)[1], p(i + 2)[1], scaled - i),
      size: lerp(p(i)[2], p(i + 1)[2], scaled - i),
    };
  };

  const pose = (at: number) => {
    const placed = place(at);
    const { spans } = layout;
    if (at < along(spans, "burn", DEATH.exits)) return { ...placed, onTop: false, settled: 0 };
    const t = progress(at, along(spans, "dawn", DAWN.returns), along(spans, "lore", LORE.arrives));
    return {
      ...placed,
      ...returning(t),
      onTop: layout.isPhone || t > ENTERS_PRODUCT,
      settled: layout.isPhone ? smooth(t, SETTLES_AT, 1) : 0,
    };
  };

  const fly = (seconds: number, at: number, beats: BeatProgress) => {
    const now = pose(at);
    const ahead = pose(at + 30);
    const dx = ahead.x - now.x;
    const dy = ahead.y - now.y;
    const moving = Math.hypot(dx, dy) > 0.6;
    const circled = beats.burn >= DEATH.exits;
    const passing = beats.burn >= DEATH.reveals && !circled;
    const landing = beats.turn >= TURN.descends;
    flyer.style.zIndex = `var(--z-${passing ? "pass" : now.onTop ? "over" : circled || landing ? "low" : "far"})`;
    // It faces where it flies, except in the face-off, where it keeps its eyes on the party even
    // as it rears back.
    const facingThem = landing && beats.flight <= 0;
    const wanted = !facingThem && moving && Math.abs(dx) > 0.3 ? Math.sign(dx) : now.facing;
    facing += (wanted - facing) * TURN_RATE;
    const tilt = moving ? clamp(Math.atan2(dy, Math.abs(dx) + 1), -MAX_LEAN, MAX_LEAN) : 0;
    // On the ground it stands still with its wings folded; perched, its head rises to the sky.
    const onGround = grounded(beats);
    flyer.classList.toggle("grounded", onGround);
    const wantedLean = onGround
      ? 0
      : lerp(tilt * Math.sign(facing || 1), PICTURE_LEAN, now.settled);
    lean += (wantedLean - lean) * TURN_RATE;
    const beating = (1 - Math.cos(seconds * (moving ? 10 : 7))) / 2;
    const wave = lerp(beating, PICTURE_STROKE, now.settled);
    const beat = Math.max(now.size * BOB, layout.height * LEAST_BOB);
    const bob = onGround ? 0 : Math.sin(seconds * 1.3) * 0.05 * now.size - (wave - 0.5) * 2 * beat;
    const scale = now.size / BOX;
    const shown = Math.abs(facing) < 0.12 ? 0.12 * (facing < 0 ? -1 : 1) : facing;
    const stretch = onGround ? 1 : 1 + (wave - 0.5) * 0.06;
    flyer.style.transform = `translate3d(${now.x - BOX / 2}px,${now.y + bob - BOX / 2}px,0) rotate(${lean}rad) scale(${shown * scale},${scale * stretch})`;
    const raised = Math.round(envelope(beats.turn, TURN.perch, 0.03, 0.04) * (GROUND_POSES - 1));
    const poses = onGround ? GROUND_POSES : DRAGON_POSES;
    const cell = onGround ? raised : Math.round(wave * (DRAGON_POSES - 1));
    const frame = cell / (poses - 1);
    const [offsetX, offsetY] = onGround ? groundMouth(frame) : dragonMouth(frame);
    headUp = onGround ? frame : 0;
    const localX = offsetX * now.size * shown;
    const localY = offsetY * now.size * stretch;
    mouth = [
      now.x + localX * Math.cos(lean) - localY * Math.sin(lean),
      now.y + bob + localX * Math.sin(lean) + localY * Math.cos(lean),
    ];
    wings.style.maskPosition = `${frame * 100}% 0`;
  };

  /**
   * Perched with its head raised, it sends the Cold Fire straight up in gulps: a column from its
   * mouth to the top of the stage, and a bright knot rising through it that swells the aurora as
   * it arrives (`gulpPhase` in `sky.ts`).
   */
  const rise = (seconds: number, strength: number) => {
    updraft.style.opacity = String(strength);
    if (strength <= 0) return;
    const phase = gulpPhase(seconds);
    const up = clamp(phase / GULP_RISE);
    const width = layout.height * 0.05;
    updraft.style.width = `${width}px`;
    updraft.style.height = `${mouth[1]}px`;
    updraft.style.transform = `translate3d(${mouth[0] - width / 2}px,0,0)`;
    updraft.style.setProperty("--gulp", String(Math.exp(-phase * 4)));
    gulp.style.opacity = phase < GULP_RISE ? String(1 - smooth(up, 0.75, 1)) : "0";
    gulp.style.transform = `translate3d(0,${mouth[1] * (1 - up)}px,0) translate(0,-50%) scale(${0.7 + up * 0.6})`;
  };

  return {
    measure,
    wordsStill,
    /**
     * Runs every frame: the scroll position picks the scene, the clock animates it. Returns where
     * its mouth and body are, and the burn's fire while it crosses the box.
     */
    update(seconds: number, at: number, beats: BeatProgress): Dragon {
      const { burn: burnP, lore } = beats;
      const { height: H } = layout;
      const shown = lore < LORE.arrives;
      flyer.style.opacity = shown ? "1" : "0";
      if (shown) fly(seconds, at, beats);

      const moved = Math.abs(at - lastAt);
      lastAt = at;
      const passing = burnP > DEATH.reveals && burnP < DEATH.exits;
      const wanted = shown && passing ? Math.min(1, moved / 10) : 0;
      breath += (wanted - breath) * (wanted > breath ? 0.5 : 0.09);
      if (breath < 0.01) breath = 0;

      const placed = pose(at);
      const char = (placed.x + placed.size * 0.43 + unit * FRONT_AHEAD) / H;
      const burnt = () => {
        const box = words.getBoundingClientRect();
        return clamp(((char + WORDS_HANDOVER) * H - box.left) / box.width);
      };
      const edge = burnP >= DEATH.exits ? 1 : passing ? burnt() : 0;
      words.style.zIndex = passing ? "var(--z-pass-words)" : "";
      words.style.maskImage =
        edge > 0
          ? `linear-gradient(90deg,transparent ${edge * 106 - 3}%,black ${edge * 106 + 3}%)`
          : "none";

      const angle = lean + DRAGON_HEAD_ANGLE;
      rise(
        seconds,
        shown ? smooth(headUp, 0.6, 1) * envelope(beats.turn, TURN.perch, 0.03, 0.04) : 0,
      );
      const burn: FireFrame | null = passing
        ? {
            mouth,
            aim: [
              mouth[0] + unit * BREATH_REACH * Math.cos(angle),
              mouth[1] + unit * BREATH_REACH * Math.sin(angle),
            ],
            breath,
            char,
            time: at / H + seconds * 0.5,
          }
        : null;
      return { mouth, body: placed, burn };
    },
  };
}
