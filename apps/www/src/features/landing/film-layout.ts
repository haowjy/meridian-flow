import { type BeatSpans, clamp, spanBeats } from "./timeline";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The breakpoints in landing.css. Queries, not widths: scrollbars must not split the two. */
const PHONE_QUERY = "(max-width: 819px), (max-height: 499px)";
const SHORT_QUERY = "(max-height: 499px)";

export type Rect = { x: number; y: number; w: number };
export type Line = { path: SVGPathElement; dot: SVGCircleElement; length: number };

export type FilmParts = {
  stage: HTMLElement;
  end: HTMLElement;
  blockHome: HTMLElement;
  block: HTMLElement;
  caption: HTMLElement;
  chapter: HTMLElement;
  chapterOpening: HTMLElement;
  lastTypedParagraph: HTMLElement;
  turnParagraphs: { a: HTMLElement; b: HTMLElement };
  hub: HTMLElement;
  agents: HTMLElement[];
  teamLines: SVGSVGElement;
  worldNotes: HTMLElement[];
  worldLines: SVGSVGElement;
};

export type Layout = {
  windowWidth: number;
  width: number;
  height: number;
  isPhone: boolean;
  /** The product block at rest on the first screen, where CSS put it. */
  home: Rect;
  workspace: Rect;
  blockLayoutWidth: number;
  chapterFrom: number;
  chapterTo: number;
  turn: { a: number; b: number };
  spans: BeatSpans;
  stops: { y: number; t: number }[];
  endTop: number;
  documentHeight: number;
  teamLines: Line[];
  worldLines: Line[];
};

const middleOf = (element: HTMLElement) => element.offsetTop + element.offsetHeight / 2;

function makeLine(svg: SVGSVGElement, d: string): Line {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  const dot = document.createElementNS(SVG_NS, "circle");
  svg.append(dot);
  const length = Math.max(1, path.getTotalLength());
  path.style.strokeDasharray = String(length);
  return { path, dot, length };
}

/** Draws a curve from the chapter to each team card. */
function layoutTeam(parts: FilmParts, width: number) {
  const startX = width / 2;
  const startY = parts.hub.offsetTop;
  return parts.agents.map((agent, index) => {
    const endX = agent.offsetLeft + (index % 2 ? 0 : agent.offsetWidth);
    const endY = agent.offsetTop + 50;
    const midX = (startX + endX) / 2;
    const line = makeLine(
      parts.teamLines,
      `M${startX} ${startY} C${midX} ${startY},${midX} ${endY},${endX} ${endY}`,
    );
    line.dot.setAttribute("r", "4.5");
    return line;
  });
}

/** Joins each world note to the last, along the sides that face each other. */
function layoutWorld(parts: FilmParts) {
  const [first, second, third, fourth] = parts.worldNotes.map((note) => ({
    left: note.offsetLeft - 18,
    right: note.offsetLeft + note.offsetWidth + 16,
    top: note.offsetTop - 18,
    bottom: note.offsetTop + note.offsetHeight + 18,
    x: note.offsetLeft + note.offsetWidth / 2,
    y: note.offsetTop + 9,
  }));
  const routes = [
    [first.right, first.y, second.left, second.y],
    [second.x, second.bottom, third.x, third.top],
    [third.left, third.y, fourth.right, fourth.y],
  ];
  return routes.map(([fromX, fromY, toX, toY]) => {
    const line = makeLine(parts.worldLines, `M${fromX} ${fromY} L${toX} ${toY}`);
    line.dot.setAttribute("cx", String(toX));
    line.dot.setAttribute("cy", String(toY));
    line.dot.setAttribute("r", "3.2");
    return line;
  });
}

/** Where the workspace block lands at dawn, beside the caption or under it on a phone. */
function workspaceRect(parts: FilmParts, layout: { width: number; height: number; bar: number }) {
  const { width, height, bar } = layout;
  const { caption } = parts;
  const left = caption.offsetLeft;
  const blockWidth = Math.min(
    width - left - caption.offsetWidth - 72,
    (height - bar - 48) / 0.625,
    1020,
  );
  return {
    x: width - blockWidth - 36,
    y: Math.max(bar + 20, (height + bar - blockWidth * 0.625) / 2),
    w: blockWidth,
  };
}

/**
 * Reads the geometry CSS laid out, and works out what only script can: where the
 * film's layers go and how far each beat scrolls.
 */
export function measureLayout(parts: FilmParts): Layout {
  const html = document.documentElement;
  const isPhone = matchMedia(PHONE_QUERY).matches;
  const isShort = matchMedia(SHORT_QUERY).matches;
  const windowWidth = html.clientWidth;
  const width = parts.stage.clientWidth;
  const height = innerHeight;
  const bar = Number.parseFloat(getComputedStyle(html).getPropertyValue("--bar"));
  const { blockHome, block, caption, chapterOpening, lastTypedParagraph } = parts;

  parts.teamLines.replaceChildren();
  parts.worldLines.replaceChildren();
  const teamLines = isPhone ? [] : layoutTeam(parts, width);
  const worldLines = isPhone ? [] : layoutWorld(parts);

  html.style.setProperty(
    "--cy",
    `${
      isPhone
        ? bar + 16
        : Math.max(
            bar + 24,
            Math.min(
              (height + bar - caption.offsetHeight) / 2,
              height * 0.71 - caption.offsetHeight,
            ),
          )
    }px`,
  );

  const home = { x: blockHome.offsetLeft, y: blockHome.offsetTop, w: blockHome.offsetWidth };
  const onPhone = { x: home.x, y: bar + 16 + caption.offsetHeight + 14, w: home.w };
  const workspace = isShort
    ? home
    : isPhone
      ? onPhone
      : workspaceRect(parts, { width, height, bar });

  const anchor = height * 0.44;
  const { a: turnA, b: turnB } = parts.turnParagraphs;
  const turnPosition = (shown: HTMLElement, other: HTMLElement) => {
    const wasShown = [shown.hidden, other.hidden];
    shown.hidden = false;
    other.hidden = true;
    const middle = middleOf(shown) - anchor;
    [shown.hidden, other.hidden] = wasShown;
    return middle;
  };

  const { spans, stops, length } = spanBeats(height);
  html.style.setProperty("--filmh", `${length + height}px`);
  const documentHeight = html.scrollHeight;
  return {
    windowWidth,
    width,
    height,
    isPhone,
    home,
    workspace,
    blockLayoutWidth: block.offsetWidth,
    chapterFrom: middleOf(chapterOpening) - anchor,
    chapterTo: middleOf(lastTypedParagraph) - anchor,
    turn: {
      a: turnPosition(turnA, turnB),
      b: turnPosition(turnB, turnA),
    },
    spans,
    stops,
    endTop: parts.end.offsetTop,
    documentHeight,
    teamLines,
    worldLines,
  };
}
