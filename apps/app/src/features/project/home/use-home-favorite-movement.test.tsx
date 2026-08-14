/** Rendered geometry and focus coverage for favorite movement lifecycle tokens. */
import { act } from "react";
import { describe, expect, it } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useHomeFavoriteMovement } from "./use-home-favorite-movement";

const rect = (top: number, bottom = top + 40) => ({
  top,
  bottom,
  left: 0,
  right: 400,
  width: 400,
  height: bottom - top,
  x: 0,
  y: top,
  toJSON() {},
});
describe("useHomeFavoriteMovement", () => {
  it("restores an unaffected anchor and focuses a visible keyboard destination", async () => {
    let movement!: ReturnType<typeof useHomeFavoriteMovement>;
    function Harness() {
      movement = useHomeFavoriteMovement();
      return (
        <div ref={movement.scrollRef}>
          <article data-home-card="moved">
            <button type="button" data-home-favorite="moved">
              star
            </button>
          </article>
          <article data-home-card="anchor">
            <button type="button">open</button>
          </article>
        </div>
      );
    }
    await withReactRoot(<Harness />, async () => {
      const container = document.getElementById("root") as HTMLElement;
      const scroll = container.firstElementChild as HTMLElement;
      Object.defineProperties(scroll, {
        scrollTop: { value: 100, writable: true },
        scrollHeight: { value: 1000 },
        clientHeight: { value: 300 },
      });
      scroll.getBoundingClientRect = () => rect(0, 300) as DOMRect;
      const moved = container.querySelector('[data-home-card="moved"]') as HTMLElement;
      const anchor = container.querySelector('[data-home-card="anchor"]') as HTMLElement;
      const star = container.querySelector('[data-home-favorite="moved"]') as HTMLElement;
      moved.getBoundingClientRect = () => rect(20) as DOMRect;
      anchor.getBoundingClientRect = () => rect(80) as DOMRect;
      star.getBoundingClientRect = () => rect(20) as DOMRect;
      const token = movement.capture("moved", true);
      anchor.getBoundingClientRect = () => rect(110) as DOMRect;
      await act(async () => movement.commit(token));
      expect(scroll.scrollTop).toBe(130);
      expect(document.activeElement).toBe(star);
    });
  });
  it("uses nearest survivor, temporary heading/scrollport tabindex, and never focuses for pointer", async () => {
    let movement!: ReturnType<typeof useHomeFavoriteMovement>;
    function Harness() {
      movement = useHomeFavoriteMovement();
      return (
        <div ref={movement.scrollRef}>
          <h2>Recent</h2>
          <article data-home-card="moved">
            <button type="button" data-home-favorite="moved">
              star
            </button>
          </article>
          <article data-home-card="near">
            <button type="button" data-near>
              near
            </button>
          </article>
        </div>
      );
    }
    await withReactRoot(<Harness />, async () => {
      const container = document.getElementById("root") as HTMLElement;
      const scroll = container.firstElementChild as HTMLElement;
      Object.defineProperties(scroll, {
        scrollTop: { value: 0, writable: true },
        scrollHeight: { value: 300 },
        clientHeight: { value: 200 },
      });
      scroll.getBoundingClientRect = () => rect(0, 200) as DOMRect;
      const moved = container.querySelector('[data-home-card="moved"]') as HTMLElement;
      const star = container.querySelector('[data-home-favorite="moved"]') as HTMLElement;
      const near = container.querySelector("[data-near]") as HTMLElement;
      const nearCard = container.querySelector('[data-home-card="near"]') as HTMLElement;
      const heading = container.querySelector("h2") as HTMLElement;
      moved.getBoundingClientRect = () => rect(20) as DOMRect;
      nearCard.getBoundingClientRect = () => rect(80) as DOMRect;
      star.getBoundingClientRect = () => rect(500) as DOMRect;
      near.getBoundingClientRect = () => rect(80) as DOMRect;
      heading.getBoundingClientRect = () => rect(10) as DOMRect;
      await act(async () => movement.commit(movement.capture("moved", true)));
      expect(document.activeElement).toBe(near);
      near.getBoundingClientRect = () => rect(500) as DOMRect;
      await act(async () => movement.commit(movement.capture("moved", true)));
      expect(document.activeElement).toBe(heading);
      expect(heading.hasAttribute("tabindex")).toBe(false);
      heading.getBoundingClientRect = () => rect(500) as DOMRect;
      await act(async () => movement.commit(movement.capture("moved", true)));
      expect(document.activeElement).toBe(scroll);
      expect(scroll.hasAttribute("tabindex")).toBe(false);
      const focused = document.activeElement;
      await act(async () => movement.commit(movement.capture("moved", false)));
      expect(document.activeElement).toBe(focused);
    });
  });
});
