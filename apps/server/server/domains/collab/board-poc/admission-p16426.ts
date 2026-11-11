import { createCollabYDoc } from '@meridian/prosemirror-schema';
import { messageYjsUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';
import { createYjsRoomAccessIndex } from '../../../lib/yjs-room-access.js';
import { admitWriterSync,createHocuspocus } from '../../../lib/yjs-ws-handler.js';
import { createAllowAllFileAccess,createLocalFileAccessChanges } from '../../file-policy/index.js';
import { createInMemoryEventSink } from '../../observability/index.js';
import { createInMemoryJournal } from '../adapters/in-memory/agent-edit.js';
import { createHocuspocusPersistenceService } from '../hocuspocus-persistence.js';
const id='00000000-0000-4000-8000-000000000001' as never, userId='00000000-0000-4000-8000-000000000002' as never;
const seed=createCollabYDoc({gc:false}),journal=createInMemoryJournal(); await journal.seedInitialDocument(id,Y.encodeStateAsUpdate(seed));
let server:any; const callbacks:any[]=[];
const persistence=createHocuspocusPersistenceService({journal,hocuspocus:()=>server,metaForOrigin:()=>({origin:'human:probe',seq:0}),emitAgentEditInvariantViolation:()=>{},onLiveUpdatePersisted:(doc)=>callbacks.push(doc)});
const services={liveDocuments:{findById:async()=>({kind:'found',document:{},clashesWith:[]})},fileAccess:createAllowAllFileAccess(),fileAccessChanges:createLocalFileAccessChanges(),documentSync:{...persistence,bindHocuspocus:()=>{},currentLiveGeneration:async()=>1n,primeReservedNamespaceIndex:()=>{},roomRemoval:async()=>null},eventSink:createInMemoryEventSink()};
server=createHocuspocus(services as never,createYjsRoomAccessIndex()); const connection=await server.openDirectConnection(id,{userId});
try { const doc=connection.document; const client=createCollabYDoc({gc:false}); Y.applyUpdate(client,Y.encodeStateAsUpdate(doc)); const v=Y.encodeStateVector(client);client.getMap('board-layout').set('card',{x:1,y:2});const update=Y.encodeStateAsUpdate(client,v);
 await admitWriterSync({services:services as never,documentName:id,document:doc,syncType:messageYjsUpdate,payload:update,userId,expectedGeneration:1n});
 console.log('writer journal entries',journal.updateRecords(id).length,'live persisted callback',JSON.stringify(callbacks));
}finally{await connection.disconnect();await persistence.drainHocuspocusPersistence()}
