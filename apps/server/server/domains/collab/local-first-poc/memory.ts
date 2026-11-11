import { mdxCodec } from '@meridian/markup';
import { buildDocumentSchema, createCollabYDoc } from '@meridian/prosemirror-schema';
import { toDocHandle, yProsemirrorModel } from '@meridian/agent-edit/integration';
import * as Y from 'yjs';
const schema=buildDocumentSchema(), model=yProsemirrorModel(schema), codec=mdxCodec({schema});
const text=Array.from({length:100},(_,i)=>`Paragraph ${i}: `+Array.from({length:50},(_,j)=>`word${i}_${j}`).join(' ')+'.').join('\n\n')+'\n';
const seed=createCollabYDoc({gc:false});model.insertBlocks(toDocHandle(seed),null,codec.parse(text));const bytes=Y.encodeStateAsUpdate(seed);seed.destroy();
const docs:Y.Doc[]=[];function report(n:number){global.gc?.();console.log(JSON.stringify({n,rssMiB:+(process.memoryUsage().rss/1048576).toFixed(1),heapMiB:+(process.memoryUsage().heapUsed/1048576).toFixed(1),bytesPerStoredDocument:bytes.length,wordCount:5100}));}
report(0);for(let i=1;i<=1000;i++){const d=createCollabYDoc({gc:false});Y.applyUpdate(d,bytes);docs.push(d);if([100,300,1000].includes(i))report(i);}console.log('retained',docs.length);
