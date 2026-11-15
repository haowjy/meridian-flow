import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import * as baseImpl from "../__base/undo/forward-inverse.js";
import * as protoImpl from "./forward-inverse.js";

type Impl = typeof protoImpl;
type Part = protoImpl.InversePart;
function harness(impl: Impl, body: string) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  t.insert(0, body);
  p.insert(0, [t]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const v = { doc, history: [] as Part[], next: 10000 };
  const text = () =>
    (v.doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const str = () =>
    (text().toDelta() as { insert: string; attributes?: Record<string, unknown> }[])
      .map((d) => {
        const a = Object.entries(d.attributes ?? {}).map(([k, x]) =>
          k === "link" ? `link=${(x as { href: string }).href}` : k,
        );
        return a.length ? `<${a.join(",")}>${d.insert}</>` : d.insert;
      })
      .join("");
  const raw = (client: number, fn: (t: Y.XmlText) => void) => {
    v.doc.clientID = client;
    v.doc.transact(() => fn(text()));
  };
  // Browser-like: y-tiptap's updateYText computes simpleDiff of old vs new string, then inserts there.
  const typeBrowser = (client: number, at: number, s: string) => {
    for (const ch of s) {
      const old = text().toString();
      const neu = old.slice(0, at) + ch + old.slice(at);
      let left = 0,
        right = 0;
      while (left < old.length && old[left] === neu[left]) left++;
      while (
        right + left < old.length &&
        old[old.length - right - 1] === neu[neu.length - right - 1]
      )
        right++;
      raw(client, (t) => t.insert(left, neu.slice(left, neu.length - right)));
      at++;
    }
  };
  const write = (fn: (t: Y.XmlText) => void): Part[] => {
    const frontier = impl.captureEditFrontier(v.doc),
      updates: Uint8Array[] = [];
    const collect = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.next++;
    v.doc.on("update", collect);
    v.doc.transact(() => fn(text()));
    v.doc.off("update", collect);
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    const parts = impl
      .captureEditParts(v.doc, [{ frontier, update: Y.mergeUpdates(updates) }])
      .map((part, ordinal) => ({
        ...part,
        id: id + ordinal,
        editId: `e${id}`,
        ordinal,
        kind: "write" as const,
        targets: [],
      }));
    v.history.push(...parts);
    return parts;
  };
  const inverseSel = (sel: { part: Part; direction: "invert" | "reapply" }[], keep = false) => {
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(v.doc));
    v.doc.destroy();
    v.doc = cold;
    let result: protoImpl.ComputedInverse;
    try {
      result = impl.computeInverse(v.doc, v.history, sel, {
        actionId: `a${v.history.length}`,
        allocateClient: () => v.next++,
        keepLaterWords: keep,
      });
    } catch (e) {
      return `THREW ${(e as Error).message}`;
    }
    for (const edit of result.edits) {
      const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
      for (const [ordinal, part] of edit.parts.entries()) {
        Y.applyUpdate(v.doc, part.update);
        v.history.push({
          ...part,
          id: (v.history.at(-1)?.id ?? 0) + 1,
          editId,
          ordinal,
          kind: sel[0].direction === "invert" ? "undo" : "redo",
          actionId: result.actionId,
        });
      }
    }
    const sk = result.skipped.map((s) => s.reasons.join("/") || s.state).join(",");
    return `${result.edits.length ? "did" : "none"}${sk ? `[skip ${sk}]` : ""}: ${str()}`;
  };
  const inverse = (parts: Part[], direction: "invert" | "reapply", keep = false) =>
    inverseSel(
      parts.map((part) => ({ part, direction })),
      keep,
    );
  return { v, text, str, raw, write, inverse, inverseSel, typeBrowser };
}
const swap =
  (from: string, to: string, attrs: Record<string, unknown> = {}) =>
  (t: Y.XmlText) => {
    const at = t.toString().indexOf(from);
    t.delete(at, from.length);
    t.insert(at, to, attrs);
  };
const at = (h: { str: () => string; text: () => Y.XmlText }, s: string) =>
  h.text().toString().indexOf(s);
const out: string[] = [];
const cases: [string, (impl: Impl) => string][] = (
  process.env.ONLY
    ? (x: [string, (impl: Impl) => string][]) => x.filter(([n]) => n.includes(process.env.ONLY!))
    : (x: [string, (impl: Impl) => string][]) => x
)([
  [
    "browser typing 'very ' before big",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.typeBrowser(2002, 4, "very ");
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "browser typing 'bright ' before big",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.typeBrowser(2002, 4, "bright ");
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "browser typing 'a ' before 'a big' -> slides",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "angry"));
      h.typeBrowser(2002, 4, "an ");
      return `${h.str()} | U ${h.inverse(p, "invert")} | Unapply ${(() => {
        const g = harness(impl, "One small cat.");
        const q = g.write(swap("small", "angry"));
        g.typeBrowser(2002, 4, "an ");
        return g.inverse(q, "invert", true);
      })()}`;
    },
  ],
  [
    "two replacements one part, typing before 2nd",
    (impl) => {
      const h = harness(impl, "One small red cat.");
      const p = h.write((t) => {
        swap("red", "blue")(t);
        swap("small", "big")(t);
      });
      h.raw(2002, (t) => t.insert(at(h, "blue"), "very "));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "two adjacent words replaced as one splice, typing before",
    (impl) => {
      const h = harness(impl, "One small red cat.");
      const p = h.write(swap("small red", "big blue"));
      h.raw(2002, (t) => t.insert(4, "very "));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "three turns on one word, typing each time, undo newest first",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const e1 = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very "));
      const e2 = h.write(swap("big", "huge"));
      h.raw(2003, (t) => t.insert(at(h, "huge"), "so "));
      const e3 = h.write(swap("huge", "vast"));
      h.raw(2004, (t) => t.insert(at(h, "vast"), "oh "));
      return `${h.str()} | U3 ${h.inverse(e3, "invert")} | U2 ${h.inverse(e2, "invert")} | U1 ${h.inverse(e1, "invert")} | R1 ${h.inverse(e1, "reapply")} | R2 ${h.inverse(e2, "reapply")} | R3 ${h.inverse(e3, "reapply")}`;
    },
  ],
  [
    "three turns, Un-Apply all latest-first in one action",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const e1 = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very "));
      const e2 = h.write(swap("big", "huge"));
      h.raw(2003, (t) => t.insert(at(h, "huge"), "so "));
      const e3 = h.write(swap("huge", "vast"));
      return `${h.str()} | UnApply ${h.inverseSel(
        [...e3, ...e2, ...e1].map((part) => ({ part, direction: "invert" as const })),
        true,
      )}`;
    },
  ],
  [
    "undo older turn while newer replacement stands",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const e1 = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very "));
      const e2 = h.write(swap("big", "huge"));
      return `${h.str()} | U1 ${h.inverse(e1, "invert")} | U2 ${h.inverse(e2, "invert")}`;
    },
  ],
  [
    "undo e1 while newer e2 inserted beside",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const e1 = h.write(swap("small", "big"));
      const e2 = h.write((t) => t.insert(4, "very "));
      h.raw(2002, (t) => t.insert(4, "so "));
      return `${h.str()} | U1 ${h.inverse(e1, "invert")} | U2 ${h.inverse(e2, "invert")} | R1 ${h.inverse(e1, "reapply")}`;
    },
  ],
  [
    "redo after redo, undo after undo",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very "));
      return `U ${h.inverse(p, "invert")} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")} | R ${h.inverse(p, "reapply")} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "AI replaces and bolds 'big cat' in same part",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write((t) => {
        swap("small", "big")(t);
        t.format(4, 7, { bold: true });
      });
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "AI bolds 'One small' and replaces small",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write((t) => {
        t.format(0, 9, { bold: true });
        swap("small", "big", { bold: true })(t);
      });
      h.raw(2002, (t) => t.insert(4, "very ", { bold: true }));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "link changed with the word",
    (impl) => {
      const h = harness(impl, "One small cat.");
      h.raw(2001, (t) => t.format(4, 5, { link: { href: "A" } }));
      const p = h.write(swap("small", "big", { link: { href: "B" } }));
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "link href changed in place + word replaced elsewhere in same part",
    (impl) => {
      const h = harness(impl, "One small cat.");
      h.raw(2001, (t) => t.format(10, 3, { link: { href: "A" } }));
      const p = h.write((t) => {
        t.format(10, 3, { link: { href: "B" } });
        swap("small", "big")(t);
      });
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "writer bolds only their own typed word",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      h.raw(2002, (t) => t.format(4, 4, { bold: true }));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "writer types bold word (inserted with bold)",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very", { bold: true }));
      h.raw(2002, (t) => t.insert(8, " ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "peer A bolds 'very', peer B italics 'very big' (overlap)",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      h.raw(2003, (t) => t.format(4, 4, { bold: true }));
      h.raw(2004, (t) => t.format(6, 6, { italic: true }));
      return `${h.str()} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "writer typed 'large' before big then deleted big (writer's replacement)",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "large", {}));
      h.raw(2002, (t) => t.delete(9, 3));
      return `${h.str()} | U ${h.inverse(p, "invert")} | Unapply-keep ${(() => {
        const g = harness(impl, "One small cat.");
        const q = g.write(swap("small", "big"));
        g.raw(2002, (t) => t.insert(4, "large", {}));
        g.raw(2002, (t) => t.delete(9, 3));
        return g.inverse(q, "invert", true);
      })()}`;
    },
  ],
  [
    "writer types sentence before, then AI turn 2 elsewhere, undo turn 1",
    (impl) => {
      const h = harness(impl, "One small cat. Two dogs.");
      const e1 = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      const e2 = h.write(swap("dogs", "cats"));
      return `${h.str()} | U1 ${h.inverse(e1, "invert")} | U2 ${h.inverse(e2, "invert")} | R1 ${h.inverse(e1, "reapply")}`;
    },
  ],
  [
    "pure deletion, typing at the gap",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write((t) => t.delete(4, 6));
      h.raw(2002, (t) => t.insert(4, "big ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "replacement at paragraph start, typing before",
    (impl) => {
      const h = harness(impl, "Small cat.");
      const p = h.write(swap("Small", "Big"));
      h.raw(2002, (t) => t.insert(0, "A ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "AI inserted word before replacement in same part (left.found)",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write((t) => {
        swap("small", "big")(t);
        t.insert(4, "a ");
      });
      h.raw(2002, (t) => t.insert(6, "very ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "AI deletes 'small ', inserts 'very ' before sat; writer replaces cat with dog",
    (impl) => {
      const h = harness(impl, "One small cat sat.");
      const p = h.write((t) => {
        t.insert(at(h, "sat"), "very ");
        t.delete(4, 6);
      });
      h.raw(2002, (t) => {
        t.delete(4, 4);
        t.insert(4, "dog ", {});
      });
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")} | U ${h.inverse(p, "invert")} | Unapply ${(() => {
        const g = harness(impl, "One small cat sat.");
        const q = g.write((t) => {
          t.insert(at(g, "sat"), "very ");
          t.delete(4, 6);
        });
        g.raw(2002, (t) => {
          t.delete(4, 4);
          t.insert(4, "dog ", {});
        });
        return g.inverse(q, "invert", true);
      })()}`;
    },
  ],
  [
    "AI deletes 'small ' and appends a sentence; writer rewrites the rest of the sentence",
    (impl) => {
      const h = harness(impl, "One small cat sat.");
      const p = h.write((t) => {
        t.insert(t.length, " It slept.");
        t.delete(4, 6);
      });
      h.raw(2002, (t) => {
        t.delete(4, 8);
        t.insert(4, "dog ran.", {});
      });
      return `${h.str()} | U ${h.inverse(p, "invert")} | R ${h.inverse(p, "reapply")}`;
    },
  ],
  [
    "two AI turns: e1 deletes 'small ', e2 rewrites 'cat sat' -> 'dog ran'; e1 also inserted at end",
    (impl) => {
      const h = harness(impl, "One small cat sat.");
      const e1 = h.write((t) => {
        t.insert(t.length, " Yes.");
        t.delete(4, 6);
      });
      const _e2 = h.write(swap("cat sat.", "dog ran."));
      return `${h.str()} | U1 ${h.inverse(e1, "invert")}`;
    },
  ],
  [
    "multi-word AI replacement, writer types between AI words",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "tiny little"));
      h.raw(2002, (t) => t.insert(at(h, "little"), "very ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")}`;
    },
  ],
  [
    "DBG bold AI word",
    (impl) => {
      const h = harness(impl, "One small cat.");
      const p = h.write(swap("small", "big", { bold: true }));
      h.raw(2002, (t) => t.insert(4, "very ", {}));
      return `${h.str()} | U ${h.inverse(p, "invert")}`;
    },
  ],
]);
for (const [name, fn] of cases) {
  it(name, () => {
    out.push(`## ${name}\n  main : ${fn(baseImpl as unknown as Impl)}\n  proto: ${fn(protoImpl)}`);
  });
}
it("zz", () => writeFileSync("/tmp/p17539/challenge.txt", out.join("\n")));
