import { MARKETING_SKY } from "@meridian/design-tokens/marketing-sky";
import type { Layout } from "./film-layout";
import { type BeatProgress, clamp, lerp, progress, smooth } from "./timeline";

const WALK_FRAMES = 6;
const FIGHT_COLUMN = WALK_FRAMES;
const SIT_COLUMN = WALK_FRAMES + 2;
const COLUMNS = WALK_FRAMES + 3;
const WOLF_ROW = 4;
const ROWS = 5;
const FIGURE = 256;
/** Where the walkers stand, in shares of the stage. */
const GROUND = 0.93;
const CLIFF_TOP = 0.64;
const CLIFF_X = 0.11;
/** Stage shares of the world beat at which the other three catch Tam up. */
const JOINS = [0, 0.22, 0.4, 0.58];

const noise = (seed: number) => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

function spruce(pen: CanvasRenderingContext2D, x: number, ground: number, height: number) {
  const tiers = 7;
  for (let tier = 0; tier < tiers; tier += 1) {
    const share = tier / tiers;
    const top = ground - height * (1 - share * 0.9);
    const width = height * (0.05 + share * 0.17);
    const bottom = top + height * 0.24;
    pen.beginPath();
    pen.moveTo(x, top);
    pen.lineTo(x + width, bottom);
    pen.lineTo(x + width * 0.3, bottom - height * 0.03);
    pen.lineTo(x - width * 0.3, bottom - height * 0.03);
    pen.lineTo(x - width, bottom);
    pen.closePath();
    pen.fill();
  }
}

type Pose = { kind: "walk"; phase: number } | { kind: "fight"; lunge: number } | { kind: "sit" };

/** One of the party, facing right, standing on the bottom of its cell. */
function person(pen: CanvasRenderingContext2D, row: number, pose: Pose) {
  const scale = [0.8, 1, 0.95, 0.92][row];
  const x = FIGURE / 2;
  const ground = FIGURE - 6;
  const unit = (FIGURE * scale) / 8;
  const seated = pose.kind === "sit";
  const lunge = pose.kind === "fight" ? pose.lunge : 0;
  const swing = pose.kind === "walk" ? Math.sin(pose.phase) : 0;
  const hip = seated
    ? ground - unit * 0.7
    : ground - unit * (3.3 - lunge * 0.5) + Math.abs(swing) * unit * 0.18;
  const lean = pose.kind === "fight" ? unit * 0.5 : 0;
  const shoulder = hip - unit * 2.5;
  const shoulderX = x + lean;
  const line = (width: number, ...points: [number, number][]) => {
    pen.lineWidth = width;
    pen.beginPath();
    pen.moveTo(...points[0]);
    for (const point of points.slice(1)) pen.lineTo(...point);
    pen.stroke();
  };

  if (seated) {
    line(unit * 0.5, [x, hip], [x + unit * 1.5, hip - unit * 0.7], [x + unit * 1.9, ground]);
  } else if (row !== 3) {
    for (const side of [1, -1]) {
      const stride = pose.kind === "fight" ? side * (0.9 + lunge * 0.5) : swing * side;
      const knee = x + stride * unit * 0.9;
      const lifted = Math.max(0, -stride) * unit * 0.5;
      line(
        unit * 0.5,
        [x, hip],
        [knee, hip + unit * 1.6],
        [knee + stride * unit * 0.6 - lifted * 0.4, ground - lifted],
      );
    }
  }

  const wide = row === 2 ? 1.15 : 0.8;
  pen.beginPath();
  pen.moveTo(shoulderX - unit * wide, shoulder);
  pen.lineTo(shoulderX + unit * 0.65, shoulder);
  if (row === 3 && !seated) {
    pen.lineTo(x + unit * (1.1 + swing * 0.25), ground);
    pen.lineTo(x - unit * (1.4 + swing * 0.25), ground);
  } else {
    pen.lineTo(x + unit * 0.55, hip + unit * 0.9);
    pen.lineTo(x - unit * (wide + 0.5 + swing * 0.2), hip + unit * 1.2);
  }
  pen.closePath();
  pen.fill();

  const headX = shoulderX + unit * 0.1;
  const headY = shoulder - unit * 0.72;
  pen.beginPath();
  pen.arc(headX, headY, unit * 0.62, 0, Math.PI * 2);
  pen.fill();

  if (row === 0) {
    pen.beginPath();
    pen.moveTo(headX + unit * 0.4, headY - unit * 0.5);
    pen.lineTo(headX - unit * 0.9, headY - unit * 0.9);
    pen.lineTo(headX - unit * 0.7, headY + unit * 0.5);
    pen.closePath();
    pen.fill();
    pen.fillRect(x - unit * 1.75, shoulder + unit * 0.1, unit * 1.2, unit * 1.5);
  }
  if (row === 1) {
    line(unit * 0.26, [headX - unit * 0.4, headY], [x - unit * 1.1, shoulder + unit * 1.3]);
    const grip: [number, number] =
      pose.kind === "fight"
        ? [shoulderX + unit * 1.9, shoulder - unit * (0.4 + lunge * 1.6)]
        : [x + unit * 1.1, shoulder + unit * 0.9];
    const end: [number, number] =
      pose.kind === "fight"
        ? [shoulderX + unit * (3 - lunge), shoulder - unit * (2.2 + lunge * 0.5)]
        : [x - unit * 0.7, shoulder - unit * 1.9];
    line(unit * 0.2, [shoulderX, shoulder + unit * 0.2], grip, end);
    pen.beginPath();
    pen.arc(end[0], end[1], unit * 0.7, 0.3, Math.PI + 1.2);
    pen.fill();
  }
  if (row === 2) {
    pen.lineWidth = unit * 0.14;
    pen.beginPath();
    pen.arc(x - unit * 1.5, shoulder + unit * 0.8, unit * 2, -1.1, 1.1);
    pen.stroke();
    if (pose.kind === "fight") {
      line(unit * 0.2, [shoulderX, shoulder + unit * 0.2], [shoulderX + unit * 2.1, shoulder]);
      line(
        unit * 0.12,
        [shoulderX + unit * 2.1, shoulder - unit],
        [shoulderX + unit * 2.1, shoulder + unit],
      );
    }
  }
  if (row === 3) {
    const top = seated ? ground - unit * 5 : shoulder - unit * 1.8;
    line(unit * 0.17, [x + unit * 1.2, seated ? ground : ground], [x + unit * 1.1, top]);
    line(unit * 0.14, [x + unit * 1.1, top], [x + unit * 1.7, top + unit * 0.2]);
    pen.beginPath();
    pen.arc(x + unit * 1.7, top + unit * 0.65, unit * 0.34, 0, Math.PI * 2);
    pen.fill();
  }
}

/** Two wolves running left, for the fight on the road. */
function wolves(pen: CanvasRenderingContext2D, phase: number) {
  const wolf = (x: number, ground: number, scale: number, offset: number) => {
    const run = Math.sin(phase + offset);
    pen.save();
    pen.translate(x, ground);
    pen.scale(scale, scale);
    pen.beginPath();
    pen.moveTo(-34, -34);
    pen.lineTo(-52, -44);
    pen.lineTo(-60, -40);
    pen.lineTo(-62, -30);
    pen.lineTo(-40, -22);
    pen.lineTo(20, -20);
    pen.lineTo(52, -26 + run * 6);
    pen.lineTo(30, -38);
    pen.closePath();
    pen.fill();
    pen.lineWidth = 6;
    for (const [hip, lead] of [
      [-28, 1],
      [-20, -1],
      [14, -1],
      [22, 1],
    ]) {
      pen.beginPath();
      pen.moveTo(hip, -24);
      pen.lineTo(hip + run * lead * 16, -3);
      pen.stroke();
    }
    pen.restore();
  };
  wolf(FIGURE * 0.34, FIGURE - 6, 1.05, 0);
  wolf(FIGURE * 0.72, FIGURE - 16, 0.85, 1.4);
}

/** The party, one row each, walking, then two fighting frames and sitting; wolves below. */
function partySheet() {
  const canvas = document.createElement("canvas");
  canvas.width = FIGURE * COLUMNS;
  canvas.height = FIGURE * ROWS;
  const pen = canvas.getContext("2d") as CanvasRenderingContext2D;
  pen.lineCap = "round";
  pen.lineJoin = "round";
  const cell = (column: number, row: number, draw: () => void) => {
    pen.save();
    pen.beginPath();
    pen.rect(column * FIGURE, row * FIGURE, FIGURE, FIGURE);
    pen.clip();
    pen.translate(column * FIGURE, row * FIGURE);
    draw();
    pen.restore();
  };
  for (let row = 0; row < WOLF_ROW; row += 1) {
    for (let frame = 0; frame < WALK_FRAMES; frame += 1) {
      const phase = (frame / WALK_FRAMES) * Math.PI * 2;
      cell(frame, row, () => person(pen, row, { kind: "walk", phase }));
    }
    cell(FIGHT_COLUMN, row, () => person(pen, row, { kind: "fight", lunge: 0 }));
    cell(FIGHT_COLUMN + 1, row, () => person(pen, row, { kind: "fight", lunge: 1 }));
    cell(SIT_COLUMN, row, () => person(pen, row, { kind: "sit" }));
  }
  for (let frame = 0; frame < WALK_FRAMES; frame += 1) {
    cell(frame, WOLF_ROW, () => wolves(pen, (frame / WALK_FRAMES) * Math.PI * 2));
  }
  return canvas;
}

/** The ground of the story: the trees, and the party crossing them as the page scrolls. */
export function createForest(root: HTMLElement) {
  const forest = root.querySelector("#forest") as HTMLElement;
  const near = forest.querySelector("canvas") as HTMLCanvasElement;
  const walkers = root.querySelector("#walkers") as HTMLElement;
  const figures = [...walkers.querySelectorAll("i")];
  const camp = walkers.querySelector(".camp") as HTMLElement;
  root.style.setProperty("--walk-sheet", `url(${partySheet().toDataURL()})`);
  const [r, g, b] = MARKETING_SKY.sun;
  root.style.setProperty("--walk-lantern", `rgb(${r * 255} ${g * 255} ${b * 255})`);
  let layout: Layout;

  const measure = (next: Layout) => {
    layout = next;
    const { width: W, height: H } = next;
    near.width = Math.ceil(W * 1.4);
    near.height = Math.ceil(H * 0.5);
    const pen = near.getContext("2d") as CanvasRenderingContext2D;
    pen.fillStyle = getComputedStyle(root).getPropertyValue("--mkt-night");
    const ground = near.height * 0.9;
    pen.fillRect(0, ground - H * 0.08, near.width, near.height);
    for (let i = 0; i < 110; i += 1) {
      const x = noise(i + 1) * near.width;
      const edge = Math.abs(x / near.width - 0.46) * 2;
      spruce(pen, x, ground, H * (0.14 + edge * 0.3 + noise(i + 40) * 0.1));
    }
    const top = (CLIFF_TOP - 0.5) * H;
    pen.beginPath();
    pen.moveTo(0, ground);
    pen.lineTo(0, top - H * 0.02);
    pen.lineTo(W * (CLIFF_X + 0.05), top);
    pen.lineTo(W * (CLIFF_X + 0.09), top + H * 0.06);
    pen.lineTo(W * (CLIFF_X + 0.12), top + H * 0.09);
    pen.lineTo(W * (CLIFF_X + 0.2), ground);
    pen.closePath();
    pen.fill();
  };

  const place = (
    figure: HTMLElement,
    x: number,
    feet: number,
    size: number,
    column: number,
    row: number,
  ) => {
    figure.style.transform = `translate3d(${x - size / 2}px,${feet - size}px,0) scale(${size / FIGURE})`;
    figure.style.maskPosition = `${(column / (COLUMNS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%`;
  };

  return {
    measure,
    update(at: number, beats: BeatProgress) {
      const { spans, width: W, height: H } = layout;
      const shown = 1 - smooth(beats.twist, 0.12, 0.26);
      forest.style.opacity = String(shown);
      walkers.style.opacity = String(shown);
      if (shown === 0) return;
      const drift = (at / H) * W * 0.025;
      forest.style.transform = `translate3d(${-drift}px,0,0)`;

      const size = H * 0.16;
      const gap = size * 0.5;
      const down = smooth(beats.world, 0, 0.14);
      const road = W * lerp(0.3, 0.62, progress(at, spans.world[0], spans.write[1]));
      const leader = lerp(W * CLIFF_X - drift, road, down);
      const feet = lerp(H * CLIFF_TOP, H * GROUND, down);
      const campX = leader - gap * 1.5;
      const seated = smooth(beats.back, 0, 0.3);
      const ring = [1.6, 0.6, -0.6, -1.6];

      figures.slice(0, WOLF_ROW).forEach((figure, row) => {
        const joinsAt = lerp(spans.world[0], spans.world[1], JOINS[row]);
        const joined = row === 0 ? 1 : smooth(at, joinsAt, joinsAt + H * 0.5);
        figure.style.opacity = row === 0 || at > joinsAt ? "1" : "0";
        const slot = lerp(leader - gap * row, campX + ring[row] * gap, seated);
        const x = row === 0 ? slot : lerp(-W * 0.08, slot, joined);
        const inFight = beats.out > 0 && beats.back <= 0;
        const walking = Math.floor(x / (size * 0.16) + row * 2) % WALK_FRAMES;
        const moving = down > 0 || row > 0;
        let column = moving ? Math.abs(walking) : 0;
        if (inFight) column = FIGHT_COLUMN + (Math.floor(at / 46 + row) % 2);
        if (seated > 0.5 && beats.turn <= 0) column = SIT_COLUMN;
        if (beats.turn > 0) column = 1;
        place(figure, x, row === 0 ? feet : H * GROUND, size, column, row);
      });

      const wolfIn = smooth(beats.out, 0, 0.35);
      const wolfGone = smooth(beats.out, 0.7, 0.95);
      const wolf = figures[WOLF_ROW];
      wolf.style.opacity = String(wolfIn > 0 ? 1 - wolfGone : 0);
      place(
        wolf,
        lerp(W * 1.1, leader + gap * 2.6, wolfIn),
        H * GROUND,
        size * 0.95,
        Math.floor(at / 30) % WALK_FRAMES,
        WOLF_ROW,
      );

      const glow = seated * (1 - smooth(beats.turn, 0.05, 0.3));
      camp.style.opacity = String(clamp(glow * (0.9 + Math.sin(at / 17) * 0.1)));
      camp.style.transform = `translate3d(${campX - size * 0.6}px,${H * GROUND - size * 0.86}px,0) scale(${size / 100})`;
    },
  };
}
