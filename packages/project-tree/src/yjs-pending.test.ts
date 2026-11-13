/**
 * Proof-of-concept finding, not a tree rule: Yjs 13.6.31 (and 13.6.33, the latest 13.x) can
 * leave updates pending forever when single-struct updates arrive out of causal order, even
 * once every update has arrived. Found by the tree property test; this is its minimised
 * sequence (17 updates from four clients). A state-vector exchange, which y-protocols runs on
 * every connect, integrates them. Production rooms receive each client's updates in order, so
 * this bites only a transport that reorders or relays updates.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

const SEQUENCE = [
  "AQEDAIgEAAF2CQR0eXBldwZjcmVhdGUEbm9kZXcFbi0zLTEEa2luZHcIZG9jdW1lbnQEbmFtZXcDQ2gxBnBhcmVudHcEcm9vdARyYW5rdwJhMAJpZHcGb3AtMy0yBWFjdG9ydwlhZ2VudDp0LzEFZHJhZnR+AA==",
  "AQEEAYgDAQF2BgR0eXBldwZkZWxldGUEbm9kZXcFbi0zLTMHY2FzY2FkZXUAAmlkdwZvcC00LTMFYWN0b3J3BnVzZXI6dwVkcmFmdHcCdzIA",
  "AQEEBIgEAgF2CQR0eXBldwZjcmVhdGUEbm9kZXcFbi00LTUEa2luZHcIZG9jdW1lbnQEbmFtZXcDQXJjBnBhcmVudHcEcm9vdARyYW5rdwJhMAJpZHcGb3AtNC02BWFjdG9ydwlhZ2VudDp0LzEFZHJhZnR3AncyAA==",
  "AQEEAygBB3NldHRsZWQGb3AtNC0yAXcJZGlzY2FyZGVkAA==",
  "AQEEAogEAQF2BgR0eXBldwZkZWxldGUEbm9kZXcFbi0zLTEHY2FzY2FkZXUAAmlkdwZvcC00LTQFYWN0b3J3BnVzZXI6dwVkcmFmdHcCdzIA",
  "AQEDC4gDCgF2CQR0eXBldwZjcmVhdGUEbm9kZXcGbi0zLTE3BGtpbmR3CGRvY3VtZW50BG5hbWV3A0NoMgZwYXJlbnR3BW4tMy01BHJhbmt3AmEwAmlkdwdvcC0zLTE4BWFjdG9ydwZ1c2VyOncFZHJhZnR3AncyAA==",
  "AQEEAAgBA29wcwF2CQR0eXBldwZjcmVhdGUEbm9kZXcFbi00LTEEa2luZHcGZm9sZGVyBG5hbWV3A0NoMQZwYXJlbnR3BHJvb3QEcmFua3cCYTACaWR3Bm9wLTQtMgVhY3RvcncGdXNlcjp3BWRyYWZ0dwJ3MQA=",
  "AQEDCogDCAF2CAR0eXBldwRtb3ZlBG5vZGV3BW4tMy01BnBhcmVudHcEcm9vdARyYW5rdwJhMgRmcm9tdgIGcGFyZW50dwRyb290BHJhbmt3AmEwAmlkdwdvcC0zLTE2BWFjdG9ydwlhZ2VudDp0LzEFZHJhZnR3AncyAA==",
  "AQEDAYgDAAF2CQR0eXBldwZjcmVhdGUEbm9kZXcFbi0zLTMEa2luZHcGZm9sZGVyBG5hbWV3BU5vdGVzBnBhcmVudHcFbi0xLTEEcmFua3cCYTACaWR3Bm9wLTMtNAVhY3RvcncGdXNlcjp3BWRyYWZ0fgA=",
  "AQEDCIgDBwF2CQR0eXBldwZjcmVhdGUEbm9kZXcGbi0zLTE0BGtpbmR3BmZvbGRlcgRuYW1ldwNDaDEGcGFyZW50dwVuLTMtMwRyYW5rdwJhMAJpZHcHb3AtMy0xNQVhY3RvcncGdXNlcjp3BWRyYWZ0dwJ3MQA=",
  "AQEDAogEAgF2CQR0eXBldwZjcmVhdGUEbm9kZXcFbi0zLTUEa2luZHcGZm9sZGVyBG5hbWV3A0NoMgZwYXJlbnR3BHJvb3QEcmFua3cCYTACaWR3Bm9wLTMtNgVhY3RvcncJYWdlbnQ6dC8xBWRyYWZ0dwJ3MgA=",
  "AQEDB4gEBAF2CQR0eXBldwZjcmVhdGUEbm9kZXcGbi0zLTEyBGtpbmR3CGRvY3VtZW50BG5hbWV3A0NoMQZwYXJlbnR3BHJvb3QEcmFua3cCYTECaWR3B29wLTMtMTMFYWN0b3J3BnVzZXI6dwVkcmFmdHcCdzEA",
  "AQEDA4gDAgF2CQR0eXBldwZjcmVhdGUEbm9kZXcFbi0zLTcEa2luZHcIZG9jdW1lbnQEbmFtZXcDQXJjBnBhcmVudHcFbi0xLTEEcmFua3cCYTECaWR3Bm9wLTMtOAVhY3RvcncGdXNlcjp3BWRyYWZ0fgA=",
  "AQEDCSgBB3NldHRsZWQGb3AtNC02AXcJZGlzY2FyZGVkAA==",
  "AQEDBogDBQF2CAR0eXBldwRtb3ZlBG5vZGV3BW4tMS0xBnBhcmVudHcEcm9vdARyYW5rdwJhMQRmcm9tdgIGcGFyZW50dwRyb290BHJhbmt3AmEwAmlkdwdvcC0zLTExBWFjdG9ydwlhZ2VudDp0LzEFZHJhZnR3AncyAA==",
  "AQEDBIgDAwF2CAR0eXBldwRtb3ZlBG5vZGV3BW4tMy0xBnBhcmVudHcFbi0zLTMEcmFua3cCYTAEZnJvbXYCBnBhcmVudHcEcm9vdARyYW5rdwJhMAJpZHcGb3AtMy05BWFjdG9ydwlhZ2VudDp0LzEFZHJhZnR3AncxAA==",
  "AQEDBYgDBAF2CQR0eXBldwRtb3ZlBG5vZGV3BW4tMy0xBnBhcmVudHcEcm9vdARyYW5rdwJhMARmcm9tdgIGcGFyZW50dwVuLTMtMwRyYW5rdwJhMAJpZHcHb3AtMy0xMAVhY3RvcncGdXNlcjp3BWRyYWZ0dwJ3MQZ1bmRvZXN3Bm9wLTMtOQA=",
].map((base64) => new Uint8Array(Buffer.from(base64, "base64")));

describe("Yjs pending updates", () => {
  it("can stay pending after a causally complete set arrives out of order", () => {
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Y.mergeUpdates(SEQUENCE));
    expect(merged.store.pendingStructs).toBeNull();

    const oneByOne = new Y.Doc();
    for (const update of SEQUENCE) Y.applyUpdate(oneByOne, update);
    expect(oneByOne.store.pendingStructs).not.toBeNull();

    Y.applyUpdate(oneByOne, Y.encodeStateAsUpdate(merged, Y.encodeStateVector(oneByOne)));
    expect(oneByOne.store.pendingStructs).toBeNull();
    expect(Y.encodeStateVector(oneByOne)).toEqual(Y.encodeStateVector(merged));
  });
});
