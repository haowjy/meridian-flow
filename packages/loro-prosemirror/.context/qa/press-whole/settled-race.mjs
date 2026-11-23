import { LoroDoc } from "loro-crdt";
const ops = (d) => d.exportJsonUpdates().changes.flatMap(c => c.ops).length;
const d = new LoroDoc(); d.setPeerId(1n);
d.getMap("m").set("k", "v"); d.commit(); const a = ops(d);
d.getMap("m").set("k", "v"); d.commit(); console.log("set equal value writes op:", ops(d) > a);
const b = ops(d); d.getMap("m").delete("absent"); d.commit(); console.log("delete absent key writes op:", ops(d) > b);

// Discard (press) settles override v while a tab, unaware, does Ctrl+Z then Ctrl+Y of its move (re-sets v).
function run(pressExtra, tabExtra) {
  const base = new LoroDoc(); base.setPeerId(9n);
  base.getMap("dorder").set("B", "v"); base.commit();
  const press = new LoroDoc(); press.setPeerId(1n); press.import(base.export({mode:"snapshot"}));
  for (let i = 0; i < pressExtra; i++) { press.getMap("x").set("p"+i, i); press.commit(); }
  press.getMap("dsettled").set("order/B", "v"); press.commit();
  const tab = new LoroDoc(); tab.setPeerId(2n); tab.import(base.export({mode:"snapshot"}));
  for (let i = 0; i < tabExtra; i++) { tab.getMap("x").set("t"+i, i); tab.commit(); }
  tab.getMap("dorder").delete("B"); tab.getMap("dsettled").delete("order/B"); tab.commit();
  tab.getMap("dorder").set("B", "v"); tab.getMap("dsettled").delete("order/B"); tab.commit();
  press.import(tab.export({mode:"update"})); tab.import(press.export({mode:"update"}));
  const o = tab.getMap("dorder").get("B"), s = tab.getMap("dsettled").get("order/B");
  return `override=${o} settled=${s} -> ${o !== undefined && o !== s ? "draft's move shows" : "move lost (reads Live)"}`;
}
console.log("tab higher clock:", run(0, 3));
console.log("press higher clock:", run(5, 0));
