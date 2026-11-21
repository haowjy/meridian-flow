import {LoroDoc} from 'loro-crdt';
import * as C from './codec.mjs';
import * as M from './model.mjs';
import {keyBetween} from './structure.mjs';
const docs=[];let peer=100;
function create(...text){C.resetIds();const d=C.newDocument('1');docs.push(d);const pm=C.schema.nodes.doc.create(null,text.map(t=>C.schema.nodes.paragraph.create(null,t?C.schema.text(t):null)));C.write(d,C.withIds(pm,()=>.2),{rng:()=>.2});return d;}
function fork(d,p=String(++peer),draft=true){const f=C.forkDocument(d,p,draft);docs.push(f);return f;}
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
 const l=create('A','B','C'),tab=fork(l,'2',false),f=fork(l),id=ids(f)[1];edit(f,(tr,d)=>tr.delete(at(d,1),at(d,2)));M.resetBlocks(l,f,[id]);if(mode==='tab synced')M.forward(l,tab);edit(tab,(tr,d)=>tr.insertText(' typed',at(d,1)+2));M.forward(tab,l);M.forward(l,f);const pending=M.changedBlocks(l,f).length;out(`R4 Reset then Live typing (${mode})`,pending===0&&text(f).includes('typed'),`live ${text(l)}; fork ${text(f)}; pending ${pending}`);
}
{
 const l=create('alpha','beta'),f=fork(l),before=M.frontiers(f),tab=fork(l,'2',false);edit(f,tr=>tr.insertText('TURN ',1));edit(tab,(tr,d)=>tr.insertText('LIVE ',at(d,1)+1));M.forward(tab,l);M.restoreBeforeOnLive(l,f,before);out('R5 Restore before on Live',text(f)===text(l),`live ${text(l)}; fork ${text(f)}`);
}
console.log('n/a  R6 container drift: no block container list');
{
 const l=create('one two three'),a=fork(l,'2',false),b=fork(l,'3',false);edit(a,tr=>tr.insert(4,C.schema.nodes.hard_break.create()));edit(b,tr=>tr.delete(8,14));sync(a,b);out('R7 inline insertion versus concurrent delete',!text(a).includes('three'),`merged ${JSON.stringify(text(a))}`);
}
console.log('n/a  R8 unlink generations: Discard B only');
{
 const l=create('alpha','beta'),f=fork(l);edit(f,tr=>tr.insertText('DRAFT ',1));const stale=fork(f,'4');edit(stale,(tr,d)=>tr.insertText(' typed',at(d,1)+5));M.resetBlocks(l,f,'all');M.forward(stale,f);out('R9 Discard B with stale tab',!text(f).includes('DRAFT')&&text(f).includes('typed'),`fork ${text(f)}`);
}
{
 const l=create('one two'),a=fork(l,'2',false),b=fork(l,'3',false);edit(a,tr=>tr.addMark(1,4,C.schema.marks.code.create()));edit(b,tr=>tr.addMark(1,4,C.schema.marks.em.create()));sync(a,b);let error='';try{C.read(a).check()}catch(e){error=e.message}out('R10 normalize code excludes',!error,`result ${error||'valid'}; ${JSON.stringify(C.read(a).toJSON())}`);
}
{
 const l=create('root'),f=fork(l),s=C.schema;const para=s.nodes.paragraph.create(null,s.text('cell'));const cell=s.nodes.table_cell.create(null,[para]);const row=s.nodes.table_row.create(null,[cell]);const table=s.nodes.table.create(null,[row]);edit(f,(tr,d)=>tr.insert(d.content.size,table));const tableId=C.read(f).child(1).attrs.id;M.applyBlocks(l,f,[tableId]);let err='';try{C.read(l).check()}catch(e){err=e.message}out('N1 partial Apply of a new table',!err,err||'valid');
}
{
 const l=create('root'),f=fork(l),s=C.schema;const p=s.nodes.paragraph.create(null,s.text('cell'));const table=s.nodes.table.create(null,[s.nodes.table_row.create(null,[s.nodes.table_cell.create(null,[p])])]);edit(f,(tr,d)=>tr.insert(d.content.size,table));const t=C.read(f).child(1),id=t.child(0).child(0).child(0).attrs.id;M.applyBlocks(l,f,[id]);out('N2 partial Apply of child with draft-only parent',!M.changedBlocks(l,f).includes(id),`child still pending: ${M.changedBlocks(l,f).includes(id)}; Live ${text(l)}`);
}
{
 const l=create('one','two'),mark=C.schema.marks.comment.create({id:'c1'});l.structure.getMap('comments').set('c1',{body:'note'});edit(l,tr=>tr.addMark(1,4,mark));l.structure.commit();const tab=fork(l,'2',false),f=fork(l,'3');edit(f,(tr,d)=>tr.removeMark(0,d.content.size,mark));edit(tab,(tr,d)=>tr.addMark(at(d,1)+1,at(d,1)+4,mark));M.applyBlocks(l,f,'all');M.forward(tab,l);let found=false;C.read(l).descendants(n=>{if(n.marks.some(m=>m.type.name==='comment'&&m.attrs.id==='c1'))found=true;});out('N3 concurrent comment after body cleanup',!found||l.structure.getMap('comments').get('c1')!==undefined,`mark ${found}; body ${JSON.stringify(l.structure.getMap('comments').get('c1'))}`);
}
for(const half of [0,1]){
 const l=create('s1k s2k s3k s4k s5k s6k'),f=fork(l);edit(f,tr=>tr.split(4));const selected=ids(f)[half];M.applyBlocks(l,f,[selected]);const matches=(text(l).match(/s2k/g)??[]).length;out(`N4 split then Apply half ${half+1}`,matches===1,`Live ${text(l)}; Draft ${text(f)}; s2k count ${matches}`);
}
{
 const l=create('one'),f=fork(l),before=M.frontiers(f),p=C.schema.nodes.paragraph.create(null,C.schema.text('LIVE'));edit(l,(tr,d)=>tr.insert(d.content.size,p));M.forward(l,f);edit(f,(tr,d)=>tr.insertText(' DRAFT',at(d,1)+5));M.restoreBeforeOnLive(l,f,before);out('N5 Restore before with a later Live-created block',!text(f).includes('DRAFT'),`live ${text(l)}; restored draft ${text(f)}`);
}
{
 const l=create('s1k s2k s3k s4k s5k s6k'),f=fork(l);edit(f,tr=>tr.split(4));M.resetBlocks(l,f,[ids(f)[0]]);M.applyBlocks(l,f,'all');const count=(text(l).match(/s2k/g)??[]).length;out('N6 Reset one half of a split then Apply all',count===1,`Live ${text(l)}; count ${count}`);
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
 const l=create('s1k ','s2k s3k s4k s5k'),f=fork(l),id=ids(f)[1];edit(f,(tr,d)=>tr.join(at(d,1)));M.resetBlocks(l,f,[id]);M.applyBlocks(l,f,'all');const count=(text(l).match(/s2k/g)??[]).length;out('N11 Reset deleted half of a join then Apply all',count===1,`Live ${text(l)}; count ${count}`);
}
{
 const l=create('root'),f=fork(l,'100'),p=C.schema.nodes.paragraph.create(null,C.schema.text('new'));edit(f,(tr,d)=>tr.insert(d.content.size,p));const id=ids(f)[1],press=M.applyBlocks(l,f,[id]);edit(f,(tr,d)=>tr.delete(at(d,1),at(d,2)));for(const r of press.changed){const bytes=M.invertCommit(r.doc,r.before,r.after,'2');if(r.id!==null)M.returnToPending(f.texts.get(r.id),bytes);}for(const r of press.forkChanged)M.invertCommit(r.doc,r.before,r.after,'3');M.forward(l,f);out('N12 Undo after draft deletes newly applied block',!text(f).includes('new'),`Live ${text(l)}; fork ${text(f)}; pending ${JSON.stringify(M.changedBlocks(l,f))}`);
}
{
 const l=create('one','two'),f=fork(l),mark=C.schema.marks.comment.create({id:'c1'});f.structure.getMap('d.comments').set('c1',{body:'note'});f.structure.commit();edit(f,(tr,d)=>tr.addMark(1,4,mark).addMark(at(d,1)+1,at(d,1)+4,mark));const [a,b]=ids(f);M.resetBlocks(l,f,[a]);M.applyBlocks(l,f,[b]);const body=l.structure.getMap('comments').get('c1');const marked=[...l.texts.keys()].some(id=>M.carried(l,id).has('c1'));out('N13 reset one carrier then apply the other',!marked||body!==undefined,`mark ${marked}; body ${JSON.stringify(body)}; draft ${text(f)}`);
}
{
 const l=create('s1k s2k s3k s4k'),f=fork(l);edit(f,tr=>tr.split(4));const [source,half]=ids(f);edit(f,(tr,d)=>tr.delete(at(d,0),at(d,1)));M.applyBlocks(l,f,[half]);const count=(text(l).match(/s2k/g)??[]).length;out('N14 split with source deleted',count===1,`Live ${text(l)}; s2k count ${count}; source ${source}`);
}
{
 const l=create('s77k'),f=fork(l);edit(f,tr=>tr.delete(3,4));edit(l,tr=>tr.insertText('l77k',1,5));M.forward(l,f);out('N15 concurrent delete removes a character reused by replacement',text(f).includes('l77k'),`live ${text(l)}; fork ${text(f)}`);
}
{
 const l=create('one','two'),f=fork(l),mark=C.schema.marks.comment.create({id:'c1'});f.structure.getMap('d.comments').set('c1',{body:'note'});f.structure.commit();edit(f,(tr,d)=>tr.addMark(1,4,mark).addMark(at(d,1)+1,at(d,1)+4,mark));const chosen=ids(f)[1];M.applyBlocks(l,f,[chosen]);const carried=C.read(l).child(1).content.content.some(n=>n.marks.some(m=>m.type.name==='comment'));out('N16 Apply non-owner carrier before body owner',!carried||l.structure.getMap('comments').get('c1')!==undefined,`Live mark ${carried}; body ${JSON.stringify(l.structure.getMap('comments').get('c1'))}; first carrier still pending ${M.changedBlocks(l,f).includes(ids(f)[0])}`);
}
{
 const l=create('word'),f=fork(l),id=ids(f)[0];edit(f,(tr,d)=>tr.setNodeMarkup(0,null,{...d.child(0).attrs,level:2}));edit(l,(tr,d)=>tr.setNodeMarkup(0,null,{...d.child(0).attrs,level:2}));M.forward(l,f);edit(f,tr=>tr.insertText('!',1));const removed=f.structure.getMap('d.attrs').get(id+'/level')===undefined;edit(l,(tr,d)=>tr.setNodeMarkup(0,null,{...d.child(0).attrs,level:3}));M.forward(l,f);out('N17 matching override cleared on next write',removed&&C.read(f).child(0).attrs.level===3,`override removed ${removed}; later Live level ${C.read(f).child(0).attrs.level}`);
}
{
 const l=create('one','two'),mark=C.schema.marks.comment.create({id:'c1'});l.structure.getMap('comments').set('c1',{body:'original'});l.structure.commit();edit(l,(tr,d)=>tr.addMark(1,4,mark).addMark(at(d,1)+1,at(d,1)+4,mark));const f=fork(l),[first,second]=ids(f);f.structure.getMap('d.comments').set('c1',{body:'edited'});f.structure.commit();const pending=M.changedBlocks(l,f);M.resetBlocks(l,f,[first]);out('N18 existing comment body is its own group',pending.includes('c1')&&!pending.includes(first)&&!pending.includes(second)&&f.structure.getMap('d.comments').get('c1')!==undefined,`pending ${JSON.stringify(pending)}; override after owner Reset ${JSON.stringify(f.structure.getMap('d.comments').get('c1'))}`);
}
{
 const l=create('abc','other'),f=fork(l),id=ids(f)[0];edit(f,(tr,d)=>tr.setBlockType(0,at(d,1),C.schema.nodes.code_block,{id}));edit(l,tr=>tr.addMark(1,3,C.schema.marks.em.create()));M.forward(l,f);const before=f.texts.get(id).frontiers();edit(f,(tr,d)=>tr.insertText('!',at(d,1)+1));const after=f.texts.get(id).frontiers();out('N19 normalized-away marks do not write back',M.same(before,after),`text frontier unchanged ${M.same(before,after)}`);
}
{
 const l=create('root'),s=l.structure;for(const [id,node,parent,order] of [['a','table_cell','z','U'],['z','jsx_container','a','j']]){s.getMap('node').set(id,node);s.getMap('parent').set(id,parent);s.getMap('order').set(id,order);}s.getMap('attrs').set('z/name','Aside');s.getMap('attrs').set('z/props',{});s.commit();let error='';try{C.read(l).check()}catch(e){error=e.message}out('N20 smallest cycle member is not valid at document root',!error,error||'valid');
}
{
 const l=create('s1k s2k s3k s4k'),f=fork(l);edit(f,tr=>tr.split(4));M.applyBlocks(l,f,[ids(f)[0]]);out('N21 split with moved characters groups',text(l).includes('s2k'),`Live ${text(l)}; Draft ${text(f)}`);
}
{
 const l=create('one','two'),f=fork(l),[first,second]=ids(f),mark=C.schema.marks.comment.create({id:'c1'});edit(f,(tr,d)=>tr.setBlockType(0,at(d,1),C.schema.nodes.code_block,{id:first}));l.structure.getMap('comments').set('c1',{body:'original'});l.structure.commit();edit(l,(tr,d)=>tr.addMark(1,4,mark).addMark(at(d,1)+1,at(d,1)+4,mark));M.forward(l,f);f.structure.getMap('d.comments').set('c1',{body:'edited'});f.structure.commit();const before=M.changedBlocks(l,f);M.resetBlocks(l,f,[second]);out('N22 existing body remains separate from carriers',before.includes('c1')&&!before.includes(second)&&f.structure.getMap('d.comments').get('c1')!==undefined,`pending ${JSON.stringify(before)}; override after shown carrier Reset ${JSON.stringify(f.structure.getMap('d.comments').get('c1'))}`);
}
{
 const l=create('one','two'),mark=C.schema.marks.comment.create({id:'c1'});l.structure.getMap('comments').set('c1',{body:'original'});l.structure.commit();edit(l,(tr,d)=>tr.addMark(1,4,mark).addMark(at(d,1)+1,at(d,1)+4,mark));const f=fork(l),[first,second]=ids(f);edit(f,tr=>tr.removeMark(1,4,mark));f.structure.getMap('d.comments').set('c1',{body:'edited'});f.structure.commit();M.resetBlocks(l,f,[first]);out('N23 block Reset leaves independent body pending',f.structure.getMap('d.comments').get('c1')!==undefined&&!M.changedBlocks(l,f).includes(first)&&M.changedBlocks(l,f).includes('c1'),`override ${JSON.stringify(f.structure.getMap('d.comments').get('c1'))}; pending ${JSON.stringify(M.changedBlocks(l,f))}`);
}
{
 const l=create('one','two'),f=fork(l),[a,b]=ids(f),work=C.lazyTurn(f,'700');const initially=work.texts.get(a)===f.texts.get(a)&&work.texts.get(b)===f.texts.get(b),frontier=f.texts.get(a).frontiers();edit(work,tr=>tr.insertText('!',1));const forked=work.texts.get(a)!==f.texts.get(a)&&work.texts.get(b)===f.texts.get(b)&&M.same(work.forkTimes.get(a),frontier);C.freeDocument(work);out('N24 AI forks a text doc on first write',initially&&forked,`shared before ${initially}; only edited block forked at its frontier ${forked}`);
}
for(const peer of ['3','900000000000000005']){
 const l=create('word'),f=fork(l,'100'),id=ids(f)[0];edit(f,(tr,d)=>tr.setNodeMarkup(0,null,{...d.child(0).attrs,level:2}));const press=M.applyBlocks(l,f,[id]);edit(f,(tr,d)=>tr.setNodeMarkup(0,null,{...d.child(0).attrs,level:3}));for(const rec of press.changed)M.invertCommit(rec.doc,rec.before,rec.after,'500');for(const rec of press.forkChanged)M.invertCommit(rec.doc,rec.before,rec.after,peer);M.forward(l,f);out(`N25 press Undo after draft attribute changed (inverse peer ${peer})`,C.read(f).child(0).attrs.level===3,`live ${C.read(l).child(0).attrs.level}; fork ${C.read(f).child(0).attrs.level}`);
}
{
 const l=create('A','B','C'),f=fork(l),[a,b,c]=ids(f),s=f.structure,old=s.getMap('order').get(b),other=keyBetween(s.getMap('order').get(a),s.getMap('order').get(c),()=>.7);s.getMap('d.order').set(b,other);s.commit();edit(f,(tr,d)=>tr.insertText('!',at(d,1)+1));const cleared=s.getMap('d.order').get(b)===undefined;edit(l,(tr,d)=>{const node=d.child(1),from=at(d,1),to=at(d,2);tr.delete(from,to);return tr.insert(tr.doc.content.size,node)});M.forward(l,f);out('N26 equal relative-order override clears on next write',old!==other&&cleared&&ids(f).at(-1)===b,`override cleared ${cleared}; Live ${ids(l).join(',')}; fork ${ids(f).join(',')}`);
}
{
 const l=create('root'),f=fork(l,'100'),p=C.schema.nodes.paragraph.create(null,C.schema.text('new'));edit(f,(tr,d)=>tr.insert(d.content.size,p));const id=ids(f)[1],press=M.applyBlocks(l,f,[id]);edit(f,(tr,d)=>tr.delete(at(d,1),at(d,2)));for(const r of press.changed){const bytes=M.invertCommit(r.doc,r.before,r.after,'2');if(r.id!==null)M.returnToPending(f.texts.get(r.id),bytes);}for(const r of press.forkChanged)M.invertCommit(r.doc,r.before,r.after,'3');M.forward(l,f);out('N27 Undo after writer deletes newly applied block',!M.changedBlocks(l,f).includes(id),`Live ${text(l)}; fork ${text(f)}; pending ${JSON.stringify(M.changedBlocks(l,f))}`);
}
{
 const l=create('one two'),f=fork(l),id=ids(f)[0];edit(l,tr=>tr.insert(4,C.schema.nodes.hard_break.create()));M.forward(l,f);edit(f,(tr,d)=>tr.setBlockType(0,d.content.size,C.schema.nodes.code_block,{id}));const before=JSON.stringify(f.texts.get(id).getText('t').toDelta());edit(f,(tr,d)=>tr.insertText('!',d.child(0).content.size+1));const after=JSON.stringify(f.texts.get(id).getText('t').toDelta());out('N29 typing in normalized code block preserves hidden inline data',after.includes('hard_break'),`before ${before}; after ${after}`);
}
{
 const l=create('root'),p=C.schema.nodes.paragraph.create(null,C.schema.text('x')),box=C.schema.nodes.jsx_container.create({name:'Aside'},[p]);edit(l,(tr,d)=>tr.insert(d.content.size,box));const container=C.read(l).child(1),child=container.child(0).attrs.id;l.structure.getMap('order').set(child,null);l.structure.commit();const empty=C.read(l).child(1).child(0);let pos=0;C.read(l).descendants((n,p)=>{if(n.type.name==='paragraph'&&n.attrs.id?.endsWith('/empty'))pos=p+1;});edit(l,tr=>tr.insertText('new',pos));const added=C.read(l).child(1).child(0);out('N30 first edit materializes normalized empty paragraph',empty.attrs.id===container.attrs.id+'/empty'&&added.attrs.id===empty.attrs.id&&added.textContent==='new',`before id ${empty.attrs.id}; after id ${added.attrs.id}; text ${added.textContent}`);
}
{
 const l=create('root'),p=C.schema.nodes.paragraph.create(null,C.schema.text('x')),box=C.schema.nodes.jsx_container.create({name:'Aside'},[p]);edit(l,(tr,d)=>tr.insert(d.content.size,box));const parent=C.read(l).child(1),child=parent.child(0).attrs.id;l.structure.getMap('order').set(child,null);l.structure.commit();const a=fork(l,'2',false),b=fork(l,'3',false);const position=d=>{let pos;C.read(d).descendants((n,p)=>{if(n.attrs.id===parent.attrs.id+'/empty')pos=p+1;});return pos;};edit(a,tr=>tr.insertText('A',position(a)));edit(b,tr=>tr.insertText('B',position(b)));sync(a,b);const na=C.read(a).child(1).child(0),nb=C.read(b).child(1).child(0);out('N31 two peers materialize one empty paragraph',na.attrs.id===parent.attrs.id+'/empty'&&nb.attrs.id===na.attrs.id&&na.textContent===nb.textContent&&na.textContent.includes('A')&&na.textContent.includes('B'),`A ${na.attrs.id} ${na.textContent}; B ${nb.attrs.id} ${nb.textContent}`);
}
{
 const l=create('abc'),id=ids(l)[0],td=l.texts.get(id);td.getText('t').mark({start:0,end:3},'comment_c1',true);td.commit();const before=td.frontiers(),hidden=JSON.stringify(C.read(l).toJSON()),f=fork(l);f.structure.getMap('d.comments').set('c1',{body:'fork'});f.structure.commit();const shown=JSON.stringify(C.read(f).toJSON()),groups=M.groups(l,f);out('N32 missing body hides mark without a write; fork override shows it',!hidden.includes('comment')&&shown.includes('comment')&&M.same(before,td.frontiers())&&groups.some(g=>g.blocks.includes(id)&&g.comments.includes('c1')),`Live ${hidden}; fork ${shown}; groups ${JSON.stringify(groups)}`);
}
} finally {for(const d of docs)C.freeDocument(d);}
