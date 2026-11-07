import { MARKETING_SKY } from "@meridian/design-tokens/marketing-sky";
import type { Layout } from "./film-layout";
import { GROUND, walked } from "./ground";
import { rgb } from "./sky";
import {
  type BeatProgress,
  CAMP,
  clamp,
  ease,
  envelope,
  FIGHT,
  lerp,
  progress,
  smooth,
  TURN,
  TWIST,
} from "./timeline";

const WALK_FRAMES = 6;
const FIGHT_COLUMN = WALK_FRAMES;
const SIT_COLUMN = WALK_FRAMES + 2;
const SHADOW_COLUMN = WALK_FRAMES + 3;
const COLUMNS = WALK_FRAMES + 4;
const WOLF_ROW = 4;
const ROWS = 5;
const FIGURE = 256;
const CLIFF_TOP = 0.64;
const CLIFF_X = 0.11;
/** Stage shares of the world beat at which the other three catch Tam up. */
const JOINS = [0, 0.22, 0.4, 0.58];

/** Where the party stands in the fight, for the dragon's aim: stage pixels. */
export type Party = { rows: readonly (readonly [number, number])[]; size: number };

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

type Pose =
  | { kind: "walk"; phase: number }
  | { kind: "fight"; lunge: number }
  | { kind: "sit" }
  | { kind: "shadow" };

/** One of the party, facing right, standing on the bottom of its cell. */
function person(pen: CanvasRenderingContext2D, row: number, pose: Pose) {
  // Charred by the breath, any of the four: no build or gear of their own.
  const who = pose.kind === "shadow" ? -1 : row;
  const scale = who < 0 ? 0.95 : [0.8, 0.95, 1.12, 0.92][row];
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
  } else if (who !== 3) {
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

  const wide = who === 2 ? 1.15 : 0.8;
  pen.beginPath();
  pen.moveTo(shoulderX - unit * wide, shoulder);
  pen.lineTo(shoulderX + unit * 0.65, shoulder);
  if (who === 3 && !seated) {
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

  if (who === 0) {
    pen.beginPath();
    pen.moveTo(headX + unit * 0.4, headY - unit * 0.5);
    pen.lineTo(headX - unit * 0.9, headY - unit * 0.9);
    pen.lineTo(headX - unit * 0.7, headY + unit * 0.5);
    pen.closePath();
    pen.fill();
    pen.fillRect(x - unit * 1.75, shoulder + unit * 0.1, unit * 1.2, unit * 1.5);
    if (pose.kind === "fight") {
      // Sigrun's arm out, a ward rune ringed in her open hand.
      const hand = shoulderX + unit * 1.7;
      line(unit * 0.2, [shoulderX, shoulder + unit * 0.2], [hand, shoulder - unit * 0.3]);
      pen.lineWidth = unit * 0.13;
      pen.beginPath();
      pen.arc(hand + unit * 0.3, shoulder - unit * 0.4, unit * 0.75, 0, Math.PI * 2);
      pen.stroke();
    }
  }
  if (who === 1 && pose.kind === "fight") {
    const palm: [number, number] = [shoulderX + unit * 1.8, shoulder - unit * (0.6 + lunge * 1.4)];
    line(unit * 0.22, [shoulderX, shoulder + unit * 0.2], palm);
    pen.beginPath();
    pen.arc(
      palm[0] + unit * 0.2,
      palm[1] - unit * 0.1,
      unit * (0.32 + lunge * 0.26),
      0,
      Math.PI * 2,
    );
    pen.fill();
  }
  if (who === 2) {
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
  if (who === 3) {
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
    cell(SHADOW_COLUMN, row, () => person(pen, row, { kind: "shadow" }));
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
  const treeline = root.querySelector("#treeline") as HTMLCanvasElement;
  let treelineDrawn = false;
  const walkers = root.querySelector("#walkers") as HTMLElement;
  const figures = [...walkers.querySelectorAll("i")];
  const camp = walkers.querySelector(".camp") as HTMLElement;
  const sheets = root.querySelector("#sheets") as HTMLElement;
  root.style.setProperty("--walk-sheet", `url(${partySheet().toDataURL()})`);
  root.style.setProperty("--walk-lantern", rgb(MARKETING_SKY.sun));
  root.style.setProperty("--walk-ward", rgb(MARKETING_SKY.fireCore));
  let layout: Layout;

  const measure = (next: Layout) => {
    layout = next;
    const { width: W, height: H } = next;
    forest.style.width = `${GROUND.wide * 100}%`;
    forest.style.height = `${GROUND.tall * 100}%`;
    treeline.width = W;
    treeline.height = H;
    treelineDrawn = false;
    near.width = Math.ceil(W * GROUND.wide);
    near.height = Math.ceil(H * GROUND.tall);
    const pen = near.getContext("2d") as CanvasRenderingContext2D;
    pen.fillStyle = getComputedStyle(root).getPropertyValue("--mkt-night");
    const top = H * (1 - GROUND.tall);
    const ground = H * GROUND.floor - top;
    const [shoreFrom, shoreTo] = [GROUND.shore[0] * W, GROUND.shore[1] * W];
    // The woods' floor, then the beach dropping to the water's edge and rising again at the trees.
    const sand = (x: number) => {
      const into = Math.min(1, Math.max(0, Math.min(x - shoreFrom, shoreTo - x) / (W * 0.12)));
      return ground - H * lerp(0.08, GROUND.floor - GROUND.beach, into * into * (3 - 2 * into));
    };
    pen.beginPath();
    pen.moveTo(0, near.height);
    for (let x = 0; x <= near.width; x += 8) pen.lineTo(x, sand(x));
    pen.lineTo(near.width, near.height);
    pen.closePath();
    pen.fill();
    pen.save();
    pen.strokeStyle = rgb(MARKETING_SKY.auroraMid);
    pen.globalAlpha = 0.22;
    pen.lineWidth = Math.max(1, H * 0.002);
    pen.beginPath();
    for (let x = shoreFrom; x <= shoreTo; x += 8) pen.lineTo(x, sand(x));
    pen.stroke();
    pen.restore();
    const forestEnd = shoreFrom - W * 0.05;
    for (let i = 0; i < 110; i += 1) {
      const x = noise(i + 1) * forestEnd * 1.04;
      const edge = Math.abs(x / (W * 1.4) - 0.46) * 2;
      // Thinning and smaller toward the shore.
      const thin = clamp((x - (forestEnd - W * 0.25)) / (W * 0.3));
      if (noise(i + 70) < thin) continue;
      const tall = H * (0.14 + edge * 0.3 + noise(i + 40) * 0.1) * (1 - thin * 0.5);
      // No taller than the strip, or its top is cut flat.
      spruce(pen, x, sand(x), Math.min(tall, sand(x) * 0.97));
    }
    for (let i = 0; i < 24; i += 1) {
      const x = shoreTo + noise(i + 200) * (near.width - shoreTo);
      spruce(pen, x, sand(x), H * (0.2 + noise(i + 240) * 0.2));
    }
    const cliff = H * CLIFF_TOP - top;
    pen.beginPath();
    pen.moveTo(0, ground);
    pen.lineTo(0, cliff - H * 0.02);
    pen.lineTo(W * (CLIFF_X + 0.05), cliff);
    pen.lineTo(W * (CLIFF_X + 0.09), cliff + H * 0.06);
    pen.lineTo(W * (CLIFF_X + 0.12), cliff + H * 0.09);
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
    angle = 0,
  ) => {
    // Turns about the feet, so a figure falls where it stood.
    figure.style.transform = `translate3d(${x}px,${feet}px,0) rotate(${angle}rad) scale(${size / FIGURE}) translate(-50%,-100%)`;
    figure.style.maskPosition = `${(column / (COLUMNS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%`;
  };

  const still = document.createElement("canvas");

  return {
    measure,
    /** The night sky with the trees in front, for the burn to take away: its still has no DOM. */
    withTrees(sky: HTMLCanvasElement) {
      still.width = sky.width;
      still.height = sky.height;
      const pen = still.getContext("2d") as CanvasRenderingContext2D;
      pen.drawImage(sky, 0, 0);
      const frame = sky.getBoundingClientRect();
      const trees = near.getBoundingClientRect();
      const kx = sky.width / frame.width;
      const ky = sky.height / frame.height;
      pen.drawImage(
        near,
        (trees.left - frame.left) * kx,
        (trees.top - frame.top) * ky,
        trees.width * kx,
        trees.height * ky,
      );
      return still;
    },
    update(at: number, beats: BeatProgress): Party | null {
      const { spans, width: W, height: H } = layout;
      const shown = 1 - smooth(beats.twist, ...TWIST.partyGone);
      walkers.style.opacity = String(shown);
      const drift = W * walked(at, layout);
      // As the stage starts to scroll away, the trees hand over to a fixed copy behind the page
      // at the same pixels, and stay there under the end of the page.
      const behind = beats.leave > 0;
      if (behind && !treelineDrawn) {
        const pen = treeline.getContext("2d") as CanvasRenderingContext2D;
        pen.clearRect(0, 0, W, H);
        pen.drawImage(near, -drift, H - near.height);
        treelineDrawn = true;
      }
      forest.style.visibility = behind ? "hidden" : "";
      treeline.style.visibility = behind ? "" : "hidden";
      const walkOut = smooth(beats.turn, ...TURN.walksOut);
      const road = W * lerp(0.3, 0.62, progress(at, spans.world[0], spans.write[1]));
      forest.style.transform = `translate3d(${-drift}px,0,0)`;
      if (shown === 0) return null;

      // A phone's stage is narrow: the party shrinks with its width, so the dragon and all four fit.
      const size = Math.min(H * 0.16, W * 0.22);
      const gap = size * 0.5;
      const down = smooth(beats.world, 0, 0.14);
      const leader = lerp(W * CLIFF_X - drift, road, down);
      const feet = lerp(H * CLIFF_TOP, H * GROUND.feet, down);
      // The camp is in the middle of the stage, and its fire stays on the ground as they leave.
      const campX = W * 0.5;
      // On a phone they take the left of the stage for the fight, and leave the right to the dragon.
      const standX = campX - (layout.isPhone ? walkOut * W * 0.25 : 0);
      const fireX = campX - (drift - W * walked(spans.camp[1], layout));
      const seated = smooth(beats.camp, ...CAMP.sits);
      const ring = [1.6, 0.6, -0.6, -1.6];
      const fight = beats.fight;
      const backed =
        (smooth(beats.turn, ...TURN.perch) * 0.05 + smooth(fight, 0.05, FIGHT.breath[0]) * 0.14) *
        W *
        (layout.isPhone ? 0.2 : 1);
      const heads: number[] = [];

      figures.slice(0, WOLF_ROW).forEach((figure, row) => {
        const joinsAt = lerp(spans.world[0], spans.world[1], JOINS[row]);
        const joined = row === 0 ? 1 : smooth(at, joinsAt, joinsAt + H * 0.5);
        figure.style.opacity = row === 0 || at > joinsAt ? "1" : "0";
        // Up from the fire into the order they fight in as they walk onto the shore.
        const stands = lerp(ring[row], ring[FIGHT.places[row]], walkOut);
        const slot = lerp(leader - gap * row, standX + stands * gap, seated);
        // In the fight they give ground step by step, which also brings the fight to the middle.
        let x = (row === 0 ? slot : lerp(-W * 0.08, slot, joined)) - backed;
        const wolvesAttack = beats.out > 0 && beats.back <= 0;
        const walking = Math.floor(x / (size * 0.16) + row * 2) % WALK_FRAMES;
        const moving = down > 0 || row > 0;
        let column = moving ? Math.abs(walking) : 0;
        if (wolvesAttack) column = FIGHT_COLUMN + (Math.floor(at / 46 + row) % 2);
        if (seated > 0.5 && beats.turn <= 0) column = SIT_COLUMN;
        // Out of the woods onto the shore, then still as it lands.
        if (beats.turn > 0) {
          const stepping = walkOut > 0 && walkOut < 1;
          column = stepping ? Math.floor(drift / (size * 0.16) + row * 2) % WALK_FRAMES : 1;
        }
        if (fight <= 0) {
          heads.push(x);
          figure.style.filter = "";
          place(figure, x, row === 0 ? feet : H * GROUND.feet, size, column, row);
          return;
        }
        const fate = FIGHT.fates[row];
        // Oskar's charge at its flank: out to the dragon and back to the line.
        if (row === FIGHT.charge.row) {
          const run = progress(fight, ...FIGHT.charge.at);
          x += Math.sin(run * Math.PI) * W * 0.16;
        }
        const hit = progress(fight, fate.at, fate.at + 0.07);
        // The breath chars them as it passes; the one left standing is too dark to tell who.
        const charred = smooth(fight, FIGHT.breath[0], FIGHT.breath[1]);
        let angle = 0;
        let feetY = H * GROUND.feet;
        heads.push(x);
        let fx = x;
        column = hit > 0 ? 1 : FIGHT_COLUMN + (Math.floor(at / 46 + row) % 2);
        if (fate.kind === "fall") angle = -smooth(hit, 0, 1) * 1.45;
        if (fate.kind === "flung") {
          // Thrown back by the breath, and down on the sand where it lands.
          const flight = progress(fight, fate.at, fate.at + 0.1);
          fx = x - ease(flight) * W * (layout.isPhone ? 0.08 : 0.16);
          feetY -= Math.sin(flight * Math.PI) * H * 0.1;
          angle = -smooth(flight, 0, 1) * 1.5;
        }
        // Charred, all four lose their own shapes, and the one left standing comes out of the fire
        // in the middle of where they stood: nothing says who survives before the card asks.
        if (charred > 0.12) column = SHADOW_COLUMN;
        if (fate.kind === "stand")
          fx = lerp(x, standX - backed, smooth(fight, 0.7, FIGHT.breath[1]));
        const dark = charred * (fate.kind === "stand" ? 0.55 : 0.3);
        // Lit by the breaths and the ward, they read brighter than on the walk.
        const lit = 1.45 - dark * 1.3;
        figure.style.filter =
          fate.kind === "stand"
            ? `brightness(${lit}) blur(${charred * 1.2}px)`
            : `brightness(${lit})`;
        place(figure, fx, feetY, size, column, row, angle);
      });

      const wolfIn = smooth(beats.out, 0, 0.35);
      const wolfGone = smooth(beats.out, 0.7, 0.95);
      const wolf = figures[WOLF_ROW];
      wolf.style.opacity = String(wolfIn > 0 ? 1 - wolfGone : 0);
      place(
        wolf,
        lerp(W * 1.1, leader + gap * 2.6, wolfIn),
        H * GROUND.feet,
        size * 0.95,
        Math.floor(at / 30) % WALK_FRAMES,
        WOLF_ROW,
      );

      // Still burning as they walk away from it, until the ground carries it off.
      const glow = seated * (1 - smooth(beats.turn, 0.45, 0.55));
      camp.style.opacity = String(clamp(glow * (0.9 + Math.sin(at / 17) * 0.1)));
      camp.style.transform = `translate3d(${fireX - size * 0.6}px,${H * GROUND.feet - size * 0.86}px,0) scale(${size / 100})`;
      const sheetsUp = envelope(beats.camp, CAMP.sheets, 0.04, 0.05);
      sheets.style.opacity = String(sheetsUp);
      sheets.style.transform = `translate3d(${campX}px,${H * GROUND.feet - size * 1.15 + (1 - sheetsUp) * H * 0.03}px,0) translate(-50%,-100%)`;
      return {
        rows: heads.map((head) => [head + size * 0.1, H * GROUND.feet - size * 0.6] as const),
        size,
      };
    },
  };
}
