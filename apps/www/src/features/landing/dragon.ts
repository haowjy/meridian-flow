type Point = readonly [x: number, y: number];
type Bone = readonly [x: number, y: number, radius: number];

const SIZE = 512;
/** Wing poses in the sheet, from raised to the bottom of the downstroke. */
export const DRAGON_POSES = 6;
const DOWNSTROKE = 1.35;
const FOLD = 0.3;
const UNITS = 1000;

/** The mouth in a flying pose, as an offset from the cell's centre in shares of the cell. */
export const dragonMouth = (stroke: number) => [0.433, -0.122 - (stroke - 0.5) * 0.044] as const;
/** Which way the flying head points, in radians below level. */
export const DRAGON_HEAD_ANGLE = 0.11;

export const catmullRom = (a: number, b: number, c: number, d: number, t: number) =>
  0.5 *
  (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);

function curve(bones: readonly Bone[], steps = 30) {
  const points: Bone[] = [];
  for (let i = 0; i < bones.length - 1; i += 1) {
    const before = bones[Math.max(i - 1, 0)];
    const from = bones[i];
    const to = bones[i + 1];
    const after = bones[Math.min(i + 2, bones.length - 1)];
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      points.push([
        catmullRom(before[0], from[0], to[0], after[0], t),
        catmullRom(before[1], from[1], to[1], after[1], t),
        from[2] + (to[2] - from[2]) * t,
      ]);
    }
  }
  points.push(bones[bones.length - 1]);
  return points;
}

/** The flying dragon's silhouettes in the alpha channel, wing poses left to right. */
let sheet: HTMLCanvasElement | null = null;

export function dragonSheet() {
  if (sheet) return sheet;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE * DRAGON_POSES;
  canvas.height = SIZE;
  const pen = canvas.getContext("2d") as CanvasRenderingContext2D;
  for (let pose = 0; pose < DRAGON_POSES; pose += 1) {
    pen.save();
    pen.beginPath();
    pen.rect(pose * SIZE, 0, SIZE, SIZE);
    pen.clip();
    pen.translate(pose * SIZE, 0);
    pen.scale(SIZE / UNITS, SIZE / UNITS);
    drawPose(pen, pose / (DRAGON_POSES - 1));
    pen.restore();
  }
  sheet = canvas;
  return canvas;
}

function drawPose(pen: CanvasRenderingContext2D, stroke: number) {
  const limb = (bones: readonly Bone[]) => {
    for (const [x, y, radius] of curve(bones)) {
      pen.beginPath();
      pen.arc(x, y, radius, 0, Math.PI * 2);
      pen.fill();
    }
  };
  const shape = (...points: Point[]) => {
    pen.beginPath();
    pen.moveTo(...points[0]);
    for (const point of points.slice(1)) pen.lineTo(...point);
    pen.closePath();
    pen.fill();
  };
  const wing = (
    shoulder: Point,
    raisedElbow: Point,
    raisedWrist: Point,
    raisedTips: Point[],
    root: Point,
  ) => {
    const cos = Math.cos(-DOWNSTROKE * stroke);
    const sin = Math.sin(-DOWNSTROKE * stroke);
    const reach = 1 - FOLD * stroke;
    const swing = ([x, y]: Point): Point => {
      const dx = (x - shoulder[0]) * reach;
      const dy = (y - shoulder[1]) * reach;
      return [shoulder[0] + dx * cos - dy * sin, shoulder[1] + dx * sin + dy * cos];
    };
    const elbow = swing(raisedElbow);
    const wrist = swing(raisedWrist);
    const tips = raisedTips.map(swing);
    limb([
      [...shoulder, 20],
      [...elbow, 13],
      [...wrist, 8],
    ]);
    for (const tip of tips) {
      const middle: Bone = [
        (wrist[0] + tip[0]) / 2 + (tip[1] - wrist[1]) * 0.05,
        (wrist[1] + tip[1]) / 2 - (tip[0] - wrist[0]) * 0.05,
        3.5,
      ];
      limb([[...wrist, 7], middle, [...tip, 0.8]]);
    }
    pen.beginPath();
    pen.moveTo(...wrist);
    pen.lineTo(...tips[0]);
    let last = tips[0];
    for (const next of [...tips.slice(1), root]) {
      const x = (last[0] + next[0]) / 2;
      const y = (last[1] + next[1]) / 2;
      pen.quadraticCurveTo(x + (wrist[0] - x) * 0.34, y + (wrist[1] - y) * 0.34, ...next);
      last = next;
    }
    pen.lineTo(...shoulder);
    pen.lineTo(...elbow);
    pen.closePath();
    pen.fill();
  };
  const spines = (bones: Bone[]) => {
    const ridge = curve(bones, 12);
    for (let i = 6; i < ridge.length - 4; i += i < ridge.length * 0.55 ? 5 : 4) {
      const [x, y, radius] = ridge[i];
      const dx = ridge[i + 2][0] - x;
      const dy = ridge[i + 2][1] - y;
      const length = Math.hypot(dx, dy) || 1;
      const along: Point = [dx / length, dy / length];
      const out: Point = [along[1], -along[0]];
      const rise = radius + radius * 0.55 + 11;
      const base = radius - 2;
      const width = radius * 0.3 + 6;
      shape(
        [x + out[0] * base, y + out[1] * base],
        [x + out[0] * rise - along[0] * 3, y + out[1] * rise - along[1] * 3],
        [x + out[0] * base + along[0] * width, y + out[1] * base + along[1] * width],
      );
    }
  };
  const head = ([x, y]: Point, turn: number) => {
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const at = ([px, py]: Point): Point => {
      const dx = px - 695;
      const dy = py - 335;
      return [x + dx * cos - dy * sin, y + dx * sin + dy * cos];
    };
    const skull: Point[] = [
      [684, 318],
      [726, 284],
      [770, 250],
      [816, 218],
      [790, 262],
      [752, 296],
      [792, 284],
      [826, 296],
      [772, 324],
      [716, 350],
    ];
    shape(...skull.map(at));
    shape(at([698, 312]), at([622, 262]), at([712, 296]));
    shape(at([712, 296]), at([654, 222]), at([728, 284]));
    shape(at([738, 274]), at([730, 246]), at([750, 266]));
  };
  const tailTip = (x: number, y: number, turn: number) => {
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const at = (px: number, py: number): Point => [
      x + px * cos - py * sin,
      y + px * sin + py * cos,
    ];
    shape(at(0, 0), at(-40, -45), at(37, 0), at(-5, 47));
  };

  const lift = stroke - 0.5;
  wing(
    [565, 470],
    [590, 285],
    [540, 125],
    [
      [440, 15],
      [600, 35],
      [680, 135],
    ],
    [625, 445],
  );
  wing(
    [525, 475],
    [450, 305],
    [400, 175],
    [
      [120, 80],
      [130, 265],
      [220, 385],
      [330, 470],
    ],
    [450, 505],
  );
  const spine: Bone[] = [
    [30, 500 + lift * 150, 1.2],
    [120, 515 + lift * 95, 5],
    [235, 530 + lift * 45, 12],
    [340, 525 + lift * 12, 26],
    [440, 505, 44],
    [530, 490, 50],
    [610, 465 - lift * 8, 36],
    [685, 430 - lift * 22, 24],
    [750, 400 - lift * 34, 17],
    [810, 385 - lift * 44, 14],
  ];
  limb(spine);
  spines(spine);
  tailTip(30, 500 + lift * 150, lift * -0.9);
  head([810, 385 - lift * 44], 0.5);
  limb([
    [440, 545, 28],
    [385, 590, 15],
    [335, 600, 7],
  ]);
  limb([
    [560, 530, 20],
    [520, 585, 11],
    [478, 592, 5],
  ]);
}
