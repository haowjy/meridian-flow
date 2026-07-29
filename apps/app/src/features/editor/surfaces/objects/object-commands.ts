/**
 * The verbs behind the object row, the ⋮ menu, and the code chips.
 *
 * Document operations dispatch through the editor; export operations touch the
 * clipboard and the filesystem. Both are here so the components stay about
 * arrangement and state, and so a verb can be tested without a surface.
 */

import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";

/** The text a code fence holds — a diagram's Mermaid source, or plain code. */
export function fenceSource(editor: Editor, pos: number): string {
  return editor.state.doc.nodeAt(pos)?.textContent ?? "";
}

export type TextPatch = { from: number; to: number; text: string };

/**
 * The smallest edit that turns `current` into `next`.
 *
 * A source pane that replaced the whole fence on every keystroke would hand
 * Yjs a delete-and-reinsert of the entire diagram per character: peer carets
 * inside it would be flung to the end, and the change trail would read as a
 * rewrite. Common prefix and suffix is all it takes to make the edit look like
 * what the writer actually did.
 */
export function minimalTextPatch(current: string, next: string): TextPatch | null {
  if (current === next) return null;

  let prefix = 0;
  const shortest = Math.min(current.length, next.length);
  while (prefix < shortest && current[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    from: prefix,
    to: current.length - suffix,
    text: next.slice(prefix, next.length - suffix),
  };
}

/** Rewrite a fence's text in place, as the smallest edit that gets there. */
export function setFenceSource(editor: Editor, pos: number, next: string): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;

  const patch = minimalTextPatch(node.textContent, next);
  if (!patch) return false;

  const start = pos + 1;
  editor.view.dispatch(
    editor.state.tr.insertText(patch.text, start + patch.from, start + patch.to),
  );
  return true;
}

export function setFenceLanguage(editor: Editor, pos: number, language: string): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language }));
  return true;
}

/** Place a copy directly after the object, and select it. */
export function duplicateObject(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.insert(pos + node.nodeSize, node));
  return true;
}

export function deleteObject(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, Fragment.empty));
  editor.commands.focus();
  return true;
}

// ── export ────────────────────────────────────────────────────────────────

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Mermaid emits `width="100%"` with the real dimensions in the `viewBox`,
 * which is right for a diagram that flows in a page and useless for a file:
 * an SVG with no intrinsic size rasterizes to nothing and opens at whatever
 * the viewer feels like. Exports get their own sized copy of the markup; the
 * rendered SVG in the document is never touched.
 */
export function sizedSvgMarkup(svg: string): { markup: string; width: number; height: number } {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const [, , boxWidth, boxHeight] = (parsed.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number);

  const width = Number.isFinite(boxWidth) && boxWidth > 0 ? boxWidth : 800;
  const height = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : 600;
  parsed.setAttribute("width", String(width));
  parsed.setAttribute("height", String(height));

  return { markup: new XMLSerializer().serializeToString(parsed), width, height };
}

/** Raster scale for image export: a diagram is read at 100%, not sampled. */
const EXPORT_PIXEL_RATIO = 2;

export async function svgToPngBlob(svg: string): Promise<Blob> {
  const { markup, width, height } = sizedSvgMarkup(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The diagram could not be rasterized"));
      image.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width * EXPORT_PIXEL_RATIO;
    canvas.height = height * EXPORT_PIXEL_RATIO;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The diagram could not be rasterized");
    context.scale(EXPORT_PIXEL_RATIO, EXPORT_PIXEL_RATIO);
    context.drawImage(image, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The diagram could not be rasterized"))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Put a rendered diagram on the clipboard as an image.
 *
 * The ⋮ verb, not the row's copy chip: image-copy is the clipboard API's
 * fussiest corner and the row's copy puts Mermaid source there instead —
 * source is the bridge into the chat loop where diagrams get revised, and it
 * works in every browser (ruling 8's delegated call).
 */
export async function copySvgImage(svg: string): Promise<void> {
  const blob = await svgToPngBlob(svg);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export function downloadPng(svg: string, filename: string): Promise<void> {
  return svgToPngBlob(svg).then((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  });
}

/**
 * The SVG the page already rendered for this diagram.
 *
 * Reading it back beats rendering a second copy: it is the exact markup the
 * writer is looking at, mermaid ids and all, and no parse runs to produce it.
 */
export function renderedDiagramSvg(element: HTMLElement): string | null {
  return element.querySelector("[data-mermaid-preview] svg")?.outerHTML ?? null;
}

/**
 * Put a raster image on the clipboard.
 *
 * Fetched rather than read off the element because the clipboard wants bytes,
 * and a signed asset URL is the only place they exist. A cross-origin host
 * without CORS will reject this, which is why the caller shows the failure
 * instead of assuming success (law 5).
 */
export async function copyImageFrom(url: string): Promise<void> {
  if (!url) throw new Error("The image has no source to copy");
  const response = await fetch(url);
  if (!response.ok) throw new Error("The image could not be read");
  const blob = await response.blob();

  // PNG is the only raster type every clipboard implementation accepts; a JPEG
  // or a WebP has to be transcoded on the way.
  const png = blob.type === "image/png" ? blob : await transcodeToPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ [png.type]: png })]);
}

export async function downloadImageFrom(url: string, filename?: string): Promise<void> {
  if (!url) throw new Error("The image has no source to download");
  const response = await fetch(url);
  if (!response.ok) throw new Error("The image could not be read");
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename ?? url.split("/").pop()?.split("?")[0] ?? "image";
  link.click();
  URL.revokeObjectURL(objectUrl);
}

async function transcodeToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("The image could not be converted"))),
      "image/png",
    );
  });
}
