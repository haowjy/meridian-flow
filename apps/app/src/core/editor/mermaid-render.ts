/**
 * The mermaid render boundary: source text in, SVG markup out.
 *
 * Its own module because it is the one asynchronous, side-effecting edge of
 * diagram rendering — the mermaid bundle is loaded on first use and never
 * again, and a test that wants a diagram without a real parser fakes exactly
 * this function.
 */

let mermaidModule: Promise<typeof import("mermaid")["default"]> | null = null;

/**
 * `id` is written into the markup, so every consumer needs its own: two faces
 * of one diagram sharing an id collide over the arrow markers they reference,
 * and the page's diagram loses its arrowheads the moment the dialog opens.
 */
export async function renderMermaid(id: string, source: string): Promise<string> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      // Mermaid may fetch authored external images before SVG sanitization (#7645).
      // Documents are author-controlled; resource CSP belongs to future app-wide policy.
    });
    return mermaid;
  });
  const mermaid = await mermaidModule;
  return (await mermaid.render(id, source)).svg;
}
