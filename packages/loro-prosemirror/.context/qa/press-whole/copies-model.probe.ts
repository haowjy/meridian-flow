import { LoroDoc } from "loro-crdt";
import { forwardText, oneCopy } from "@meridian/document-model";

const T = "t";
const text = (doc: LoroDoc) => doc.getText(T);
const check = (name: string, got: string, want: string) => {
  if (got !== want) throw new Error(`${name}: ${JSON.stringify(got)}; wanted ${JSON.stringify(want)}`);
  console.log(`ok ${name}: ${JSON.stringify(got)}`);
};
const base = () => {
  const live = new LoroDoc();
  live.setPeerId("1");
  text(live).insert(0, "She tied herself to the mast.");
  live.commit();
  return live;
};
const replace = (doc: LoroDoc, find: string, put: string) => {
  const t = text(doc);
  const at = t.toString().indexOf(find);
  t.delete(at, find.length);
  t.insert(at, put);
  doc.commit();
};

for (const keyByKey of [false, true]) {
  const live = base();
  const draft = live.fork();
  draft.setPeerId(keyByKey ? "3" : "2");
  replace(draft, "tied", "lashed");
  if (keyByKey) {
    replace(live, "tied herself", "b");
    for (const ch of "ound himself") {
      const at = text(live).toString().indexOf("b") + 1;
      text(live).insert(at, ch);
      live.commit();
      forwardText(draft, live, T);
    }
  } else {
    replace(live, "tied herself", "bound himself");
  }
  forwardText(draft, live, T);
  check(`hard case ${keyByKey ? "key by key" : "one commit"}`, text(draft).toString(), "She lashed herself to the mast.");
}

{
  const live = base();
  const room = live.fork();
  room.setPeerId("4");
  replace(room, "tied", "lashed");
  const tab = room.fork();
  tab.setPeerId("5");
  replace(live, "tied herself", "bound himself");
  forwardText(room, live, T);
  forwardText(tab, live, T);
  live.import(room.export({ mode: "update", from: live.oplogVersion() }));
  oneCopy(live, T);
  tab.import(live.export({ mode: "update", from: tab.oplogVersion() }));
  oneCopy(tab, T);
  check("two copies answer once", text(tab).toString(), "She lashed herself to the mast.");
}

console.log("all model copy cases pass");
