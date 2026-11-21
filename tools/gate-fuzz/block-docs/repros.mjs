import {LoroDoc} from 'loro-crdt';
import * as C from './codec.mjs';
import * as M from './model.mjs';
const docs=[];let peer=100;
function create(...text){C.resetIds();const d=C.newDocument('1');docs.push(d);const pm=C.schema.nodes.doc.create(null,text.map(t=>C.schema.nodes.paragraph.create(null,t?C.schema.text(t):null)));C.write(d,C.withIds(pm,()=>.2),{rng:()=>.2});return d;}
function fork(d,p=String(++peer)){const f=C.forkDocument(d,p);docs.push(f);return f;}
const edit=(d,fn)=>C.edit(d,fn,{rng:()=>.3});
const text=d=>C.read(d).content.content.map(x=>x.textContent).join(' | ');
const ids=d=>C.read(d).content.content.map(x=>x.attrs.id);
const at=(d,i)=>{let p=0;for(let k=0;k<i;k++)p+=d.child(k).nodeSize;return p};
const sync=(a,b)=>{M.forward(a,b);M.forward(b,a)};
const out=(name,ok,detail)=>console.log(`${ok?'ok  ':'FAIL'} ${name}\n     ${detail}`);
try {
{
 const results=[];
 for(const [aPeer,bPeer] of [['1','100'],['100','1']]){const a=new LoroDoc();a.setPeerId(aPeer);a.configDefaultTextStyle({expand:'none'});a.getText('t').insert(0,'abcdef');a.commit();const b=a.fork();b.setPeerId(bPeer);b.configDefaultTextStyle({expand:'none'});a.getText('t').mark({start:1,end:3},'comment_c1',true);a.commit();b.getText('t').insert(3,'XY');b.commit();a.import(b.export({mode:'update',from:a.oplogVersion()}));results.push(a.getText('t').toDelta().map(x=>x.attributes?`[${x.insert}]`:x.insert).join(''));a.free();b.free();}
 out('R1 Loro boundary peer order',results[0]===results[1],results.join(' / '));
}
{
 for(const [lp,fp] of [['101','202'],['202','101']]){const l=create('abcdef');l.peer=lp;l.structure.setPeerId(lp);for(const d of l.texts.values())d.setPeerId(lp);const f=fork(l,fp);edit(f,tr=>tr.insertText('XY',4));edit(f,tr=>tr.addMark(2,4,C.schema.marks.comment.create({id:'c1'})));edit(l,tr=>tr.insertText('QQ',4));M.applyBlocks(l,f,'all');const a=JSON.stringify(C.read(l).toJSON()),b=JSON.stringify(C.read(f).toJSON());out(`R2 Apply with concurrent boundary peers ${lp}/${fp}`,a===b,`live ${a}; fork ${b}`);}
}
{
 const l=create('Q','H'),f=fork(l);const p=t=>C.schema.nodes.paragraph.create(null,C.schema.text(t));edit(f,(tr,d)=>tr.insert(at(d,1),C.schema.nodes.doc.create(null,[p('V'),p('F')]).content));const before=text(f),id=ids(f)[2];M.applyBlocks(l,f,[id]);out('R3 partial Apply retains draft order',text(f)===before,`before ${before}; fork ${text(f)}; live ${text(l)}`);
}
for(const mode of ['tab synced','tab unsynced']){
 const l=create('A','B','C'),tab=fork(l,'2'),f=fork(l),id=ids(f)[1];edit(f,(tr,d)=>tr.delete(at(d,1),at(d,2)));M.resetBlocks(l,f,[id]);if(mode==='tab synced')M.forward(l,tab);edit(tab,(tr,d)=>tr.insertText(' typed',at(d,1)+2));M.forward(tab,l);M.forward(l,f);const pending=M.changedBlocks(l,f).length;out(`R4 Reset then Live typing (${mode})`,pending===0&&text(f).includes('typed'),`live ${text(l)}; fork ${text(f)}; pending ${pending}`);
}
{
 const l=create('alpha','beta'),f=fork(l),before=M.frontiers(f),tab=fork(l,'2');edit(f,tr=>tr.insertText('TURN ',1));edit(tab,(tr,d)=>tr.insertText('LIVE ',at(d,1)+1));M.forward(tab,l);M.restoreBeforeOnLive(l,f,before);out('R5 Restore before on Live',text(f)===text(l),`live ${text(l)}; fork ${text(f)}`);
}
console.log('n/a  R6 container drift: no block container list');
{
 const l=create('one two three'),a=fork(l,'2'),b=fork(l,'3');edit(a,tr=>tr.insert(4,C.schema.nodes.hard_break.create()));edit(b,tr=>tr.delete(8,14));sync(a,b);out('R7 inline insertion versus concurrent delete',!text(a).includes('three'),`merged ${JSON.stringify(text(a))}`);
}
console.log('n/a  R8 unlink generations: Discard B only');
{
 const l=create('alpha','beta'),f=fork(l);edit(f,tr=>tr.insertText('DRAFT ',1));const stale=fork(f,'4');edit(stale,(tr,d)=>tr.insertText(' typed',at(d,1)+5));M.resetBlocks(l,f,'all');M.forward(stale,f);out('R9 Discard B with stale tab',!text(f).includes('DRAFT')&&text(f).includes('typed'),`fork ${text(f)}`);
}
{
 const l=create('one two'),a=fork(l,'2'),b=fork(l,'3');edit(a,tr=>tr.addMark(1,4,C.schema.marks.code.create()));edit(b,tr=>tr.addMark(1,4,C.schema.marks.em.create()));sync(a,b);let error='';try{C.read(a).check()}catch(e){error=e.message}out('R10 normalize code excludes',!error,`result ${error||'valid'}; ${JSON.stringify(C.read(a).toJSON())}`);
}
{
 const l=create('root'),f=fork(l),s=C.schema;const para=s.nodes.paragraph.create(null,s.text('cell'));const cell=s.nodes.table_cell.create(null,[para]);const row=s.nodes.table_row.create(null,[cell]);const table=s.nodes.table.create(null,[row]);edit(f,(tr,d)=>tr.insert(d.content.size,table));const tableId=C.read(f).child(1).attrs.id;M.applyBlocks(l,f,[tableId]);let err='';try{C.read(l).check()}catch(e){err=e.message}out('N1 partial Apply of a new table',!err,err||'valid');
}
{
 const l=create('root'),f=fork(l),s=C.schema;const p=s.nodes.paragraph.create(null,s.text('cell'));const table=s.nodes.table.create(null,[s.nodes.table_row.create(null,[s.nodes.table_cell.create(null,[p])])]);edit(f,(tr,d)=>tr.insert(d.content.size,table));const t=C.read(f).child(1),id=t.child(0).child(0).child(0).attrs.id;M.applyBlocks(l,f,[id]);out('N2 partial Apply of child with draft-only parent',!M.changedBlocks(l,f).includes(id),`child still pending: ${M.changedBlocks(l,f).includes(id)}; Live ${text(l)}`);
}
{
 const l=create('one','two'),mark=C.schema.marks.comment.create({id:'c1'});l.structure.getMap('comments').set('c1',{body:'note'});edit(l,tr=>tr.addMark(1,4,mark));l.structure.commit();const tab=fork(l,'2'),f=fork(l,'3');edit(f,(tr,d)=>tr.removeMark(0,d.content.size,mark));edit(tab,(tr,d)=>tr.addMark(at(d,1)+1,at(d,1)+4,mark));M.applyBlocks(l,f,'all');M.forward(tab,l);let found=false;C.read(l).descendants(n=>{if(n.marks.some(m=>m.type.name==='comment'&&m.attrs.id==='c1'))found=true;});out('N3 concurrent comment after body cleanup',!found||l.structure.getMap('comments').get('c1')!==undefined,`mark ${found}; body ${JSON.stringify(l.structure.getMap('comments').get('c1'))}`);
}
for(const half of [0,1]){
 const l=create('s1k s2k'),f=fork(l);edit(f,tr=>tr.split(4));const selected=ids(f)[half];M.applyBlocks(l,f,[selected]);const matches=(text(l).match(/s2k/g)??[]).length;out(`N4 split then Apply half ${half+1}`,matches===1,`Live ${text(l)}; Draft ${text(f)}; s2k count ${matches}`);
}
{
 const l=create('one'),f=fork(l),before=M.frontiers(f),p=C.schema.nodes.paragraph.create(null,C.schema.text('LIVE'));edit(l,(tr,d)=>tr.insert(d.content.size,p));M.forward(l,f);edit(f,(tr,d)=>tr.insertText(' DRAFT',at(d,1)+5));M.restoreBeforeOnLive(l,f,before);out('N5 Restore before with a later Live-created block',!text(f).includes('DRAFT'),`live ${text(l)}; restored draft ${text(f)}`);
}
{
 const l=create('s1k s2k'),f=fork(l);edit(f,tr=>tr.split(4));M.resetBlocks(l,f,[ids(f)[0]]);M.applyBlocks(l,f,'all');const count=(text(l).match(/s2k/g)??[]).length;out('N6 Reset one half of a split then Apply all',count===1,`Live ${text(l)}; count ${count}`);
}
{
 const l=create('abc'),f=fork(l);edit(f,tr=>tr.insertText('X',2,3));M.resetBlocks(l,f,'all');edit(l,tr=>tr.delete(2,3));M.forward(l,f);out('N7 Reset edited text then Live deletes original',text(f)===text(l),`Live ${text(l)}; fork ${text(f)}; pending ${JSON.stringify(M.changedBlocks(l,f))}`);
}
{
 const l=create('abc'),f=fork(l);edit(f,(tr,d)=>tr.setBlockType(0,d.content.size,C.schema.nodes.code_block,{id:ids(f)[0]}));edit(l,tr=>tr.insert(2,C.schema.nodes.hard_break.create()));M.forward(l,f);let error='';try{C.read(f).check()}catch(e){error=e.message}out('N8 concurrent setType and inline insertion',!error,error||'valid');
}
{
 const l=create('s25k'),f=fork(l);edit(f,tr=>tr.insert(1,C.schema.nodes.hard_break.create()));edit(l,tr=>tr.insertText('l26k',1,5));M.forward(l,f);const json=C.read(f).toJSON();out('N9 concurrent inline at start of a replaced word',C.read(f).textBetween(0,C.read(f).content.size,' ',' ').includes('l26k'),`Live ${text(l)}; fork ${JSON.stringify(json)}`);
}
{
 const l=create('abc'),f=fork(l);edit(f,(tr,d)=>tr.setBlockType(0,d.content.size,C.schema.nodes.code_block,{id:ids(f)[0]}));edit(l,tr=>tr.addMark(1,3,C.schema.marks.em.create()));M.forward(l,f);let error='';try{C.read(f).check()}catch(e){error=e.message}out('N10 concurrent setType and text mark',!error,error||'valid');
}
{
 const l=create('s1k','s2k'),f=fork(l),id=ids(f)[1];edit(f,(tr,d)=>tr.join(at(d,1)));M.resetBlocks(l,f,[id]);M.applyBlocks(l,f,'all');const count=(text(l).match(/s2k/g)??[]).length;out('N11 Reset deleted half of a join then Apply all',count===1,`Live ${text(l)}; count ${count}`);
}
} finally {for(const d of docs)C.freeDocument(d);}
