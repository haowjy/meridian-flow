import { createInterface } from 'node:readline';
import { toDocHandle, yProsemirrorModel } from '@meridian/agent-edit/integration';
import { mdxCodec } from '@meridian/markup';
import { buildDocumentSchema } from '@meridian/prosemirror-schema';
import * as Y from 'yjs';
import { createInMemoryCoordinator, createInMemoryJournal } from '../adapters/in-memory/agent-edit.js';
import { createStaticDocumentLinkScopes, UNSUPPORTED_AHEAD_REFS } from '../adapters/in-memory/static-document-link-scopes.js';
import { createLinkBinder } from '../domain/link-binding.js';
import { createMarkdownDocumentEngine } from '../domain/markdown-document.js';

const schema=buildDocumentSchema(), model=yProsemirrorModel(schema), codec=mdxCodec({schema});
const id='spike-document' as any;
export function subject(state?: string) {
 const journal=createInMemoryJournal(), coordinator=createInMemoryCoordinator(journal), links=createStaticDocumentLinkScopes();
 const engine=createMarkdownDocumentEngine({links,codec,exportCodec:mdxCodec({schema,export:true}),model,journal,coordinator,initialDocumentSeeds:{seedInitialDocument:(i,s)=>journal.seedInitialDocument(i,s),seedInitialDocuments:async()=>{},stageInitialStates:async()=>{},commitStagedStates:async()=>[],discardStagedStates:async()=>({remaining:false}),lacksAuthority:async i=>{const s=await journal.read(i);return !s.checkpoint&&!s.updates.length}},metaForOrigin:()=>({origin:'system',seq:0}),identityPreservingWrite:async()=>{throw Error('unused')},resolveFiletype:async()=> 'md'});
 const binder=createLinkBinder({codec,schema,model,coordinator,links,registrar:UNSUPPORTED_AHEAD_REFS,resolveFiletype:async()=> 'md',inTransaction:()=>false});
 const doc=coordinator.ensureEmpty(id);
 doc.clientID = state ? 654321 : 123456;
 if(state) Y.applyUpdate(doc,Buffer.from(state,'base64'));
 return {doc, async write(text:string,actor:string){const content=await binder.bindMarkdown({holder:{documentId:id},markdown:text,against:'current'});const result=await engine.setMarkdown({documentId:id,content,origin:{type:'user',actorUserId:actor as any}});if(!result.ok)throw Error(JSON.stringify(result.error));}, serialize:()=>engine.serializeDocument(id,doc,{kind:'live'})};
}
async function call(r:any) {
 const a=subject(r.a), b=subject(r.b || r.a);
 try {
  if(!r.a){model.insertBlocks(toDocHandle(a.doc),null,{blocks:codec.parse(r.text).blocks}); const state=Y.encodeStateAsUpdate(a.doc);return {update:Buffer.from(state).toString('base64'),state:Buffer.from(state).toString('base64'),markdown:await a.serialize(),changed:true};}
  const vector=Y.encodeStateVector(a.doc); await a.write(r.text,r.actor);
  const update=Y.encodeStateAsUpdate(a.doc,vector); Y.applyUpdate(b.doc,update);
  return {update:Buffer.from(update).toString('base64'),state:Buffer.from(Y.encodeStateAsUpdate(b.doc)).toString('base64'),markdown:await b.serialize(),changed:!(update.length===2&&update[0]===0&&update[1]===0)};
 } finally {a.doc.destroy();b.doc.destroy();}
}
if (process.argv.includes('--memory')) {
 const text=Array.from({length:100},(_,i)=>`Paragraph ${i}: `+Array.from({length:50},(_,j)=>`word${i}_${j}`).join(' ')+'.').join('\n\n')+'\n';
 const docs=[];
 for(let i=0;i<300;i++){const s=subject(); model.insertBlocks(toDocHandle(s.doc),null,{blocks:codec.parse(text).blocks}); docs.push(s);}
 console.log(JSON.stringify({phase:'import',rss:process.memoryUsage().rss}));
 const times=[]; for(let i=0;i<50;i++){const s=docs[i];const t=performance.now();await s.write(text.replace('word0_0','changed'), 'actor');times.push(performance.now()-t);}
 console.log(JSON.stringify({phase:'saves',rss:process.memoryUsage().rss,times}));
} else if (import.meta.main || process.argv.includes('--compare')) {
 const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
 for await(const line of rl){try{console.log(JSON.stringify({ok:true,...await call(JSON.parse(line))}));}catch(e){console.log(JSON.stringify({ok:false,error:String(e)}));}}
}
