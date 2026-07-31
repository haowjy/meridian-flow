/**
 * Where the caret is, in a control that will not say.
 *
 * A `<textarea>` has no client rect for a position inside it and no
 * `Range` to ask, so the only way to find the caret is to draw the same text
 * again somewhere invisible, under the same rules, and read where it lands.
 * The mirror copies every property that can move a glyph — the font, the
 * wrapping, the padding, the width the text actually flows in — and a marker
 * span sits exactly where the caret does.
 *
 * **The measurement can fail, and that is a supported answer.** A textarea
 * that has not laid out yet, a zero-width one behind a collapsed pane, a
 * browser that disagrees about a property nobody thought to copy: the menu
 * then anchors on the composer's own top edge instead. Degraded placement is
 * the contract; a missing menu is not.
 */

/**
 * Everything that decides where a glyph falls. Border widths are deliberately
 * absent: the mirror is sized to the textarea's `clientWidth`, which is the box
 * inside the borders, so copying them would inset the text a second time.
 */
const MIRRORED: readonly string[] = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "fontFeatureSettings",
  "fontKerning",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "textAlign",
  "textRendering",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "tabSize",
  "direction",
];

/** One mirror for the document, because a second one measures the same thing. */
let mirror: HTMLDivElement | null = null;

function takeMirror(): HTMLDivElement {
  if (mirror?.isConnected) return mirror;
  const element = document.createElement("div");
  element.setAttribute("aria-hidden", "true");
  element.style.position = "absolute";
  element.style.top = "0";
  element.style.left = "0";
  // Off-screen rather than `display: none`, which measures nothing at all, and
  // `visibility: hidden` so it is never read out or painted.
  element.style.transform = "translateX(-100000px)";
  element.style.visibility = "hidden";
  element.style.pointerEvents = "none";
  element.style.overflow = "hidden";
  element.style.boxSizing = "border-box";
  document.body.append(element);
  mirror = element;
  return element;
}

/**
 * The caret's box in client coordinates, or null when the control cannot be
 * measured. Width is zero — a caret is a position, not a glyph — and height is
 * one line, so a surface can hang off its top or its bottom edge.
 */
export function caretRect(textarea: HTMLTextAreaElement, caret: number): DOMRect | null {
  const box = textarea.getBoundingClientRect();
  const width = textarea.clientWidth;
  if (width === 0 || box.height === 0) return null;

  const computed = window.getComputedStyle(textarea);
  const element = takeMirror();
  for (const property of MIRRORED) {
    element.style.setProperty(property, computed.getPropertyValue(property));
  }
  // The composer forces `field-sizing: fixed` and grows by script, so the
  // mirror is sized to what the text is flowing in right now rather than to a
  // declared width that may be `auto`.
  element.style.width = `${width}px`;
  // A textarea wraps and preserves its own whitespace whatever the copied
  // `white-space` said, and a trailing newline needs a line of its own.
  element.style.whiteSpace = "pre-wrap";
  element.style.overflowWrap = "break-word";

  const value = textarea.value;
  element.textContent = value.slice(0, caret);
  const marker = document.createElement("span");
  // A marker with nothing in it has no box on some engines; the rest of the
  // text gives it one and keeps the wrapping honest around the caret.
  marker.textContent = value.slice(caret) || ".";
  element.append(marker);

  const line = Number.parseFloat(computed.lineHeight);
  const height = Number.isFinite(line) ? line : (Number.parseFloat(computed.fontSize) || 16) * 1.2;
  const top = box.top + marker.offsetTop - textarea.scrollTop;
  const left = box.left + marker.offsetLeft - textarea.scrollLeft;

  element.textContent = "";
  return new window.DOMRect(left, top, 0, height);
}

/** The composer frame's top edge, which is where a menu hangs when nothing else can be measured. */
export function frameAnchorRect(frame: HTMLElement | null): DOMRect | null {
  if (!frame) return null;
  const box = frame.getBoundingClientRect();
  return new window.DOMRect(box.left, box.top, box.width, 0);
}
