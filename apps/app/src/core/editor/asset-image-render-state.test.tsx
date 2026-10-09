// @vitest-environment jsdom
/**
 * A picture that names a document renders that document: the picture asks
 * through its editor's requester while it is mounted, and the render state
 * draws the answer through the same signed-URL lifecycle as an `asset:`
 * picture, or says honestly that nothing is there.
 */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { getFigureSignedUrl } from "@/client/api/figures-api";

import { type AssetImageRenderState, useAssetImageRenderState } from "./asset-image-render-state";
import { createStandaloneEditorExtensions } from "./config";
import { type LinkAnswer, type LinkQuestion, linkTargetHref } from "./links";
import { type MountedLinks, mountedLinks } from "./links/link-storage";

vi.mock("@/client/api/figures-api", () => ({ getFigureSignedUrl: vi.fn() }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const SETTLED = "ahead:00000000-0000-4000-8000-0000000000a1";
const UNSETTLED = "ahead:00000000-0000-4000-8000-0000000000a2";
const MAP_ID = "00000000-0000-4000-8000-0000000000d1";
const PLATE_ID = "00000000-0000-4000-8000-0000000000d2";
const GONE = "doc:00000000-0000-4000-8000-0000000000d3";
const ASSET_ID = "00000000-0000-4000-8000-0000000000d4";
const SEAL_ID = "00000000-0000-4000-8000-0000000000d5";
const NEXT = "ahead:00000000-0000-4000-8000-0000000000a3";

function documentAnswer(documentId: string, path: string): LinkAnswer {
  return {
    state: "document",
    document: {
      documentId,
      title: path,
      scheme: "manuscript",
      path,
      uri: `manuscript://${path}`,
      workId: null,
    },
  };
}

const ANSWERS: Record<string, LinkAnswer> = {
  [SETTLED]: documentAnswer(MAP_ID, "uploads/map.png"),
  [`doc:${PLATE_ID}`]: documentAnswer(PLATE_ID, "art/plate.png"),
  [UNSETTLED]: { state: "missing", document: null },
  [GONE]: { state: "gone", document: null },
  // A ref-less question is answered by its address.
  "uploads://seal.png": documentAnswer(SEAL_ID, "seal.png"),
};

function Probe(props: {
  src: string;
  pictureRef: string | null;
  links: MountedLinks | null;
  report: (state: AssetImageRenderState) => void;
}) {
  const [state] = useAssetImageRenderState({
    projectId: "project-a",
    src: props.src,
    ref: props.pictureRef,
    links: props.links,
  });
  props.report(state);
  return null;
}

it("renders a picture's ref through the link resolver, and says when nothing is there", async () => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(getFigureSignedUrl).mockImplementation(async ({ assetDocumentId }) => ({
    assetDocumentId,
    storageUrl: `s3://bucket/${assetDocumentId}`,
    mimeType: "image/png",
    fileType: "image",
    signedUrl: `https://signed.example/${assetDocumentId}`,
    signedUrlExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  const rows: { row: string; src: string; ref: string | null; drawn: unknown }[] = [
    {
      row: "a settled ahead picture renders the document it settled on",
      src: "manuscript://art/map.png",
      ref: SETTLED,
      drawn: { kind: "ready", url: `https://signed.example/${MAP_ID}` },
    },
    {
      row: "an asset-less doc: picture renders its document",
      src: "manuscript://art/plate.png",
      ref: `doc:${PLATE_ID}`,
      drawn: { kind: "ready", url: `https://signed.example/${PLATE_ID}` },
    },
    {
      row: "an unsettled ahead picture says it has not been uploaded",
      src: "manuscript://art/later.png",
      ref: UNSETTLED,
      drawn: {
        kind: "unavailable",
        url: null,
        message: "No image has been uploaded to art/later.png yet.",
      },
    },
    {
      row: "a gone picture says it is no longer available",
      src: "manuscript://art/doomed.png",
      ref: GONE,
      drawn: { kind: "unavailable", url: null, message: "This image is no longer available." },
    },
    {
      row: "an asset: picture is unchanged",
      src: `asset:${ASSET_ID}`,
      ref: null,
      drawn: { kind: "ready", url: `https://signed.example/${ASSET_ID}` },
    },
    {
      row: "a literal source is unchanged",
      src: "https://cdn.example/map.png",
      ref: null,
      drawn: { kind: "ready", url: "https://cdn.example/map.png" },
    },
    {
      row: "a protocol-relative source stays literal",
      src: "//cdn.example/map.png",
      ref: null,
      drawn: { kind: "ready", url: "//cdn.example/map.png" },
    },
    {
      // The binder leaves a contextual source ref-less; it resolves by address
      // like a ref-less link, never drawn as a literal URL that cannot load.
      row: "a ref-less internal picture renders the document at its address",
      src: "uploads://seal.png",
      ref: null,
      drawn: { kind: "ready", url: `https://signed.example/${SEAL_ID}` },
    },
  ];

  // The node views' own editor: its link cache and its one requester.
  const editor = new Editor({ extensions: createStandaloneEditorExtensions({}) });
  const links = mountedLinks(editor);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    const resolution = links?.resolution;
    const asked: LinkQuestion[][] = [];
    const named = (batch: readonly LinkQuestion[] | undefined) =>
      batch?.map(({ ref, target }) => ref ?? linkTargetHref(target)).sort();
    resolution?.registerResolver({
      remote: async (questions) => {
        asked.push([...questions]);
        return questions.map(({ ref, target }) => ANSWERS[ref ?? linkTargetHref(target)] ?? null);
      },
    });

    // Nothing in the test requests a key: each mounted picture watches its
    // own, and a page of them is one batch.
    const drawn = new Map<string, AssetImageRenderState>();
    await act(async () => {
      root.render(
        rows.map(({ row, src, ref }) => (
          <Probe
            key={row}
            src={src}
            pictureRef={ref}
            links={links}
            report={(state) => drawn.set(row, state)}
          />
        )),
      );
    });
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect
      .soft(named(asked[0]), "picture refs, and ref-less internal sources by address")
      .toEqual([SETTLED, UNSETTLED, GONE, `doc:${PLATE_ID}`, "uploads://seal.png"].sort());
    await vi.waitFor(() => {
      for (const { row, drawn: expected } of rows)
        expect(drawn.get(row), row).toMatchObject(expected as object);
    });

    // A retarget (a ref or source update, undo, a peer's edit) reuses the node
    // view: the previous picture must not stay drawn while the new one is out.
    const retargeted: AssetImageRenderState[] = [];
    const retarget = (src: string, pictureRef: string) => (
      <Probe
        src={src}
        pictureRef={pictureRef}
        links={links}
        report={(state) => retargeted.push(state)}
      />
    );
    await act(async () => root.render(retarget("manuscript://art/map.png", SETTLED)));
    await vi.waitFor(() => expect(retargeted.at(-1)).toMatchObject({ kind: "ready" }));
    // A catalog change is a new generation whose answers have not arrived.
    // Unmounted pictures were released, so it asks about the one still shown.
    const revalidating: LinkQuestion[][] = [];
    const unanswered = (questions: readonly LinkQuestion[]) => {
      revalidating.push([...questions]);
      return new Promise<never>(() => {});
    };
    await act(async () => {
      resolution?.registerResolver({ remote: unanswered });
    });
    expect
      .soft(retargeted.at(-1), "the same picture stays drawn while it revalidates")
      .toEqual({ kind: "loading", url: `https://signed.example/${MAP_ID}` });
    await act(async () => root.render(retarget("manuscript://art/next.png", NEXT)));
    expect
      .soft(retargeted.at(-1), "a retargeted picture loads without the previous one")
      .toEqual({ kind: "loading", url: null });
    // A retargeted picture asks about its new key and releases the old one.
    await act(async () => {
      resolution?.registerResolver({ remote: unanswered });
    });
    await vi.waitFor(() => expect(revalidating).toHaveLength(3));
    expect
      .soft(revalidating.map(named), "unmounted and retargeted keys are released")
      .toEqual([[SETTLED], [NEXT], [NEXT]]);
  } finally {
    act(() => root.unmount());
    editor.destroy();
  }
});
