import { catmullRom, DRAGON_HEAD_ANGLE, DRAGON_POSES, dragonMouth, dragonSheet } from "./dragon";
import type { Layout } from "./film-layout";
import { createFire } from "./fire";
import type { Party } from "./forest";
import { type BeatProgress, clamp, ease, FIGHT, lerp, progress, smooth } from "./timeline";

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
/** The sweep, as shares of the twist: it leaves left, comes back and crosses, pushing the burn. */
export const REVEAL_STARTS = 0.6;
const PASS = { leaves: 0.55, enters: REVEAL_STARTS, exits: 0.92 };
/** How far the burn runs ahead of the mouth, and how far its breath reaches, in stage heights. */
const FRONT_AHEAD = 0.42;
const BREATH_REACH = 0.5;
/** A wall past the right edge of the stage: the fire draws only the breath. */
const NO_WALL = 100;
/** The fight's breaths: how hard, and what share of the way to the party they reach. */
const FIGHT_BREATH = 0.85;
/** How long a hit's flash lasts, in shares of the fight beat. */
const HIT_LASTS = 0.035;
/** How high the spark arcs, in stage heights. */
const SPARK_ARC = 0.14;
/** How far into the dawn it comes back. */
const RETURN_STARTS = 0.1;
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
/** How far through its beat the dragon reaches the knowledge base. */
export const LORE_ARRIVES = 0.05;

const span = (spans: Layout["spans"], name: keyof Layout["spans"], share: number) =>
  spans[name][0] + (spans[name][1] - spans[name][0]) * share;

const fightWindow = (value: number, [from, to]: readonly [number, number]) =>
  smooth(value, from, from + 0.03) * (1 - smooth(value, to - 0.04, to));

/** The film's dragon: a speck in the background that grows, burns the page away, then flies on. */
export function createDragonActor(root: HTMLElement) {
  const flyer = root.querySelector("#flyer") as HTMLElement;
  const wings = flyer.firstElementChild as HTMLElement;
  const fire = createFire(root.querySelector("#flame") as HTMLCanvasElement);
  const caption = root.querySelector("#knowledge-base") as HTMLElement;
  const text = document.createRange();
  const words = root.querySelector("#the-twist") as HTMLElement;
  const row = root.querySelector("#s-beast-row") as HTMLElement;
  const shot = (name: string) => root.querySelector(`#walkers .${name}`) as HTMLElement;
  const spark = shot("spark");
  const arrow = shot("arrow");
  const song = shot("song");
  const hit = shot("hit");
  root.style.setProperty("--dragon-sheet", `url(${dragonSheet().toDataURL()})`);

  let marks: Mark[] = [];
  let unit = 0;
  let way: Point[] = [];
  let layout: Layout;
  let lastAt = 0;
  let breath = 0;
  let facing = 1;
  let lean = 0;
  let mouth: readonly [number, number] = [0, 0];

  const measure = (next: Layout) => {
    layout = next;
    const { spans, width: W, height: H } = next;
    unit = Math.min(H, W * 0.62);
    fire?.resize(W, H);
    // Phones have no room for the party to give ground, so the dragon holds its place there.
    const fightX = (x: number) => (next.isPhone ? 0.84 : x);
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
      mark(span(spans, "hold", 1), 0.37, 0.13, 0.01, -1),
      mark(span(spans, "push", 1), 0.58, 0.3, 0.022, -1),
      mark(span(spans, "sky", 0.5), 0.66, 0.3, 0.04, -1),
      mark(span(spans, "sky", 1), 0.75, 0.26, 0.05, -1),
      mark(span(spans, "world", 0.5), 0.5, 0.2, 0.055, -1),
      mark(span(spans, "world", 1), 0.25, 0.24, 0.065),
      mark(span(spans, "write", 0.5), 0.55, 0.18, 0.075),
      mark(span(spans, "write", 1), 0.8, 0.24, 0.085, -1),
      mark(span(spans, "out", 1), 0.4, 0.2, 0.1, -1),
      mark(span(spans, "back", 1), 0.7, 0.26, 0.13),
      mark(span(spans, "turn", 0.45), 0.9, 0.34, 0.2, -1),
      mark(span(spans, "turn", 1), 0.84, 0.76, 0.4, -1),
      // It presses in as they give ground, rears back when the spark lands, then comes down
      // again for the breath that kills them.
      mark(span(spans, "fight", FIGHT.spark.at[1]), fightX(0.77), 0.76, 0.4, -1),
      mark(span(spans, "fight", FIGHT.spark.at[1] + 0.05), fightX(0.83), 0.66, 0.44, -1),
      mark(span(spans, "fight", FIGHT.breath[0]), fightX(0.72), 0.75, 0.41, -1),
      mark(span(spans, "twist", 0.22), fightX(0.72), 0.76, 0.4, -1),
      // Up behind the box, one loop small in the far sky, and out at the left to turn.
      mark(span(spans, "twist", 0.31), 0.72, 0.4, 0.2, -1, true),
      mark(span(spans, "twist", 0.39), 0.5, 0.17, 0.1, -1, true),
      mark(span(spans, "twist", 0.46), 0.26, 0.2, 0.11, -1, true),
      mark(span(spans, "twist", PASS.leaves), -0.18, 0.42, 0.3, -1, true),
      mark(span(spans, "twist", PASS.enters), -0.35, 0.58, 0.66),
      mark(span(spans, "twist", PASS.exits), 1.4, 0.46, 0.8),
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
    if (at < span(spans, "twist", PASS.exits)) return { ...placed, onTop: false, settled: 0 };
    const t = progress(at, span(spans, "dawn", RETURN_STARTS), span(spans, "lore", LORE_ARRIVES));
    return {
      ...placed,
      ...returning(t),
      onTop: layout.isPhone || t > ENTERS_PRODUCT,
      settled: layout.isPhone ? smooth(t, SETTLES_AT, 1) : 0,
    };
  };

  const fly = (seconds: number, at: number) => {
    const now = pose(at);
    const ahead = pose(at + 30);
    const dx = ahead.x - now.x;
    const dy = ahead.y - now.y;
    const moving = Math.hypot(dx, dy) > 0.6;
    const { spans } = layout;
    const circled = at >= span(spans, "twist", PASS.exits);
    const passing = at >= span(spans, "twist", PASS.enters) && !circled;
    const landing = at >= span(spans, "turn", 0.45);
    flyer.style.zIndex = passing ? "11" : now.onTop ? "6" : circled || landing ? "3" : "1";
    // It faces where it flies, except in the face-off, where it keeps its eyes on the party even
    // as it rears back.
    const facingThem = landing && at < span(spans, "twist", 0.22);
    const wanted = !facingThem && moving && Math.abs(dx) > 0.3 ? Math.sign(dx) : now.facing;
    facing += (wanted - facing) * TURN_RATE;
    const tilt = moving ? clamp(Math.atan2(dy, Math.abs(dx) + 1), -MAX_LEAN, MAX_LEAN) : 0;
    const wantedLean = lerp(tilt * Math.sign(facing || 1), PICTURE_LEAN, now.settled);
    lean += (wantedLean - lean) * TURN_RATE;
    const beating = (1 - Math.cos(seconds * (moving ? 10 : 7))) / 2;
    const wave = lerp(beating, PICTURE_STROKE, now.settled);
    const beat = Math.max(now.size * BOB, layout.height * LEAST_BOB);
    const bob = Math.sin(seconds * 1.3) * 0.05 * now.size - (wave - 0.5) * 2 * beat;
    const scale = now.size / BOX;
    const shown = Math.abs(facing) < 0.12 ? 0.12 * (facing < 0 ? -1 : 1) : facing;
    flyer.style.transform = `translate3d(${now.x - BOX / 2}px,${now.y + bob - BOX / 2}px,0) rotate(${lean}rad) scale(${shown * scale},${scale * (1 + (wave - 0.5) * 0.06)})`;
    const frame = Math.round(wave * (DRAGON_POSES - 1)) / (DRAGON_POSES - 1);
    const [offsetX, offsetY] = dragonMouth(frame);
    const localX = offsetX * now.size * shown;
    const localY = offsetY * now.size * (1 + (wave - 0.5) * 0.06);
    mouth = [
      now.x + localX * Math.cos(lean) - localY * Math.sin(lean),
      now.y + bob + localX * Math.sin(lean) + localY * Math.cos(lean),
    ];
    wings.style.maskPosition = `${frame * 100}% 0`;
  };

  /** Moves a shot from `from` to `to` across its window, arcing up by `arc` stage heights. */
  const fling = (
    element: HTMLElement,
    window: readonly [number, number],
    fight: number,
    from: readonly [number, number],
    to: readonly [number, number],
    arc: number,
    pointed = false,
  ) => {
    const t = progress(fight, ...window);
    const flying = t > 0 && t < 1;
    element.style.opacity = flying ? "1" : "0";
    if (!flying) return;
    const x = lerp(from[0], to[0], t);
    const y = lerp(from[1], to[1], t) - Math.sin(t * Math.PI) * layout.height * arc;
    const turn = pointed ? Math.atan2(to[1] - from[1], to[0] - from[0]) : 0;
    const grow = pointed ? 1 : 0.6 + t;
    element.style.transform = `translate3d(${x}px,${y}px,0) rotate(${turn}rad) scale(${grow}) translate(-50%,-50%)`;
  };

  /** Each of the four hits it once, and every hit flashes where it lands. */
  const attacks = (
    fight: number,
    party: Party | null,
    body: { x: number; y: number; size: number },
  ) => {
    if (!party) {
      for (const element of [arrow, song, spark, hit]) element.style.opacity = "0";
      return;
    }
    const chest = [
      lerp(mouth[0], body.x, 0.45),
      lerp(mouth[1], body.y, 0.45) + body.size * 0.05,
    ] as const;
    const foot = [body.x - body.size * 0.12, body.y + body.size * 0.22] as const;
    const from = (row: number) => party.rows[row];
    fling(arrow, FIGHT.arrow.at, fight, from(FIGHT.arrow.row), chest, 0.03, true);
    fling(song, FIGHT.song.at, fight, from(FIGHT.song.row), chest, 0.02);
    fling(spark, FIGHT.spark.at, fight, from(FIGHT.spark.row), mouth, SPARK_ARC);
    const landings = [
      [FIGHT.arrow.at[1], chest],
      [FIGHT.song.at[1], chest],
      [lerp(FIGHT.charge.at[0], FIGHT.charge.at[1], 0.5), foot],
      [FIGHT.spark.at[1], mouth],
    ] as const;
    const landed = landings.find(([at]) => fight >= at && fight < at + HIT_LASTS);
    hit.style.opacity = landed ? String(1 - (fight - landed[0]) / HIT_LASTS) : "0";
    if (landed) {
      const [x, y] = landed[1];
      const grow = 0.6 + ((fight - landed[0]) / HIT_LASTS) * 0.8;
      hit.style.transform = `translate3d(${x}px,${y}px,0) scale(${grow}) translate(-50%,-50%)`;
    }
  };

  /** The ward breath stops at the front of the party; the killing one sweeps it front to back. */
  const fightBreath = (fight: number, party: Party) => {
    const reach = (target: readonly [number, number], share: number) =>
      [lerp(mouth[0], target[0], share), lerp(mouth[1], target[1], share)] as const;
    const ward = fightWindow(fight, FIGHT.ward);
    const front = party.rows[0];
    const back = party.rows[party.rows.length - 1];
    if (ward > 0) return { aim: reach(front, 1), breath: ward * FIGHT_BREATH };
    const killing = fightWindow(fight, FIGHT.breath);
    if (killing <= 0) return null;
    const along = progress(fight, ...FIGHT.breath);
    const target = [lerp(front[0], back[0], along), lerp(front[1], back[1], along)] as const;
    return { aim: reach(target, 1.1), breath: killing * FIGHT_BREATH };
  };

  return {
    measure,
    keepNight: (sky: HTMLCanvasElement) => {
      fire?.keepNight(sky);
      fire?.keepWords(wordsStill());
    },
    /** Runs every frame: the scroll position picks the scene, the clock animates it. */
    update(seconds: number, at: number, beats: BeatProgress, party: Party | null) {
      const { twist, lore, fight } = beats;
      const { height: H } = layout;
      const shown = lore < LORE_ARRIVES;
      flyer.style.opacity = shown ? "1" : "0";
      if (shown) fly(seconds, at);

      const moved = Math.abs(at - lastAt);
      lastAt = at;
      const passing = twist > PASS.enters && twist < PASS.exits;
      const wanted = shown && passing ? Math.min(1, moved / 10) : 0;
      breath += (wanted - breath) * (wanted > breath ? 0.5 : 0.09);
      if (breath < 0.01) breath = 0;

      const placed = pose(at);
      const char = (placed.x + placed.size * 0.43 + unit * FRONT_AHEAD) / H;
      const box = words.getBoundingClientRect();
      const burnt = clamp(((char + WORDS_HANDOVER) * H - box.left) / box.width);
      const edge = twist >= PASS.exits ? 1 : passing ? burnt : 0;
      words.style.zIndex = passing ? "12" : "";
      words.style.maskImage =
        edge > 0
          ? `linear-gradient(90deg,transparent ${edge * 106 - 3}%,black ${edge * 106 + 3}%)`
          : "none";

      attacks(fight, party, placed);

      const angle = lean + DRAGON_HEAD_ANGLE;
      const fighting = party ? fightBreath(fight, party) : null;
      fire?.draw(
        fighting
          ? { mouth, ...fighting, char: NO_WALL, time: at / H + seconds * 0.5 }
          : passing
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
            : null,
      );
    },
  };
}
