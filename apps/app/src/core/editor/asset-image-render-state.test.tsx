// @vitest-environment jsdom
/**
 * A picture that names a document renders that document: the editor's link
 * scan asks about image and figure refs, and the render state draws the answer
 * through the same signed-URL lifecycle as an `asset:` picture, or says
 * honestly that nothing is there.
 */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { getFigureSignedUrl } from "@/client/api/figures-api";

import { type AssetImageRenderState, useAssetImageRenderState } from "./asset-image-render-state";
import { createStandaloneEditorExtensions } from "./config";
import type { LinkAnswer, LinkAnswerCache, LinkQuestion } from "./links";
import { LINK_SURFACE_NAME } from "./links/link-storage";

vi.mock("@/client/api/figures-api", () => ({ getFigureSignedUrl: vi.fn() }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const SETTLED = "ahead:00000000-0000-4000-8000-0000000000a1";
const UNSETTLED = "ahead:00000000-0000-4000-8000-0000000000a2";
const MAP_ID = "00000000-0000-4000-8000-0000000000d1";
const PLATE_ID = "00000000-0000-4000-8000-0000000000d2";
const GONE = "doc:00000000-0000-4000-8000-0000000000d3";
const ASSET_ID = "00000000-0000-4000-8000-0000000000d4";

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
};

function Probe(props: {
  src: string;
  pictureRef: string | null;
  resolution: LinkAnswerCache;
  report: (state: AssetImageRenderState) => void;
}) {
  const [state] = useAssetImageRenderState({
    projectId: "project-a",
    src: props.src,
    ref: props.pictureRef,
    resolution: props.resolution,
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
  ];

  const editor = new Editor({
    extensions: createStandaloneEditorExtensions({
      assetRenderContext: { projectId: "project-a" },
    }),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: rows
            .filter(({ ref }) => ref !== GONE)
            .map(({ src, ref }) => ({ type: "image", attrs: { src, ref } })),
        },
        { type: "figure", attrs: { src: "manuscript://art/doomed.png", ref: GONE } },
      ],
    },
  });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    const resolution = editor.storage[LINK_SURFACE_NAME].resolution;
    const asked: LinkQuestion[] = [];
    resolution.registerResolver({
      remote: async (questions) => {
        asked.push(...questions);
        return questions.map(({ ref }) => (ref ? (ANSWERS[ref] ?? null) : null));
      },
    });
    // The editor's own scan asks about every ref-bearing picture, figures
    // included; nothing else in the test requests a key.
    await vi.waitFor(() => expect(asked.map(({ ref }) => ref).sort()).toHaveLength(4));
    expect
      .soft(asked.map(({ ref }) => ref).sort(), "the scan asks about picture refs")
      .toEqual([SETTLED, UNSETTLED, GONE, `doc:${PLATE_ID}`].sort());

    const drawn = new Map<string, AssetImageRenderState>();
    await act(async () => {
      root.render(
        rows.map(({ row, src, ref }) => (
          <Probe
            key={row}
            src={src}
            pictureRef={ref}
            resolution={resolution}
            report={(state) => drawn.set(row, state)}
          />
        )),
      );
    });
    await vi.waitFor(() => {
      for (const { row, drawn: expected } of rows)
        expect(drawn.get(row), row).toMatchObject(expected as object);
    });
  } finally {
    act(() => root.unmount());
    editor.destroy();
  }
});
