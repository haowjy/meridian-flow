import { createCollabYDoc, buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from '@meridian/prosemirror-schema';
import { writeBlocks } from '@meridian/agent-edit/diff';
import { getTopLevelXmlBlocks, getBlockItemId, blockItemIdKey } from '@meridian/agent-edit/integration';
import { extractStoredLinks } from '@meridian/markup/stored-links';
import * as Y from 'yjs';
import { messageYjsUpdate } from 'y-protocols/sync';
import { createYjsRoomAccessIndex } from '../../../lib/yjs-room-access.js';
import { admitWriterSync, createHocuspocus } from '../../../lib/yjs-ws-handler.js';
import { createAllowAllFileAccess, createLocalFileAccessChanges } from '../../file-policy/index.js';
import { createInMemoryEventSink } from '../../observability/index.js';
import { createInMemoryJournal } from '../adapters/in-memory/agent-edit.js';
import { createHocuspocusPersistenceService } from '../hocuspocus-persistence.js';
import { seedDraftState } from '../domain/draft-content.js';

const documentId = '00000000-0000-4000-8000-000000000001' as never;
const userId = '00000000-0000-4000-8000-000000000002' as never;
const schema = buildDocumentSchema();
const frag = (doc: Y.Doc) => doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
const nodes = (...s: string[]) => s.map(x => schema.nodes.paragraph.create(null, schema.text(x)));
const ids = (d:Y.Doc) => getTopLevelXmlBlocks(d).map(b => blockItemIdKey(getBlockItemId(b)));
const show = (name:string, x:unknown) => console.log(name, JSON.stringify(x));
const seed = createCollabYDoc({gc:false});
writeBlocks(frag(seed),schema,nodes('first','sticky','last'));
seed.getMap('board-layout').set('target', {x:12,y:34});
const journal = createInMemoryJournal();
await journal.seedInitialDocument(documentId,Y.encodeStateAsUpdate(seed));
let hocuspocus: ReturnType<typeof createHocuspocus>;
const persistence = createHocuspocusPersistenceService({journal,hocuspocus:()=>hocuspocus,metaForOrigin:()=>({origin:'human:probe',seq:0}),emitAgentEditInvariantViolation:()=>undefined});
const documentSync = {...persistence, bindHocuspocus:()=>undefined,currentLiveGeneration:async()=>1n,primeReservedNamespaceIndex:()=>undefined,roomRemoval:async()=>null};
const services = {liveDocuments:{findById:async()=>({kind:'found' as const,document:{} as never,clashesWith:[]})},fileAccess:createAllowAllFileAccess(),fileAccessChanges:createLocalFileAccessChanges(),documentSync,eventSink:createInMemoryEventSink()};
hocuspocus = createHocuspocus(services as never,createYjsRoomAccessIndex());
let room = await hocuspocus.openDirectConnection(documentId,{userId} as never);
try {
 const writer = createCollabYDoc({gc:false}); Y.applyUpdate(writer,Y.encodeStateAsUpdate(room.document!));
 const vector=Y.encodeStateVector(writer); writer.getMap('board-layout').set('target',{x:99,y:77});
 const update=Y.encodeStateAsUpdate(writer,vector);
 await admitWriterSync({services:services as never,documentName:documentId,document:room.document!,syncType:messageYjsUpdate,payload:update,userId,expectedGeneration:1n});
 Y.applyUpdate(room.document!,update);
 show('admitted room layout', room.document!.getMap('board-layout').toJSON());
 const draft=seedDraftState(room.document!,documentId,1); const draftDoc=createCollabYDoc({gc:false}); Y.applyUpdate(draftDoc,draft.state);
 show('draft roots',[...draftDoc.share.keys()]); show('draft layout',draftDoc.getMap('board-layout').toJSON());
 await room.disconnect(); await persistence.drainHocuspocusPersistence();
 room=await hocuspocus.openDirectConnection(documentId,{userId} as never);
 show('reloaded room layout',room.document!.getMap('board-layout').toJSON());
 const peer=createCollabYDoc({gc:false}); Y.applyUpdate(peer,Y.encodeStateAsUpdate(room.document!)); show('synced peer layout',peer.getMap('board-layout').toJSON());
} finally { await room.disconnect(); await persistence.drainHocuspocusPersistence(); }

const d=createCollabYDoc({gc:false}); writeBlocks(frag(d),schema,nodes('first','sticky','last'));
show('initial ids',ids(d));
const sticky=getTopLevelXmlBlocks(d)[1]; const text=sticky.toArray()[0] as Y.XmlText; text.insert(3,'!'); show('edit inside ids',ids(d));
writeBlocks(frag(d),schema,nodes('changed first','sti!cky','last')); show('replace neighbour ids',ids(d));
writeBlocks(frag(d),schema,nodes('changed first','new sticky','last')); show('replace line ids',ids(d));
writeBlocks(frag(d),schema,nodes('entirely','different','document')); show('rewrite all ids',ids(d));
const l=createCollabYDoc({gc:false}); const p=new Y.XmlElement('paragraph'); const t=new Y.XmlText(); p.insert(0,[t]); frag(l).insert(0,[p]);
t.insert(0,'Lin',{link:{href:'../lin.md',ref:'doc:lin'}}); t.insert(3,' knows ',{link:null}); t.insert(10,'Seal',{link:{href:'../seal.md',ref:'doc:seal'}});
show('stored link occurrences',extractStoredLinks(frag(l))); show('xml delta',t.toDelta());
show('board from XML blocks',deriveBoard(l));
const s=createCollabYDoc({gc:false}); writeBlocks(frag(s),schema,nodes('first','sticky note','last')); show('split before',ids(s)); writeBlocks(frag(s),schema,nodes('first','sticky',' note','last')); show('split after',ids(s)); writeBlocks(frag(s),schema,nodes('first','sticky note','last')); show('join after',ids(s));

function deriveBoard(doc:Y.Doc) {
 const cards = new Map<string,string>(); const edges: unknown[]=[]; const notes:unknown[]=[]; const frames:unknown[]=[];
 for (const block of getTopLevelXmlBlocks(doc)) {
  const id=blockItemIdKey(getBlockItemId(block)); let plain=''; const links:{ref:string,start:number,end:number}[]=[];
  const walk=(node:Y.XmlElement|Y.XmlText) => {
   if(node instanceof Y.XmlText) for(const op of node.toDelta()) { if(typeof op.insert!=='string') continue; const start=plain.length; plain+=op.insert; const ref=op.attributes?.link?.ref; if(typeof ref==='string') {const last=links.at(-1); if(last?.ref===ref && last.end===start) last.end=plain.length; else links.push({ref,start,end:plain.length}); cards.set(ref,plain.slice(start,plain.length));} }
   else for(const child of node.toArray()) if(child instanceof Y.XmlElement || child instanceof Y.XmlText) walk(child);
  }; walk(block);
  if(block.nodeName==='heading') frames.push({id,text:plain});
  else if(!links.length) notes.push({id,text:plain});
  else if(links.length===1) { const before=plain.slice(0,links[0].start).trim(), after=plain.slice(links[0].end).trim(); if(before) edges.push({from:null,to:links[0].ref,label:before}); if(after) edges.push({from:links[0].ref,to:null,label:after}); }
  else for(let i=0;i<links.length-1;i++) edges.push({from:links[i].ref,to:links[i+1].ref,label:plain.slice(links[i].end,links[i+1].start).trim()});
 }
 return {cards:[...cards],edges,notes,frames};
}
