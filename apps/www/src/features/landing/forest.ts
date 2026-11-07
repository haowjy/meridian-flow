import { MARKETING_SKY } from "@meridian/design-tokens/marketing-sky";
import type { Layout } from "./film-layout";
import { type BeatProgress, lerp, smooth } from "./timeline";

const WALK_FRAMES = 6;
const FIGURE = 256;
const STRIDE = 70;

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

/** Sigrun and the second walker side by side, one walk pose per column. */
function walkSheet() {
  const canvas = document.createElement("canvas");
  canvas.width = FIGURE * WALK_FRAMES;
  canvas.height = FIGURE;
  const pen = canvas.getContext("2d") as CanvasRenderingContext2D;
  pen.lineCap = "round";
  const figure = (x: number, phase: number, scale: number) => {
    const ground = FIGURE - 6;
    const unit = (FIGURE * scale) / 8;
    const hip = ground - unit * 3.3 + Math.abs(Math.sin(phase)) * unit * 0.18;
    const shoulder = hip - unit * 2.5;
    const swing = Math.sin(phase);
    pen.lineWidth = unit * 0.5;
    for (const side of [1, -1]) {
      const stride = swing * side;
      const knee = x + stride * unit * 0.9;
      const lifted = Math.max(0, -stride) * unit * 0.5;
      pen.beginPath();
      pen.moveTo(x, hip);
      pen.lineTo(knee, hip + unit * 1.6);
      pen.lineTo(knee + stride * unit * 0.6 - lifted * 0.4, ground - lifted);
      pen.stroke();
    }
    pen.beginPath();
    pen.moveTo(x - unit * 0.75, shoulder);
    pen.lineTo(x + unit * 0.65, shoulder);
    pen.lineTo(x + unit * 0.55, hip + unit * 0.9);
    pen.lineTo(x - unit * (1.3 + swing * 0.2), hip + unit * 1.2);
    pen.closePath();
    pen.fill();
    pen.beginPath();
    pen.arc(x + unit * 0.1, shoulder - unit * 0.72, unit * 0.62, 0, Math.PI * 2);
    pen.fill();
    pen.lineWidth = unit * 0.18;
    pen.beginPath();
    pen.moveTo(x + unit * 1.1, ground);
    pen.lineTo(x + unit * 1.1, shoulder - unit * 1.2);
    pen.stroke();
  };
  for (let frame = 0; frame < WALK_FRAMES; frame += 1) {
    const phase = (frame / WALK_FRAMES) * Math.PI * 2;
    pen.save();
    pen.beginPath();
    pen.rect(frame * FIGURE, 0, FIGURE, FIGURE);
    pen.clip();
    pen.translate(frame * FIGURE, 0);
    figure(FIGURE * 0.34, phase + 1.4, 0.82);
    figure(FIGURE * 0.72, phase, 1);
    pen.restore();
  }
  return canvas;
}

/** The ground of the story: trees that drift past, and walkers who step as the page scrolls. */
export function createForest(root: HTMLElement) {
  const forest = root.querySelector("#forest") as HTMLElement;
  const near = forest.querySelector("canvas") as HTMLCanvasElement;
  const walkers = root.querySelector("#walkers") as HTMLElement;
  const inner = walkers.firstElementChild as HTMLElement;
  root.style.setProperty("--walk-sheet", `url(${walkSheet().toDataURL()})`);
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
  };

  return {
    measure,
    update(at: number, beats: BeatProgress) {
      const { spans, width: W, height: H } = layout;
      const shown = 1 - smooth(beats.twist, 0, 0.16);
      forest.style.opacity = String(shown);
      walkers.style.opacity = String(shown);
      if (shown === 0) return;
      forest.style.transform = `translate3d(${-at * 0.035}px,0,0)`;
      const size = H * 0.15;
      const walked = Math.min(1, at / spans.ask[0]);
      const x = lerp(W * 0.06, W * 0.46, walked);
      walkers.style.transform = `translate3d(${x}px,${H * 0.91 - size}px,0) scale(${size / FIGURE})`;
      const frame = Math.floor(at / STRIDE) % WALK_FRAMES;
      inner.style.maskPosition = `${(frame / (WALK_FRAMES - 1)) * 100}% 0`;
    },
  };
}
