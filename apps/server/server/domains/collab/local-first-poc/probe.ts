import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fragmentOf, toDocHandle, yProsemirrorModel } from '@meridian/agent-edit/integration';
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from '@meridian/markup';
import { buildDocumentSchema, createCollabYDoc } from '@meridian/prosemirror-schema';
import * as Y from 'yjs';
import { createInMemoryCoordinator, createInMemoryJournal } from '../adapters/in-memory/agent-edit.js';
import { createStaticDocumentLinkScopes, UNSUPPORTED_AHEAD_REFS } from '../adapters/in-memory/static-document-link-scopes.js';
import { createLinkBinder } from '../domain/link-binding.js';
import { createMarkdownDocumentEngine } from '../domain/markdown-document.js';
const schema=buildDocumentSchema(), model=yProsemirrorModel(schema), codec=mdxCodec({schema});
const id='p16402-doc' as any;
function subject(initial?: string, nodes?: any[]) {
 const journal=createInMemoryJournal(), coordinator=createInMemoryCoordinator(journal), links=createStaticDocumentLinkScopes();
 const engine=createMarkdownDocumentEngine({links,codec,exportCodec:mdxCodec({schema,export:true}),model,journal,coordinator,initialDocumentSeeds:{seedInitialDocument:(i,s)=>journal.seedInitialDocument(i,s),seedInitialDocuments:async()=>{},stageInitialStates:async()=>{},commitStagedStates:async()=>[],discardStagedStates:async()=>({remaining:false}),lacksAuthority:async i=>{const s=await journal.read(i);return !s.checkpoint&&!s.updates.length}},metaForOrigin:()=>({origin:'system',seq:0}),identityPreservingWrite:async()=>{throw Error('unused')},resolveFiletype:async()=> 'md'});
 const binder=createLinkBinder({codec,schema,model,coordinator,links,registrar:UNSUPPORTED_AHEAD_REFS,resolveFiletype:async()=> 'md',inTransaction:()=>false});
 const doc=coordinator.ensureEmpty(id);
 if(initial!==undefined||nodes) model.insertBlocks(toDocHandle(doc),null,{blocks:nodes??codec.parse(initial!).blocks});
 async function write(text:string){const content=await binder.bindMarkdown({holder:{documentId:id},markdown:text,against:'current'});const result=await engine.setMarkdown({documentId:id,content,origin:{type:'system'}});if(!result.ok) throw Error(JSON.stringify(result.error));return result.value;}
 return {doc,write,serialize:()=>engine.serializeDocument(id,doc,{kind:'live'})};
}
function stats(doc:Y.Doc){const m=new Map<string,boolean>(); for(const [client,ss] of (doc as any).store.clients) for(const s of ss) for(let i=0;i<s.length;i++)m.set(`${client}:${s.id.clock+i}`,!!s.deleted);return m;}
function delta(before:Map<string,boolean>,doc:Y.Doc){let inserted=0,deleted=0;const after=stats(doc);for(const [k,d] of after){if(!before.has(k))inserted++;else if(!before.get(k)&&d)deleted++;}return {inserted,deleted};}
async function probe(name:string, initial:string, edit:(s:string)=>string, nodes?:any[]){try{const s=subject(initial,nodes);const markdown=await s.serialize();const before=stats(s.doc);const t=performance.now();await s.write(edit(markdown));return {name,...delta(before,s.doc),ms:+(performance.now()-t).toFixed(2),serialized:markdown};}catch(e){return {name,error:String(e)};}}
const examples:Record<string,string>={paragraph:'One small sentence.\n\nAnother paragraph.\n',heading:'# The gate\n\nA line.\n',list:'- outer\n  - inner\n- [x] task\n- [ ] todo\n',table:'| Left | Right |\n| :--- | ---: |\n| a | b |\n',image:'Before ![alt](https://example.org/a.png) after.\n',link:'A [link](https://example.org) here.\n',code:'```ts\nconst a = 1;\n```\n',break:'first  \nsecond\n',mdx:'<Note title="Tip">\n\nA note.\n\n</Note>\n',figure:'<Figure src="https://example.org/a.png" caption="Hi" />\n',empty:'\n',quote:'> A quote.\n',strong:'**Bold** and *italic*.\n'};
const fixtures='apps/server/server/domains/import/__fixtures__/notes-folder/Chapters';for(const f of readdirSync(fixtures).filter(x=>x.endsWith('.md')))examples['fixture '+f]=readFileSync(`${fixtures}/${f}`,'utf8');
const special:Record<string,any[]>={};
const p=(attrs:any,children:any)=>schema.nodes.paragraph.create(attrs,children);
special['hidden link ref']=[p(null,schema.text('link',[schema.marks.link.create({href:'https://example.org/a',ref:'doc:abc'})]))];
special['image width']=[p(null,[schema.nodes.image.create({src:'https://example.org/a.png',alt:'pic',width:240})])];
special['image uploadToken']=[p(null,[schema.nodes.image.create({src:'https://example.org/a.png',uploadToken:'pending'})])];
special['aligned paragraph']=[p({align:'center'},schema.text('Centered'))];
special['empty paragraphs']=[p(null,null),p(null,schema.text('text')),p(null,null)];
const cell=(type:string,attrs:any,text:string)=>schema.nodes[type].create(attrs,p(null,schema.text(text)));
special['table spans']=[schema.nodes.table.create({align:'center'},[schema.nodes.table_row.create(null,[cell('table_header',{colspan:2,alignment:'right'},'Heading')]),schema.nodes.table_row.create(null,[cell('table_cell',{colspan:2},'value')])])];
async function main(){
 console.log('NOOP');for(const [name,text] of Object.entries(examples))console.log(JSON.stringify(await probe(name,text,s=>s)));for(const [name,nodes] of Object.entries(special))console.log(JSON.stringify(await probe(name,'',s=>s,nodes)));
 console.log('LOCALITY');const base='First paragraph has a quick brown fox.\n\nSecond paragraph has a quiet moon.\n\nThird paragraph stays here.\n';const edits:Record<string,(s:string)=>string>={'word':s=>s.replace('quick','slow'),'add paragraph':s=>s.replace('Second paragraph','Added paragraph.\n\nSecond paragraph'),'delete paragraph':s=>s.replace('Second paragraph has a quiet moon.\n\n',''),'swap paragraphs':s=>s.replace('First paragraph has a quick brown fox.\n\nSecond paragraph has a quiet moon.','Second paragraph has a quiet moon.\n\nFirst paragraph has a quick brown fox.')};for(const [n,f] of Object.entries(edits))console.log(JSON.stringify(await probe(n,base,f)));for(const [n,b,f] of [['table cell',examples.table,(s:string)=>s.replace('>a<','>z<')],['list item',examples.list,(s:string)=>s.replace('outer','outer changed')],['heading',examples.heading,(s:string)=>s.replace('gate','door')],['link text',examples.link,(s:string)=>s.replace('link','word')],['image neighbor',examples.image,(s:string)=>s.replace('Before','Beside')]] as const)console.log(JSON.stringify(await probe(n,b,f)));
 console.log('FORMATTING');const fmt='A *small* phrase.\n\n- one\n- two\n\n1. first\n2. second\n';const changes:Record<string,(s:string)=>string>={CRLF:s=>s.replace(/\n/g,'\r\n'), 'missing newline':s=>s.replace(/\n$/,''),'extra newline':s=>s+'\n',BOM:s=>'\ufeff'+s,'trailing spaces':s=>s.replace(/phrase\./,'phrase.   '),'hard wrap':s=>s.replace(' phrase.','\nphrase.'),'em markers':s=>s.replace(/\*small\*/,'_small_'),'list markers':s=>s.replace(/^- /gm,'* '),'renumber':s=>s.replace('2. second','7. second'),'smart quotes':s=>s.replace('A ','“A” ')};for(const [n,f] of Object.entries(changes))console.log(JSON.stringify(await probe(n,fmt,f)));
 const formatted=spawnSync('pnpm',['exec','prettier','--parser','markdown'],{input:fmt,encoding:'utf8'}); console.log(JSON.stringify({name:'prettier',status:formatted.status,stderr:formatted.stderr,...(formatted.status===0?await probe('prettier',fmt,()=>formatted.stdout):{})}));
 const large=Array.from({length:100},(_,i)=>`Paragraph ${i}: `+Array.from({length:50},(_,j)=>`word${i}_${j}`).join(' ')+'.').join('\n\n')+'\n';console.log('TIMING_5000_WORDS');for(let i=0;i<5;i++){const r=await probe('5000 words',large,s=>s);console.log(JSON.stringify({name:r.name,inserted:r.inserted,deleted:r.deleted,ms:r.ms}));}
 console.log('STALE');for(const [name,remote,local] of [['different paragraphs',(s:string)=>s.replace('quick','slow'),(s:string)=>s.replace('quiet','bright')],['same paragraph',(s:string)=>s.replace('quick','slow'),(s:string)=>s.replace('fox','cat')],['same sentence',(s:string)=>s.replace('quick','slow'),(s:string)=>s.replace('brown','red')],['same word',(s:string)=>s.replace('quick','slow'),(s:string)=>s.replace('quick','rapid')]] as const){try{const a=subject(base), initial=Y.encodeStateAsUpdate(a.doc), text=await a.serialize();await a.write(remote(text));const clone=subject();Y.applyUpdate(clone.doc,initial);const vector=Y.encodeStateVector(clone.doc);await clone.write(local(text));Y.applyUpdate(a.doc,Y.encodeStateAsUpdate(clone.doc,vector));console.log(JSON.stringify({name,merged:await a.serialize()}));}catch(e){console.log(JSON.stringify({name,error:String(e)}))}}
}
main().catch(e=>{console.error(e);process.exitCode=1});
