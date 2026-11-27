import { describe, expect, it } from "vitest";
import {
  normalEntryName,
  validateContextEntryName,
  validateContextEntryPath,
} from "./context-entry-validation.js";

describe("normalEntryName", () => {
  it.each([
    ["folder", "Arc 1: The Last Crossing", "Arc 1: The Last Crossing"],
    ["folder", "1/2", "1∕2"],
    ["folder", "@notes", "＠notes"],
    ["folder", "~b7", "～b7"],
    ["folder", "Kael~b21c", "Kael～b21c"],
    ["folder", "Kael~b21", "Kael~b21"],
    ["folder", "Kael@live", "Kael＠live"],
    ["folder", "Kael@DRAFT", "Kael＠DRAFT"],
    ["folder", "Kael@w5", "Kael＠w5"],
    ["folder", "Kael@c12", "Kael＠c12"],
    ["folder", "Kael@b7", "Kael＠b7"],
    ["folder", "Kael@x7", "Kael@x7"],
    ["folder", "Kael@w", "Kael@w"],
    ["folder", "anna@example.com", "anna@example.com"],
    ["folder", "Kael~B21C", "Kael～B21C"],
    ["document", "Kael~b21c.md", "Kael～b21c"],
    ["folder", "..", "．．"],
    ["folder", "a\tb", "a b"],
    ["folder", "  ", "Untitled"],
    ["document", "notes.md", "notes"],
    ["document", ".md", "Untitled"],
    ["document", "a: b?.csv", "a: b?.csv"],
  ] as const)("%s %j -> %j", (kind, typed, name) => {
    expect(normalEntryName(kind, typed)).toBe(name);
  });

  it("cuts at a character boundary and is idempotent", () => {
    const long = "😀".repeat(200);
    const name = normalEntryName("folder", long);
    expect(name.length).toBeLessThanOrEqual(255);
    expect([...name].every((char) => char === "😀")).toBe(true);
    expect(normalEntryName("folder", name)).toBe(name);
  });
});

describe("context entry paths", () => {
  it("normalises each segment and keeps ':'", () => {
    expect(validateContextEntryPath("Act 1: X/@y")).toEqual({ ok: true, value: "Act 1: X/＠y" });
    expect(validateContextEntryName("a:b")).toEqual({ ok: true, value: "a:b" });
  });

  it.each([
    ["Act 2//Chapter 3", "path/empty-segment"],
    ["Act/", "path/trailing-separator"],
  ])("rejects %j with %s", (raw, reason) => {
    expect(validateContextEntryPath(raw)).toMatchObject({ ok: false, reason });
  });
});
