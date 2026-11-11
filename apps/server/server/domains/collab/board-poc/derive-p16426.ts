import { createAgentEditCodecFactory, yProsemirrorModel, getTopLevelXmlBlocks, getBlockItemId, blockItemIdKey } from '@meridian/agent-edit/integration';
import { mdxCodec } from '@meridian/markup';
import { extractStoredLinks } from '@meridian/markup/stored-links';
import { buildDocumentSchema, createCollabYDoc } from '@meridian/prosemirror-schema';
import * as Y from 'yjs';
import { createBlockDeriver, deriveDocument } from '../domain/document-derivations.js';

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);
const codec = createAgentEditCodecFactory(mdxCodec({schema}));
const id='00000000-0000-4000-8000-000000000001' as never;
const a='doc:00000000-0000-4000-8000-000000000011';
const b='doc:00000000-0000-4000-8000-000000000012';
const c='doc:00000000-0000-4000-8000-000000000013';
const folder='folder:00000000-0000-4000-8000-000000000014';
const ahead='ahead:00000000-0000-4000-8000-000000000015';
type Piece = string | { text:string; ref:string; href:string };
const link=(text:string,ref:string,href:string):Piece=>({text,ref,href});
const A=link('A',a,'./a.md'), B=link('B',b,'./b.md'), C=link('C',c,'./c.md');
const lines: [string,Piece[]][] = [
 ['heading',['Frame']], ['paragraph',[A,' sets up']], ['paragraph',[A,' knows ',B,' follows ',C]],
 ['paragraph',['Sticky']], ['paragraph',[link('Folder',folder,'./folder/')]],
 ['paragraph',[link('Future',ahead,'./future.md')]], ['paragraph',[A,' fears ',B]], ['paragraph',[A,' studies ',B]],
];
const doc=createCollabYDoc({gc:false});
for(const [kind,pieces] of lines){
 const el=new Y.XmlElement(kind); if(kind==='heading') el.setAttribute('level',1 as never);
 const text=new Y.XmlText(); el.insert(0,[text]); doc.getXmlFragment('prosemirror').push([el]);
 let pos=0; for(const piece of pieces){const s=typeof piece==='string'?piece:piece.text; text.insert(pos,s,typeof piece==='string'?{}:{link:{href:piece.href,ref:piece.ref}}); pos+=s.length;}
}
const state=Y.encodeStateAsUpdate(doc);
const cut={documentId:id,watermark:{generation:1n,admissionSequence:1n,locationVersion:1n,extractorVersion:5},state,holderUri:'manuscript://board.md'};
const deriver=createBlockDeriver({runtime:()=>({model,codec}),resolveFiletype:async()=> 'markdown'});
let certified:any;
const store={capture:async()=>cut,certify:async(_cut:any,out:any)=>{certified=out; return true},registerAheads:async()=>console.log('registered ahead')};
console.log('derive result',await deriveDocument({store:store as never,deriveBlocks:deriver},id));
console.log('certified blocks',JSON.stringify(certified.blocks.map((x:any)=>({id:x.id,text:x.text}))));
console.log('certified links',JSON.stringify(certified.links));
console.log('stored occurrences',JSON.stringify(extractStoredLinks(doc.getXmlFragment('prosemirror'))));
const board:any={cards:{},edges:[],notes:[],frames:[]};
for(const block of getTopLevelXmlBlocks(doc)){
 const blockId=blockItemIdKey(getBlockItemId(block)); let text=''; const links:{ref:string,start:number,end:number}[]=[];
 for(const child of block.toArray()) if(child instanceof Y.XmlText) for(const op of child.toDelta()){
  if(typeof op.insert!=='string')continue; const start=text.length; text+=op.insert; const ref=op.attributes?.link?.ref;
  if(typeof ref==='string'){links.push({ref,start,end:text.length}); board.cards[ref]=true;}
 }
 if(block.nodeName==='heading')board.frames.push({blockId,text});
 else if(!links.length)board.notes.push({blockId,text});
 else if(links.length===1){let before=text.slice(0,links[0].start).trim(),after=text.slice(links[0].end).trim(); if(before)board.edges.push({blockId,from:null,to:links[0].ref,label:before}); if(after)board.edges.push({blockId,from:links[0].ref,to:null,label:after});}
 else for(let i=0;i<links.length-1;i++) board.edges.push({blockId,from:links[i].ref,to:links[i+1].ref,label:text.slice(links[i].end,links[i+1].start).trim()});
}
console.log('board from same cut',JSON.stringify(board));
const prior={wordCount:certified.wordCount,hash:certified.documentHash.toString('hex'),links:certified.links};
doc.getMap('board-layout').set(a,{x:10,y:20});
const cut2={...cut,state:Y.encodeStateAsUpdate(doc),watermark:{...cut.watermark,admissionSequence:2n}};
const store2={...store,capture:async()=>cut2};
await deriveDocument({store:store2 as never,deriveBlocks:deriver},id);
console.log('layout-only derived comparison',JSON.stringify({before:prior,after:{wordCount:certified.wordCount,hash:certified.documentHash.toString('hex'),links:certified.links}}));
