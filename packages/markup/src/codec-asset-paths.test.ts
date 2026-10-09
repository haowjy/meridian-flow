import { describe, expect, it } from "vitest";
import { createAssetFixture, docFrom, paragraph, parsedDoc, schema } from "./codec-test-support.js";
import { markdownCodec } from "./index.js";

describe("asset path resolution", () => {
  const assets = createAssetFixture([["asset-1", "assets/map.png"]]);
  const codec = markdownCodec({ schema, assetForPath: assets.assetForPath });

  it("stores stable refs internally and emits project-relative paths", () => {
    const parsed = codec.parse("![World map](assets/map.png)").blocks[0];
    if (!parsed) throw new Error("expected parsed image paragraph");
    expect(parsed?.firstChild?.attrs.src).toBe("asset:asset-1");
    expect(codec.serialize([parsed], assets.links)).toBe("![World map](assets/map.png)\n");
  });

  it("leaves external and unknown paths literal", () => {
    for (const src of ["https://example.com/map.png", "assets/missing.png"]) {
      expect(codec.parse(`![](${src})`).blocks[0]?.firstChild?.attrs.src).toBe(src);
    }
  });

  // An image whose document is gone entirely must not take the chapter's
  // serialization with it, and a read-then-write must not lose the reference.
  it("spells a ref with no document as the ref, which parses back to itself", () => {
    const orphan = paragraph(schema.node("image", { src: "asset:gone", alt: "Map", title: null }));
    const serialized = codec.serialize([orphan], assets.links);
    expect(serialized).toBe("![Map](asset:gone)\n");
    expect(parsedDoc(codec, serialized).toJSON()).toEqual(docFrom([orphan]).toJSON());
  });

  // A picture the editor has reserved a slot for but not uploaded yet carries
  // `src: ""` — the one source that names nothing. The wire has to hold it
  // without inventing an address: an `asset:` ref minted before its asset
  // exists would reach the wire as a ref nothing can render.
  it("round-trips a source-less image instead of resolving one", () => {
    const pending = paragraph(schema.node("image", { src: "", alt: "cover art", title: null }));
    const serialized = codec.serialize([pending], assets.links);
    expect(serialized).toBe("![cover art]()\n");
    expect(parsedDoc(codec, serialized).toJSON()).toEqual(docFrom([pending]).toJSON());
  });

  // The token naming which browser is filling that slot is a live-session fact
  // (`apps/app/src/core/editor/images/pending-images.ts`), so the wire form is
  // the same `![alt]()` and a re-opened document carries no owner at all.
  it("never writes an in-flight slot's upload token to the wire", () => {
    const inFlight = paragraph(
      schema.node("image", {
        src: "",
        alt: "cover art",
        title: null,
        uploadToken: "image-upload:7f3a91c0:1",
      }),
    );
    const serialized = codec.serialize([inFlight], assets.links);
    expect(serialized).toBe("![cover art]()\n");
    expect(parsedDoc(codec, serialized).firstChild?.firstChild?.attrs.uploadToken).toBe(null);
  });
});
