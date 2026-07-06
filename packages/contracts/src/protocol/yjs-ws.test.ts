/** Tests for the shared Yjs WebSocket room-name wire contract. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { branchRoomName, draftRoomName, parseYjsRoomName, yjsWsPath } from "./yjs-ws.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000101" as DocumentId;
const DRAFT_ID = "01JZ0DRAFTROOM000000000000";
const BRANCH_ID = "branch_00000000-0000-4000-8000-000000000201";

describe("Yjs websocket contract", () => {
  it("keeps live room names as bare document ids", () => {
    expect(parseYjsRoomName(DOCUMENT_ID)).toEqual({ kind: "live", documentId: DOCUMENT_ID });
  });

  it("encodes and parses draft rooms with the draft prefix", () => {
    const roomName = draftRoomName(DRAFT_ID);

    expect(roomName).toBe(`draft:${DRAFT_ID}`);
    expect(parseYjsRoomName(roomName)).toEqual({ kind: "draft", draftId: DRAFT_ID });
  });

  it("encodes and parses branch rooms before live fallback", () => {
    const roomName = branchRoomName(BRANCH_ID);

    expect(roomName).toBe(`branch:${BRANCH_ID}`);
    expect(parseYjsRoomName(roomName)).toEqual({ kind: "branch", branchId: BRANCH_ID });
  });

  it("rejects empty room names", () => {
    expect(parseYjsRoomName("")).toBeNull();
    expect(parseYjsRoomName("draft:")).toBeNull();
    expect(parseYjsRoomName("branch:")).toBeNull();
  });

  it("keeps the websocket path stable", () => {
    expect(yjsWsPath()).toBe("/ws/yjs");
  });
});
