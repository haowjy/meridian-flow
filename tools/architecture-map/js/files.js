import { docHash, paintMarkdown } from "./markdown.js";
import { el } from "./shell.js";

export async function paintEntry(article, entry, path, fragment) {
  const scrollTo = (id) =>
    id && article.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });
  if (entry.kind === "dir") {
    article.className = "md";
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    article.replaceChildren(
      el(
        "ul",
        { class: "dir-list" },
        parent !== null && el("li", null, el("a", { href: docHash(parent) }, "↑ ", parent)),
        entry.entries.map((e) =>
          el(
            "li",
            { class: e.dir ? "is-dir" : null },
            el("a", { href: docHash(`${path}/${e.name}`) }, e.dir ? `${e.name}/` : e.name),
          ),
        ),
      ),
    );
    return `${path.split("/").at(-1)}/`;
  }
  if (entry.kind === "image") {
    article.className = "md";
    article.replaceChildren(el("img", { class: "doc-image", src: entry.url, alt: path }));
    return path.split("/").at(-1);
  }
  if (path.endsWith(".md")) {
    article.className = "md";
    await paintMarkdown(article, entry.text, path);
    scrollTo(fragment);
    return /^# (.+)$/m.exec(entry.text)?.[1] ?? path;
  }
  article.className = "code";
  const lines = entry.text.replace(/\n$/, "").split("\n");
  article.replaceChildren(
    ...lines.map((text, i) => el("div", { class: "line", id: `L${i + 1}` }, text || " ")),
  );
  const target = fragment && article.querySelector(`#${CSS.escape(fragment)}`);
  if (target) {
    target.classList.add("is-target");
    target.scrollIntoView({ block: "center" });
  }
  return path.split("/").at(-1);
}
