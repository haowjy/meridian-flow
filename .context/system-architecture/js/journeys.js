/*
 * The journeys viewer: journeys/index.md lists the journeys, each journey page is a row of
 * step cards (title, a place for the step's screenshot when it has one, Does, Sees). A card opens its links in the
 * panel: map links go to the map at that box, machine links render in the overlay. The URL
 * hash is `#<journey>` or `#<journey>/<step number>`.
 */
import { initDocView, openDoc, paintInline } from "./doc-view.js";
import { item, JOURNEY_KEYS, linksOf, MAP_DIR, resolveHref } from "./pages.js";
import { el, fetchPage, fetchRepoFile, loadLevels, topBar } from "./shell.js";

const INDEX = ".context/state-machines/index.md";
const JOURNEYS = `${MAP_DIR}/journeys`;

const content = el("div", { class: "journeys" });
const panel = el("aside", { class: "panel", "aria-label": "Selected step" });
const workspace = el("div", { class: "workspace" }, content, panel);
const app = document.getElementById("app");
let journeys = [];

async function main() {
  const levels = await loadLevels();
  app.replaceChildren(topBar({ current: "journeys", levels, onMachines: () => openDoc(INDEX) }), workspace);
  initDocView(workspace);
  const hrefs = [...new Set(linksOf(await fetchRepoFile(`${JOURNEYS}/index.md`)).map((l) => l.href))];
  journeys = await Promise.all(
    hrefs.filter((h) => /^[\w-]+\.md$/.test(h) && h !== "index.md").map(async (href) => ({ id: href.slice(0, -3), path: `${JOURNEYS}/${href}`, page: await fetchPage(`${JOURNEYS}/${href}`) })),
  );
  content.replaceChildren(
    ...journeys.map((j) =>
      el(
        "section",
        { class: "journey", id: j.id },
        el("h2", null, j.page.title),
        paragraph(j.page.intro, j.path),
        el("div", { class: "steps", tabindex: "0" }, j.page.sections.map((s, i) => card(j, s, i))),
      ),
    ),
  );
  enablePan();
  addEventListener("hashchange", select);
  select();
}

function paragraph(markdown, path) {
  const p = el("p", { class: "sub" });
  paintInline(p, markdown, path);
  return p;
}

/** The text after "Does:" / "Sees:" in a step's paragraphs. */
const field = (section, name) => section.paragraphs.find((p) => p.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";

function card(journey, section, i) {
  return el(
    "article",
    { class: "step", id: `${journey.id}/${i + 1}`, tabindex: "0", role: "button", onclick: () => open(journey, i), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(journey, i)) },
    el("div", { class: "step-no" }, `${i + 1}`),
    el("h3", null, section.id),
    item(section, "Shot") && el("div", { class: "shot", "aria-hidden": "true" }),
    el("h4", null, "Does"),
    paragraph(field(section, "Does"), journey.path),
    el("h4", null, "Sees"),
    paragraph(field(section, "Sees"), journey.path),
  );
}

const open = (journey, i) => {
  location.hash = `${journey.id}/${i + 1}`;
};

function select() {
  const [id, n] = location.hash.slice(1).split("/");
  for (const c of content.querySelectorAll(".step")) c.classList.toggle("is-selected", c.id === `${id}/${n}`);
  const journey = journeys.find((j) => j.id === id);
  const section = journey?.page.sections[Number(n) - 1];
  if (!section) {
    panel.replaceChildren(el("div", { class: "panel-body" }, el("h2", null, "Writer journeys"), el("p", { class: "panel-hint" }, "Click a step to see where it lives in the system.")));
    if (journey) content.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView();
    return;
  }
  content.querySelector(`[id="${id}/${n}"]`)?.scrollIntoView({ inline: "center", block: "nearest" });
  const groups = JOURNEY_KEYS.flatMap((key) => {
    const value = item(section, key)?.value;
    if (!value || key === "Shot") return [];
    return [
      el(
        "section",
        null,
        el("h3", null, key === "Map" ? "On the map" : "State machines"),
        el("ul", null, linksOf(value).map((l) => link(journey, key, l))),
      ),
    ];
  });
  panel.replaceChildren(el("div", { class: "panel-body" }, el("h2", null, section.id), el("p", { class: "sub" }, journey.page.title), field(section, "Source") && paragraph(`Source: ${field(section, "Source")}`, journey.path), ...groups));
}

function link(journey, key, { label, href }) {
  const { path, fragment } = resolveHref(journey.path, href);
  if (key === "Map") {
    const page = path?.slice(MAP_DIR.length + 1).replace(/\.md$/, "");
    return el("li", null, el("a", { href: `index.html#${page}${fragment ? `/${fragment}` : ""}` }, label));
  }
  const doc = fragment ? `${path}#${fragment}` : path;
  return el("li", null, el("a", { href: `?doc=${encodeURIComponent(doc)}`, "data-doc": doc }, label));
}

/** Drag the card rows sideways. */
function enablePan() {
  let drag = null;
  content.addEventListener("pointerdown", (event) => {
    const row = event.target.closest(".steps");
    if (!row || event.button) return;
    drag = { row, x: event.clientX, left: row.scrollLeft, moved: false };
  });
  content.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    drag.row.scrollLeft = drag.left - dx;
  });
  const end = () => {
    if (drag?.moved) content.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true });
    drag = null;
  };
  content.addEventListener("pointerup", end);
  content.addEventListener("pointercancel", end);
}

main().catch((error) => {
  app.replaceChildren(el("p", { class: "doc-note", style: "padding: 24px" }, `The journeys didn't load: ${error.message ?? error}`));
});
