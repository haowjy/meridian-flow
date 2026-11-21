import { LoroDoc } from 'loro-crdt';
import { EditorState } from 'prosemirror-state';
import { simpleDiff } from 'lib0/diff';
import { schema } from '../codec.mjs';
import { children, ids, orderKeys, visible } from './structure.mjs';
import { same } from './model.mjs';

export { schema };
const styles=Object.fromEntries(Object.entries(schema.marks).filter(([k])=>k!=='comment').map(([k,v])=>[k,{expand:v.spec.inclusive===false?'none':'after'}]));
styles.inline={expand:'none'};
export function configure(doc) {doc.configDefaultTextStyle({expand:'none'});doc.configTextStyle(styles);return doc;}
const makeDoc=(peer)=>{const d=configure(new LoroDoc());d.setPeerId(peer);return d};
export function newDocument(peer) {return {peer,configure,structure:makeDoc(peer),texts:new Map()};}
export function forkDocument(doc,peer) {
  const fork=(d)=>{const f=configure(d.fork());f.setPeerId(peer);return f};
  return {peer,configure,structure:fork(doc.structure),texts:new Map([...doc.texts].map(([id,d])=>[id,fork(d)]))};
}
export function freeDocument(doc) {doc.structure.free();for(const d of doc.texts.values())d.free();}
const sentinel='\ufffc';
function storedMarks(marks) {
  const out={}; for(const m of marks) {
    const key=m.type.name==='comment'?`comment_${m.attrs.id}`:m.type.name;
    out[key]=m.type.name==='comment'?true:m.attrs;
  } return out;
}
function readMarks(attrs) {
  const keys=Object.keys(attrs??{}).filter(k=>k!=='inline');
  const normalized=keys.includes('code')?['code']:keys.sort((a,b)=>{const am=a.startsWith('comment_')?'comment':a,bm=b.startsWith('comment_')?'comment':b;const ar=schema.marks[am]?.rank??0,br=schema.marks[bm]?.rank??0;return ar-br||(a<b?-1:a>b?1:0);});
  return normalized.map(k=>k.startsWith('comment_')?schema.marks.comment.create({id:k.slice(8)}):schema.mark(k,attrs[k]));
}
function textNodes(doc) {
  if (!doc) return [];
  const nodes=[];
  for(const part of doc.getText('t').toDelta()) {
    const marks=readMarks(part.attributes);
    if (part.attributes?.inline) {
      // An inline style is attached only to a sentinel, at insertion.
      for(const c of part.insert) {
        if(c===sentinel) nodes.push(schema.node(part.attributes.inline.type,part.attributes.inline.attrs,null,marks));
        else nodes.push(schema.text(c,marks));
      }
    } else if(part.insert) nodes.push(schema.text(part.insert,marks));
  }
  return nodes;
}
export function read(doc) {
  const s=doc.structure, shown=visible(s), nodes=s.getMap('node'), attrs=s.getMap('attrs');
  function one(id) {
    const type=nodes.get(id), a={...(attrs.get(id)??{}),id};
    const spec=schema.nodes[type]; if(!spec) throw Error(`unknown node ${type}`);
    const content=spec.isTextblock?textNodes(doc.texts.get(id)):children(s,id,shown).map(one);
    return spec.create(a,content);
  }
  return schema.nodes.doc.create(null,children(s,null,shown).map(one));
}
function flatten(pm) {
  const map=new Map(), siblings=new Map();
  function walk(node,parent) {
    const id=node.attrs.id;
    if(id==null) throw Error(`missing id in ${node.type.name}`);
    const attrs=Object.fromEntries(Object.entries(node.attrs).filter(([k,v])=>k!=='id'&&v!==null));
    if(!siblings.has(parent))siblings.set(parent,[]);siblings.get(parent).push(id);
    const delta=[];
    if(node.isTextblock) node.forEach((part)=>{
      const a=storedMarks(part.marks);
      if(part.isText) delta.push({insert:part.text,attributes:a});
      else delta.push({insert:sentinel,attributes:{...a,inline:{type:part.type.name,attrs:part.attrs}}});
    });
    map.set(id,{parent,node:node.type.name,attrs,delta,textblock:node.isTextblock});
    if(!node.isTextblock)node.forEach((child)=>walk(child,id));
  }
  pm.forEach((n)=>walk(n,null));return {map,siblings};
}
function normalized(a) {
  if(!a?.code)return a??{};
  return {code:a.code,...(a.inline?{inline:a.inline}:{})};
}
function patch(current,wanted) {
  current=normalized(current); wanted=normalized(wanted); const p={};
  for(const [k,v] of Object.entries(wanted))if(!same(v,current[k]))p[k]=v;
  for(const k of Object.keys(current))if(!(k in wanted))p[k]=null;
  return Object.keys(p).length?p:null;
}
function stylesDiff(current,desired) {
  let i=0,j=0,x=0,y=0;const out=[];
  while(i<current.length&&j<desired.length){
    const a=current[i],b=desired[j],n=Math.min(a.insert.length-x,b.insert.length-y);
    if(n>0){const p=patch(a.attributes,b.attributes);out.push(p?{retain:n,attributes:p}:{retain:n});}
    x+=n;y+=n;if(x===a.insert.length){i++;x=0;}if(y===b.insert.length){j++;y=0;}
  }
  while(out.length&&!out.at(-1).attributes)out.pop();return out;
}
function updateText(text,desired) {
  const before=text.toDelta().map((x)=>x.insert).join(''), target=desired.map((x)=>x.insert).join('');
  const {index,remove,insert}=simpleDiff(before,target);
  if(remove)text.delete(index,remove);
  if(insert.length) {
    let at=0;const delta=[]; if(index)delta.push({retain:index});
    for(const part of desired) {
      const start=Math.max(index,at),end=Math.min(index+insert.length,at+part.insert.length);
      if(start<end)delta.push({insert:part.insert.slice(start-at,end-at),attributes:part.attributes});
      at+=part.insert.length;
    }
    text.applyDelta(delta);
  }
  const changes=stylesDiff(text.toDelta(),desired);if(changes.length)text.applyDelta(changes);
}
export function write(doc,pm,{rng=Math.random,message='edit'}={}) {
  const flat=flatten(pm), s=doc.structure, before=s.frontiers(), changed=[];
  const set=(name,id,value)=>{const m=s.getMap(name);if(!same(m.get(id),value))m.set(id,value);};
  for(const [parent,list] of flat.siblings) {
    const old=new Map(list.map(id=>[id,s.getMap('parent').get(id)===parent?s.getMap('order').get(id):undefined]));
    for(const [id,key] of orderKeys(list,old,rng))set('order',id,key);
  }
  for(const [id,b] of flat.map) {
    set('parent',id,b.parent);set('node',id,b.node);set('attrs',id,b.attrs);
    if(b.textblock) {
      let t=doc.texts.get(id); if(!t){t=makeDoc(doc.peer);doc.texts.set(id,t);}
      const b0=t.frontiers();updateText(t.getText('t'),b.delta);t.commit({message});const b1=t.frontiers();
      if(!same(b0,b1))changed.push({id,doc:t,before:b0,after:b1});
    }
  }
  for(const id of ids(s))if(!flat.map.has(id) && s.getMap('order').get(id)!==null)set('order',id,null);
  s.commit({message});const after=s.frontiers();if(!same(before,after))changed.unshift({id:null,doc:s,before,after});
  return {changed};
}
export function edit(doc,fn,options={}) {
  const state=EditorState.create({schema,doc:read(doc)}),tr=fn(state.tr,state.doc);
  if(!tr||!tr.docChanged)return {changed:[]};fixBlockIds(tr,options.rng);
  return write(doc,tr.doc,options);
}

let idCounter=0;
export function resetIds(){idCounter=0;}
export function fixBlockIds(tr,rng=Math.random){
  const seen=new Set(),A='0123456789abcdefghijklmnopqrstuvwxyz';
  tr.doc.descendants((node,pos)=>{
    if(node.type.spec.attrs?.id===undefined)return !node.isTextblock;
    if(node.attrs.id==null||seen.has(node.attrs.id)){let id='';for(let i=0;i<10;i++)id+=A[Math.floor(rng()*36)];tr.setNodeAttribute(pos,'id',id+(idCounter++).toString(36));}
    else seen.add(node.attrs.id);return !node.isTextblock;
  });
}
export function withIds(pm,rng){const tr=EditorState.create({schema,doc:pm}).tr;fixBlockIds(tr,rng);return tr.doc;}
