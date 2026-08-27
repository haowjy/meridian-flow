/** Browser regression for the compiled dropdown and composer-control cascade. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";
import { buttonVariants } from "../src/components/ui/button";
import {
  dropdownRowContainerClass,
  dropdownRowVariants,
} from "../src/components/ui/dropdown-presentation";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overflowControlClass = buttonVariants({
  variant: "quiet",
  size: "icon-sm",
  className: "[@media(pointer:coarse)]:size-11",
});

let compiledCss: string;

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      write: false,
      rollupOptions: { input: "src/styles/globals.css" },
    },
  });
  const builds = Array.isArray(result) ? result : [result];
  const output = builds.flatMap((buildResult) => {
    if (!("output" in buildResult)) throw new Error("Vite unexpectedly entered watch mode");
    return buildResult.output;
  });
  const stylesheet = output.find(
    (item): item is Rollup.OutputAsset => item.type === "asset" && item.fileName.endsWith(".css"),
  );
  if (!stylesheet) throw new Error("Vite did not emit the app stylesheet");
  compiledCss = String(stylesheet.source);
});

test.beforeEach(async ({ page }) => {
  await page.setContent(`
    <main id="surface" class="bg-popover" style="width:240px">
      <button id="direct" class="${dropdownRowVariants()}">Direct row</button>
      <div id="composite" class="${dropdownRowContainerClass}">
        <button id="composite-control" class="${dropdownRowVariants({ interactive: false })}">
          Composite row
        </button>
      </div>
      <div id="selected" class="${dropdownRowContainerClass}" data-selected="true">
        <button id="selected-control" class="${dropdownRowVariants({ interactive: false })}">
          Selected composite row
        </button>
      </div>
    </main>
    <button id="overflow" class="${overflowControlClass}">Visible overflow</button>
    <button id="probe" class="${overflowControlClass} pointer-events-none invisible absolute left-0 top-0" inert>
      Measurement probe
    </button>
  `);
  await page.addStyleTag({ content: compiledCss });
  await page.addStyleTag({ content: "* { transition: none !important; }" });
});

type Theme = "light" | "dark";

type ComputedShadowLayer = {
  inset: boolean;
  lengths: number[];
  color: string;
  serialized: string;
};

function computedShadowLayers(shadow: string, indicatorColor: string): ComputedShadowLayer[] {
  const layers: string[] = [];
  let start = 0;
  let parentheses = 0;
  for (let index = 0; index < shadow.length; index += 1) {
    if (shadow[index] === "(") parentheses += 1;
    else if (shadow[index] === ")") parentheses -= 1;
    else if (shadow[index] === "," && parentheses === 0) {
      layers.push(shadow.slice(start, index).trim());
      start = index + 1;
    }
  }
  layers.push(shadow.slice(start).trim());

  return layers.map((serialized) => ({
    inset: /(?:^|\s)inset(?:\s|$)/.test(serialized),
    lengths: [...serialized.matchAll(/(-?(?:\d+(?:\.\d+)?|\.\d+))px/g)].map((match) =>
      Number(match[1]),
    ),
    color: serialized.includes(indicatorColor) ? indicatorColor : "",
    serialized,
  }));
}

function expectSemanticFocusRails(shadow: string, indicatorColor: string) {
  const layers = computedShadowLayers(shadow, indicatorColor);
  const semanticInsetLayers = layers.filter(
    (layer) => layer.inset && layer.color === indicatorColor,
  );
  const hasGeometry = (layer: ComputedShadowLayer, yOffset: number) =>
    layer.lengths.length === 4 &&
    layer.lengths[0] === 0 &&
    layer.lengths[1] === yOffset &&
    layer.lengths[2] === 0 &&
    layer.lengths[3] === 0;

  expect(semanticInsetLayers.filter((layer) => hasGeometry(layer, 2))).toHaveLength(1);
  expect(semanticInsetLayers.filter((layer) => hasGeometry(layer, -2))).toHaveLength(1);
  expect(
    layers.filter(
      (layer) =>
        layer.inset &&
        layer.lengths.length === 4 &&
        layer.lengths[0] === 0 &&
        layer.lengths[1] === 0 &&
        layer.lengths[3] !== 0,
    ),
  ).toHaveLength(0);
}

async function setTheme(page: import("@playwright/test").Page, theme: Theme) {
  await page.evaluate((nextTheme) => {
    if (nextTheme === "dark") document.documentElement.dataset.uiTheme = "dark";
    else document.documentElement.removeAttribute("data-ui-theme");
  }, theme);
}

test("resolves semantic colors and effective direct/composite row paint", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);

    const semantic = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        popover: root.getPropertyValue("--color-popover").trim(),
        selected: root.getPropertyValue("--color-sidebar-accent").trim(),
        indicator: root.getPropertyValue("--color-dropdown-focus-indicator").trim(),
      };
    });
    expect(semantic.popover).not.toContain("var(");
    expect(semantic.selected).not.toContain("var(");
    expect(semantic.indicator).not.toContain("var(");
    const indicatorColor = await page.evaluate((indicator) => {
      const reference = document.createElement("span");
      reference.style.color = indicator;
      document.body.append(reference);
      const color = getComputedStyle(reference).color;
      reference.remove();
      return color;
    }, semantic.indicator);
    const expectedBackground = await page.evaluate(({ popover, selected }) => {
      const resolve = (background: string) => {
        const reference = document.createElement("span");
        reference.style.background = background;
        document.body.append(reference);
        const color = getComputedStyle(reference).backgroundColor;
        reference.remove();
        return color;
      };
      return {
        popover: resolve(popover),
        focused: resolve(`color-mix(in oklab, ${selected} 50%, transparent)`),
        selected: resolve(selected),
      };
    }, semantic);

    const effective = await page.evaluate(() => {
      const styles = (id: string) => {
        const node = document.getElementById(id);
        if (!node) throw new Error(`Missing #${id}`);
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          background: style.backgroundColor,
          radius: style.borderRadius,
          shadow: style.boxShadow,
          left: box.left,
          right: box.right,
        };
      };
      const surfaceNode = document.getElementById("surface");
      if (!surfaceNode) throw new Error("Missing surface");
      const surface = surfaceNode.getBoundingClientRect();
      return {
        surface: {
          background: getComputedStyle(surfaceNode).backgroundColor,
          left: surface.left,
          right: surface.right,
        },
        direct: styles("direct"),
        composite: styles("composite"),
        selected: styles("selected"),
      };
    });

    await page.locator("#direct").focus();
    const directFocused = await page.locator("#direct").evaluate((node) => ({
      visible: node.matches(":focus-visible"),
      background: getComputedStyle(node).backgroundColor,
      shadow: getComputedStyle(node).boxShadow,
    }));
    const contrast = await page.evaluate(({ popover, selected, indicator }) => {
      const pixel = (color: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("No 2D canvas context");
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data] as [number, number, number, number];
      };
      const contrast = (a: number[], b: number[]) => {
        const luminance = (rgb: number[]) => {
          const linear = rgb.slice(0, 3).map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const composite = (front: number[], back: number[]) => {
        const alpha = front[3] / 255;
        return front
          .slice(0, 3)
          .map((channel, index) => channel * alpha + back[index] * (1 - alpha));
      };
      const popoverPixel = pixel(popover);
      const selectedPixel = pixel(selected);
      const indicatorPixel = pixel(indicator);
      const direct = document.getElementById("direct");
      if (!direct) throw new Error("Missing direct row");
      const halfPixel = pixel(getComputedStyle(direct).backgroundColor);
      return {
        popover: contrast(indicatorPixel, popoverPixel),
        focused: contrast(indicatorPixel, composite(halfPixel, popoverPixel)),
        selected: contrast(indicatorPixel, selectedPixel),
      };
    }, semantic);
    await page.locator("#composite-control").focus();
    const compositeFocused = await page.locator("#composite").evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      shadow: getComputedStyle(node).boxShadow,
    }));
    await page.locator("#selected-control").focus();
    const selectedFocused = await page.locator("#selected").evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      shadow: getComputedStyle(node).boxShadow,
    }));

    expect(directFocused.visible).toBe(true);
    expect(effective.surface.background).toBe(expectedBackground.popover);
    expect(directFocused.background).toBe(expectedBackground.focused);
    expect(directFocused.background).toBe(compositeFocused.background);
    expect(effective.selected.background).toBe(expectedBackground.selected);
    expect(selectedFocused.background).toBe(effective.selected.background);
    for (const shadow of [directFocused.shadow, compositeFocused.shadow, selectedFocused.shadow]) {
      expectSemanticFocusRails(shadow, indicatorColor);
    }
    for (const row of [effective.direct, effective.composite, effective.selected]) {
      expect(row.radius).toBe("0px");
      expect(row.left).toBe(effective.surface.left);
      expect(row.right).toBe(effective.surface.right);
    }
    for (const ratio of Object.values(contrast)) expect(ratio).toBeGreaterThanOrEqual(3);
  }
});

test("measures the visible overflow control and inert allocation probe", async ({
  page,
}, testInfo) => {
  const coarse = testInfo.project.name === "coarse-pointer";
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
  const expected = coarse ? 44 : 32;
  for (const id of ["overflow", "probe"]) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box?.width).toBeCloseTo(expected, 3);
    expect(box?.height).toBeCloseTo(expected, 3);
  }
  await expect(page.locator("#overflow")).toBeVisible();
  await expect(page.locator("#probe")).toBeHidden();
});
