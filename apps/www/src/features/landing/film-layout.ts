import { type BeatSpans, type Span, spanBeats } from "./timeline";

const SVG_NS = "http://www.w3.org/2000/svg";

type Rect = { x: number; y: number; w: number };
type Line = { path: SVGPathElement; dot: SVGCircleElement; length: number };

export type FilmParts = {
  stage: HTMLElement;
  end: HTMLElement;
  blockHome: HTMLElement;
  workspaceSpot: HTMLElement;
  block: HTMLElement;
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
  subtitles: Record<string, Span>;
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

/**
 * Reads the geometry CSS laid out, and works out what only script can: where the
 * film's layers go and how far each beat scrolls.
 */
export function measureLayout(parts: FilmParts): Layout {
  const html = document.documentElement;
  const { stage, blockHome, workspaceSpot, block, chapterOpening, lastTypedParagraph } = parts;
  // The hub and its curves exist only where the team spreads around the chapter.
  const isPhone = parts.hub.offsetParent === null;
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  parts.teamLines.replaceChildren();
  parts.worldLines.replaceChildren();
  const teamLines = isPhone ? [] : layoutTeam(parts, width);
  const worldLines = isPhone ? [] : layoutWorld(parts);

  const rectOf = (element: HTMLElement) => ({
    x: element.offsetLeft,
    y: element.offsetTop,
    w: element.offsetWidth,
  });

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

  const { spans, stops, subtitles, length } = spanBeats(height);
  html.style.setProperty("--filmh", `${length + height}px`);
  const documentHeight = html.scrollHeight;
  return {
    windowWidth: html.clientWidth,
    width,
    height,
    isPhone,
    home: rectOf(blockHome),
    workspace: rectOf(workspaceSpot),
    blockLayoutWidth: block.offsetWidth,
    chapterFrom: middleOf(chapterOpening) - anchor,
    chapterTo: middleOf(lastTypedParagraph) - anchor,
    turn: {
      a: turnPosition(turnA, turnB),
      b: turnPosition(turnB, turnA),
    },
    spans,
    stops,
    subtitles,
    endTop: parts.end.offsetTop,
    documentHeight,
    teamLines,
    worldLines,
  };
}
