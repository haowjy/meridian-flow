import { LoroDoc } from 'loro-crdt';
import { EditorState } from 'prosemirror-state';
import { Fragment } from 'prosemirror-model';
import { simpleDiff } from 'lib0/diff';
import { schema } from '../codec.mjs';
import { attributes, children, ids, orderKeys, sameOrderAsBase, value, visible } from './structure.mjs';
import { same } from './model.mjs';

export { schema };
const styles=Object.fromEntries(Object.entries(schema.marks).filter(([k])=>k!=='comment').map(([k,v])=>[k,{expand:v.spec.inclusive===false?'none':'after'}]));
styles.inline={expand:'none'};
export function configure(doc) {doc.configDefaultTextStyle({expand:'none'});doc.configTextStyle(styles);return doc;}
const makeDoc=(peer)=>{const d=configure(new LoroDoc());d.setPeerId(peer);return d};
export function newDocument(peer) {const structure=makeDoc(peer);structure._valueMap=true;return {peer,draft:false,configure,structure,texts:new Map()};}
export function forkDocument(doc,peer,draft=doc.draft) {
  const fork=(d)=>{const f=configure(d.fork());f.setPeerId(peer);return f};
  const structure=fork(doc.structure);structure._draft=draft;structure._valueMap=true;return {peer,draft,configure,structure,texts:new Map([...doc.texts].map(([id,d])=>[id,fork(d)]))};
}
export function lazyTurn(doc,peer){const structure=configure(doc.structure.fork());structure.setPeerId(peer);structure._draft=true;structure._valueMap=true;return {peer,draft:true,configure,structure,texts:new Map(doc.texts),lazyParent:doc,ownedTexts:new Set(),forkTimes:new Map()};}
export function freeDocument(doc) {doc.structure.free();if(doc.lazyParent){for(const d of doc.ownedTexts)d.free();}else for(const d of doc.texts.values())d.free();}
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
function textNodes(doc,type) {
  if (!doc) return [];
  const nodes=[];
  for(const part of doc.getText('t').toDelta()) {
    const marks=readMarks(part.attributes).filter(m=>type.allowsMarkType(m.type));
    if (part.attributes?.inline) {
      // An inline style is attached only to a sentinel, at insertion.
      for(const c of part.insert) {
        if(c===sentinel) {const inline=schema.nodes[part.attributes.inline.type];if(inline&&type.contentMatch.matchType(inline))nodes.push(inline.create(part.attributes.inline.attrs,null,marks));}
        else nodes.push(schema.text(c,marks));
      }
    } else if(part.insert) nodes.push(schema.text(part.insert,marks));
  }
  return nodes;
}
export function read(doc) {
  const s=doc.structure, shown=visible(s);
  function one(id) {
    const type=value(s,'node',id), a={...attributes(s,id),id};
    const spec=schema.nodes[type]; if(!spec) throw Error(`unknown node ${type}`);
    let content=spec.isTextblock?textNodes(doc.texts.get(id),spec):children(s,id,shown).map(one).filter(Boolean);
    if((type==='table'||type==='table_row')&&!content.length)return null;
    if((type==='table_cell'||type==='table_header'||type==='jsx_container')&&!content.length)content=[schema.nodes.paragraph.create({id:id+'/empty'})];
    return spec.create(a,content);
  }
  return schema.nodes.doc.create(null,children(s,null,shown).map(one).filter(Boolean));
}
function flatten(pm) {
  const map=new Map(), siblings=new Map();
  function walk(node,parent) {
    const id=node.attrs.id;
    if(node.type.name==='paragraph'&&!node.content.size&&(id==null||id===parent+'/empty'))return;
    if(id==null) throw Error(`missing id in ${node.type.name}`);
    const attrs=Object.fromEntries(Object.entries(node.attrs).filter(([k,v])=>k!=='id'&&v!==null));
    if(!siblings.has(parent))siblings.set(parent,[]);siblings.get(parent).push(id);
    const delta=[];
    if(node.isTextblock) node.forEach((part)=>{
      const a=storedMarks(part.marks);
      if(part.isText) delta.push({insert:part.text,attributes:a});
      else delta.push({insert:sentinel,attributes:{...a,inline:{type:part.type.name,attrs:part.attrs}}});
    });
    map.set(id,{parent,node:node.type.name,attrs,delta,textblock:node.isTextblock,pm:node});
    if(!node.isTextblock)node.forEach((child)=>walk(child,id));
  }
  pm.forEach((n)=>walk(n,null));return {map,siblings};
}
function normalizeAttrs(attrs,ch,node) {
  const out={...(attrs??{})};
  if(node==='code_block')return {};
  if(ch!==sentinel)delete out.inline;
  if(out.code)return {code:out.code,...(out.inline?{inline:out.inline}:{})};
  return out;
}
function patch(current,wanted) {
  const p={};for(const [k,v] of Object.entries(wanted))if(!same(v,current[k]))p[k]=v;
  for(const k of Object.keys(current))if(!(k in wanted))p[k]=null;
  return Object.keys(p).length?p:null;
}
function scan(text,node) {
  const raw=[];let pos=0;
  for(const part of text.toDelta())for(let i=0;i<part.insert.length;i++){
    const ch=part.insert[i],attrs=part.attributes??{};
    const hidden=(node==='code_block'||node==='jsx_leaf')&&ch===sentinel&&attrs.inline;
    raw.push({ch,attrs,pos:pos++,hidden:!!hidden});
  }
  return raw;
}
function updateText(text,desired,node) {
  const wanted=[];for(const run of desired)for(let i=0;i<run.insert.length;i++)wanted.push({ch:run.insert[i],attrs:run.attributes??{}});
  let raw=scan(text,node),visible=raw.filter(x=>!x.hidden),before=visible.map(x=>x.ch).join(''),target=wanted.map(x=>x.ch).join('');
  const {index,remove,insert}=simpleDiff(before,target);
  const removed=visible.slice(index,index+remove).map(x=>x.pos);for(let i=removed.length-1;i>=0;i--)text.delete(removed[i],1);
  if(insert.length){
    raw=scan(text,node);visible=raw.filter(x=>!x.hidden);const at=index<visible.length?visible[index].pos:raw.length;
    const delta=[];if(at)delta.push({retain:at});let offset=0;
    for(const part of desired){const start=Math.max(index,offset),end=Math.min(index+insert.length,offset+part.insert.length);if(start<end)delta.push({insert:part.insert.slice(start-offset,end-offset),attributes:part.attributes});offset+=part.insert.length;}
    text.applyDelta(delta);
  }
  raw=scan(text,node);const styles=[];let j=0;
  for(const item of raw){if(item.hidden){styles.push({retain:1});continue;}const next=wanted[j++];if(!next||next.ch!==item.ch)throw Error('normalized text differs after splice');const attrs=patch(normalizeAttrs(item.attrs,item.ch,node),normalizeAttrs(next.attrs,next.ch,node));styles.push(attrs?{retain:1,attributes:attrs}:{retain:1});}
  while(styles.length&&!styles.at(-1).attributes)styles.pop();if(styles.length)text.applyDelta(styles);
}

export function write(doc,pm,{rng=Math.random,message='edit'}={}) {
  const flat=flatten(pm), s=doc.structure, before=s.frontiers(), changed=[];
  const set=(name,id,v)=>{const base=s.getMap(name),m=s.getMap((doc.draft?'d.':'')+name);if(doc.draft&&same(name==='attrs'?(base.get(id)??null):base.get(id),v)){if(m.get(id)!==undefined)m.delete(id);}else if(!same(m.get(id),v))m.set(id,v);};
  for(const [parent,list] of flat.siblings) {
    const old=new Map(list.map(id=>[id,value(s,'parent',id)===parent?value(s,'order',id):undefined]));
    for(const [id,key] of orderKeys(list,old,rng))set('order',id,key);
  }
  for(const [id,b] of flat.map) {
    set('parent',id,b.parent);set('node',id,b.node);const existing=attributes(s,id);for(const k of new Set([...Object.keys(existing),...Object.keys(b.attrs)]))set('attrs',id+'/'+k,b.attrs[k]??null);
    if(b.textblock) {
      let t=doc.texts.get(id);const needs=!t||!b.pm.content.eq(Fragment.fromArray(textNodes(t,b.pm.type)));
      if(!t){t=makeDoc(doc.peer);doc.texts.set(id,t);doc.ownedTexts?.add(t);}
      else if(needs&&doc.lazyParent&&t===doc.lazyParent.texts.get(id)){const original=t;t=configure(original.fork());t.setPeerId(doc.peer);doc.texts.set(id,t);doc.ownedTexts.add(t);doc.forkTimes.set(id,original.frontiers());}
      if(needs){const b0=t.frontiers();updateText(t.getText('t'),b.delta,b.node);t.commit({message});const b1=t.frontiers();if(!same(b0,b1))changed.push({id,doc:t,before:b0,after:b1});}
    }
  }
  if(doc.draft){for(const id of flat.map.keys())if(sameOrderAsBase(s,id))s.getMap('d.order').delete(id);for(const key of s.getMap('d.comments').keys())if(same(s.getMap('comments').get(key),s.getMap('d.comments').get(key)))s.getMap('d.comments').delete(key);}
  for(const id of ids(s))if(!flat.map.has(id) && value(s,'order',id)!==null)set('order',id,null);
  s.commit({message});const after=s.frontiers();if(!same(before,after))changed.unshift({id:null,doc:s,before,after});
  return {changed};
}
export function edit(doc,fn,options={}) {
  const state=EditorState.create({schema,doc:read(doc)}),tr=fn(state.tr,state.doc);
  if(!tr||!tr.docChanged)return {changed:[]};const virtual=new Set();state.doc.descendants((node,pos)=>{if(node.type.name==='paragraph'&&(node.attrs.id==null||node.attrs.id.endsWith('/empty'))&&!node.content.size)virtual.add(tr.mapping.map(pos));});fixBlockIds(tr,options.rng,(node,pos)=>virtual.has(pos)&&node.type.name==='paragraph'&&!node.content.size);
  return write(doc,tr.doc,options);
}

let idCounter=0;
export function resetIds(){idCounter=0;}
export function fixBlockIds(tr,rng=Math.random,skip=()=>false){
  const seen=new Set(),A='0123456789abcdefghijklmnopqrstuvwxyz';
  tr.doc.descendants((node,pos)=>{
    if(node.type.spec.attrs?.id===undefined||skip(node,pos))return !node.isTextblock;
    if(node.attrs.id==null||node.attrs.id.endsWith('/empty')||seen.has(node.attrs.id)){let id='';for(let i=0;i<10;i++)id+=A[Math.floor(rng()*36)];tr.setNodeAttribute(pos,'id',id+(idCounter++).toString(36));}
    else seen.add(node.attrs.id);return !node.isTextblock;
  });
}
export function withIds(pm,rng){const tr=EditorState.create({schema,doc:pm}).tr;fixBlockIds(tr,rng);return tr.doc;}
