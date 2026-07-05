// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderReadFragment, stripReadHashes } from "./read-preview-render";

describe("read preview rendering", () => {
  it("strips read block hashes from every line", () => {
    expect(stripReadHashes("abcd|# One\n1234abcd|Body\nnot-a-hash|kept")).toBe(
      "# One\nBody\nnot-a-hash|kept",
    );
  });

  it("renders manuscript markdown as semantic ProseMirror HTML", () => {
    const fragment = renderReadFragment("abcd|# Chapter\n1234|A **bold** _move_.");
    const host = document.createElement("div");
    if (fragment) host.append(fragment);

    expect(host.querySelector("h1")?.textContent).toBe("Chapter");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("em")?.textContent).toBe("move");
    expect(host.textContent).not.toContain("abcd|");
  });
});
