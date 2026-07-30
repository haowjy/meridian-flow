import { describe, expect, it } from "vitest";

import { createAssetPathResolver } from "./asset-path-resolver.js";
import { docFrom, paragraph, parsedDoc, schema } from "./codec-test-support.js";
import { markdownCodec } from "./index.js";

describe("asset path resolution", () => {
  const assetPathResolver = createAssetPathResolver([["asset-1", "assets/map.png"]]);
  const codec = markdownCodec({ schema, assetPathResolver });

  it("stores stable refs internally and emits project-relative paths", () => {
    const parsed = codec.parse("![World map](assets/map.png)").blocks[0];
    if (!parsed) throw new Error("expected parsed image paragraph");
    expect(parsed?.firstChild?.attrs.src).toBe("asset:asset-1");
    expect(codec.serialize([parsed])).toBe("![World map](assets/map.png)\n");
  });

  it("leaves external and unknown paths literal", () => {
    for (const src of ["https://example.com/map.png", "assets/missing.png"]) {
      expect(codec.parse(`![](${src})`).blocks[0]?.firstChild?.attrs.src).toBe(src);
    }
  });

  // A picture the editor has reserved a slot for but not uploaded yet carries
  // `src: ""` — the one source that names nothing. The wire has to hold it
  // without inventing an address and without throwing: an `asset:` ref minted
  // before its asset exists would reach `pathForAsset` and take the whole
  // document's serialization with it.
  it("round-trips a source-less image instead of resolving one", () => {
    const pending = paragraph(schema.node("image", { src: "", alt: "cover art", title: null }));
    const serialized = codec.serialize([pending]);
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
    const serialized = codec.serialize([inFlight]);
    expect(serialized).toBe("![cover art]()\n");
    expect(parsedDoc(codec, serialized).firstChild?.firstChild?.attrs.uploadToken).toBe(null);
  });
});
