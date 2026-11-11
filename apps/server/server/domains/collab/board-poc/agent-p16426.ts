import { createWriteToolHarness, blockTexts } from '@meridian/agent-edit/test-support';
import { getTopLevelXmlBlocks,getBlockItemId,blockItemIdKey } from '@meridian/agent-edit/integration';
const cases=[
 {name:'one line',cmd:{command:'replace',in:2,content:'Revised sticky.'}},
 {name:'range including line',cmd:{command:'replace',in:[1,2],content:'Revised beginning.\n\nRevised sticky.'}},
 {name:'whole document',cmd:{command:'replace',in:[1,3],content:'All new.\n\nDifferent.\n\nFinal.'}},
];
for(const c of cases){
 const ctx=createWriteToolHarness({'board.md':'First line.\n\nSticky note.\n\nLast line.'});
 const d=ctx.liveDoc('board.md'); d.getMap('board-layout').set('note',{x:1,y:2});
 const ids=()=>getTopLevelXmlBlocks(d).map(b=>blockItemIdKey(getBlockItemId(b)));
 const before=ids(); const context={sessionId:'s',threadId:'t',turnId:'turn',responseIdentity:{providerResponseId:'reply',editScopeId:'reply'}};
 const read=await ctx.core.read({file:'board.md'},context);
 const response=await ctx.core.write({...c.cmd,file:'board.md'} as never,context);
 const saved=await ctx.core.commitResponse('reply',{recordingFrontier:async()=>read.frontier??null});
 console.log(JSON.stringify({case:c.name,before,after:ids(),text:blockTexts(d),layout:d.getMap('board-layout').toJSON(),response,saved}));
}
