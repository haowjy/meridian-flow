// Block-doc operations. A document is { structure, texts, peer }.
import { FIELDS, ids, visible } from './structure.mjs';

const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
export const same = (a,b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const update = (source, target) => target.import(source.export({mode:'update',from:target.oplogVersion()}));
const clone = (doc, peer, configure) => { const d=doc.fork(); d.setPeerId(peer); if (configure) configure(d); else d.configDefaultTextStyle({expand:'none'}); return d; };
const carried = (doc) => {
  const out=new Set();
  if (doc) for (const span of doc.getText('t').toDelta())
    for (const k of Object.keys(span.attributes ?? {})) if (k.startsWith('comment_')) out.add(k.slice(8));
  return out;
};
export function forward(live, fork) {
  update(live.structure, fork.structure);
  for (const [id, doc] of live.texts) {
    if (!fork.texts.has(id)) fork.texts.set(id, clone(doc, fork.peer, fork.configure));
    else update(doc, fork.texts.get(id));
  }
}
export function changedBlocks(live, fork) {
  forward(live,fork);
  const L=visible(live.structure), F=visible(fork.structure);
  const all=new Set([...ids(live.structure),...ids(fork.structure)]);
  const changes=[];
  for (const id of all) {
    let different=L.has(id)!==F.has(id);
    if (!different && L.has(id)) {
      different=FIELDS.some((k) => !same(live.structure.getMap(k).get(id),fork.structure.getMap(k).get(id)));
      const a=live.texts.get(id), b=fork.texts.get(id);
      different ||= !same(a?.getText('t').toDelta() ?? [],b?.getText('t').toDelta() ?? []);
      for (const comment of new Set([...carried(a),...carried(b)]))
        different ||= !same(live.structure.getMap('comments').get(comment),fork.structure.getMap('comments').get(comment));
    }
    if (different) changes.push(id);
  }
  return changes;
}
function put(map,key,value) { if (value === undefined) map.delete(key); else map.set(key,value); }
function bodies(source,target,id) {
  const from=source.structure.getMap('comments'), to=target.structure.getMap('comments');
  for (const key of carried(source.texts.get(id))) {
    const value=from.get(key);
    if (!same(value,to.get(key))) put(to,key,value);
  }
}
export function prune(doc) {
  const keys=new Set();
  for (const id of visible(doc.structure)) for (const k of carried(doc.texts.get(id))) keys.add(k);
  const m=doc.structure.getMap('comments');
  for (const k of m.keys()) if (!keys.has(k)) m.delete(k);
}
function setFields(from,to,id) {
  for (const name of FIELDS) {
    const src=from.structure.getMap(name), dst=to.structure.getMap(name);
    let value=src.get(id); if (name==='order' && value === undefined) value=null;
    if (!same(value,dst.get(id))) put(dst,id,value);
  }
}
export function applyBlocks(live,fork,selected,message='apply') {
  const pending=changedBlocks(live,fork); const chosen=selected==='all'?pending:pending.filter((id)=>selected.includes(id));
  if (!chosen.length) return {chosen,changed:[]};
  const records=[]; const before=live.structure.frontiers();
  for (const id of chosen) {
    setFields(fork,live,id);
    const src=fork.texts.get(id);
    if (src) {
      let dst=live.texts.get(id);
      if (!dst) { dst=clone(src,live.peer,live.configure); live.texts.set(id,dst); }
      else {const b=dst.frontiers();update(src,dst);const a=dst.frontiers();if (!same(a,b)) records.push({id,doc:dst,before:b,after:a});}
      bodies(fork,live,id);
    }
  }
  prune(live); live.structure.commit({message});
  const after=live.structure.frontiers();
  if (!same(before,after)) records.unshift({id:null,doc:live.structure,before,after});
  forward(live,fork); return {chosen,changed:records};
}
export function resetBlocks(live,fork,selected,message='reset') {
  const pending=changedBlocks(live,fork); const chosen=selected==='all'?pending:pending.filter((id)=>selected.includes(id));
  if (!chosen.length) return {chosen,changed:[]};
  const records=[]; const before=fork.structure.frontiers();
  for (const id of chosen) {
    setFields(live,fork,id);
    const src=live.texts.get(id), dst=fork.texts.get(id);
    if (src && dst) {
      const b=dst.frontiers(); dst.applyDiff(dst.diff(b,src.frontiers(),false)); dst.commit({message});
      const a=dst.frontiers(); if (!same(a,b)) records.push({id,doc:dst,before:b,after:a});
    }
    bodies(live,fork,id);
  }
  prune(fork); fork.structure.commit({message}); const after=fork.structure.frontiers();
  if (!same(before,after)) records.unshift({id:null,doc:fork.structure,before,after});
  return {chosen,changed:records};
}
export function invertCommit(doc,before,after,peer,message='undo') {
  const at=doc.forkAt(after); try {
    at.setPeerId(peer); at.configDefaultTextStyle({expand:'none'});
    at.applyDiff(at.diff(after,before,false)); at.commit({message});
    const bytes=at.export({mode:'update',from:doc.oplogVersion()});doc.import(bytes);return bytes;
  } finally {at.free();}
}
export function returnToPending(doc,bytes,message='return to pending') {
  const before=doc.frontiers();doc.import(bytes);const after=doc.frontiers();
  doc.applyDiff(doc.diff(after,before,false));doc.commit({message});
}

export function restoreBeforeOnLive(live, fork, before, message='restore before') {
  forward(live,fork);
  const restore=(l,f,frontier)=>{
    if(!frontier)return;
    const vv=f.frontiersToVV(frontier).toJSON();
    if(l) for(const [peer,n] of l.oplogVersion().toJSON())if((vv.get(peer)??0)<n)vv.set(peer,n);
    const V=f.oplogVersion().constructor;
    const target=f.vvToFrontiers(new V(vv));
    f.applyDiff(f.diff(f.frontiers(),target,false));f.commit({message});
  };
  restore(live.structure,fork.structure,before.structure);
  for(const [id,d] of fork.texts)restore(live.texts.get(id),d,before.texts.get(id));
}
export function frontiers(doc) {
  return {structure:doc.structure.frontiers(),texts:new Map([...doc.texts].map(([id,d])=>[id,d.frontiers()]))};
}
