// Seeded scripts against the block-docs model. `--seed N` replays one script; with GATE_TRACE=1 it prints,
// after each step, every block where Live (L), the fork (F) and the Draft tab (T) differ, and the fork's overrides.
import {Gen, randomEdit, TOKEN} from '../gen.mjs';
import * as C from './codec.mjs';
import * as M from './model.mjs';
import {attributes, children, keyBetween, sameOrderAsBase, value, visible, ids} from './structure.mjs';

class Fail extends Error {constructor(cls,detail){super(`${cls}: ${detail}`);this.cls=cls;}}
const check=(ok,cls,detail)=>{if(!ok)throw new Fail(cls,typeof detail==='function'?detail():detail)};
const render=(d)=>JSON.stringify(C.read(d).toJSON());
const tokens=(d)=>C.read(d).textBetween(0,C.read(d).content.size,' ',' ').match(TOKEN)??[];
const comments=(d)=>{const out=new Set();for(const id of visible(d.structure))for(const c of M.carried(d,id))out.add(c);return out;};
const setPeer=(d,peer)=>{d.peer=peer;d.structure.setPeerId(peer);for(const x of d.texts.values())x.setPeerId(peer);};
const tokenBlocks=(d)=>{
  const out=new Map();for(const id of visible(d.structure))for(const tok of d.texts.get(id)?.getText('t').toString().match(TOKEN)??[])out.set(tok,id);return out;
};
const blockValues=(d)=>{
  const result=new Map(),s=d.structure;
  for(const id of visible(s))result.set(id,JSON.stringify([['parent','order','node'].map(k=>value(s,k,id)).concat([attributes(s,id)]),d.texts.get(id)?.getText('t').toDelta()??[]]));
  return result;
};
export function runScript(seed,{verbose=false}={}) {
  C.resetIds();const g=new Gen(seed), all=[], stats={edits:0,presses:0,pressUndos:0,resets:0,resetUndos:0,discards:0,discardUndos:0,restores:0,ctrlz:0,liveEdits:0,stale:0,lateDraft:0,unsyncedLive:0,boundarySameMarked:0,boundaryDisagree:0,boundarySampled:0,markerSplit:0,tokenSplit:0,resetCopyObserved:0,aiLazyForks:0,aiCreated:0,structureAfter:0,undoReapply:0,matchingChecks:0,kinds:{}}, outcomes=[],log=[];
  const row=(d,id)=>d&&visible(d.structure).has(id)?`${value(d.structure,'node',id)}<${value(d.structure,'parent',id)?.slice(0,4)??'-'}|${String(value(d.structure,'order',id)).slice(0,3)}>${JSON.stringify(attributes(d.structure,id))}[${d.texts.get(id)?.getText('t').toDelta().map(r=>r.attributes?`{${r.insert}:${Object.keys(r.attributes)}}`:r.insert).join('')??''}]`:'·';
  const trace=()=>{const all=new Set();for(const d of [live,fork,tab])if(d)for(const id of visible(d.structure))all.add(id);for(const id of [...all].sort()){const l=row(live,id),f=row(fork,id),t=row(tab,id);if(l!==f||f!==t)console.log(`     ${id.slice(0,4)} L ${l}\n          F ${f}${t!==f?`\n          T ${t}`:''}`);}};
  const overrides=()=>fork?['parent','order','node','attrs','comments'].flatMap(n=>[...fork.structure.getMap('d.'+n).entries()].map(([k,v])=>`${n}:${k.slice(0,4)}${k.includes('/')?k.slice(k.indexOf('/')):''}=${JSON.stringify(v)?.slice(0,12)}`)).join(' '):'';
  const note=(s)=>{log.push(s);if(verbose){console.log(s);if(process.env.GATE_TRACE){trace();console.log('     overrides:',overrides());}}};
  const make=(peer)=>{const d=C.newDocument(peer);all.push(d);return d};
  const forkOf=(d,peer,draft=d.draft)=>{const f=C.forkDocument(d,peer,draft);all.push(f);return f};
  let peer=100;const next=()=>String(++peer);
  const live=make('1');let tab,fork,liveTab;const deleted=new Set(),touched=new Set(),liveTokenBlock=new Map(),splitMoved=new Set(),resetRestored=new Map();
  const activeTurns=[];function fwdLive(){const missing=[...live.texts.keys()].filter(id=>!fork.texts.has(id));M.forward(live,fork);for(const t of activeTurns)for(const id of missing)if(!t.before.texts.has(id))t.before.texts.set(id,live.texts.get(id).frontiers());}
  function sync(a,b){M.forward(a,b);M.forward(b,a);}
  function syncLive(){sync(liveTab,live);if(fork)fwdLive();}
  function syncTab(){if(fork){M.forward(tab,fork);fwdLive();M.forward(fork,tab);}}
  function ensure(){if(fork)return;syncLive();fork=forkOf(live,'10',true);tab=forkOf(fork,next());note('fork created');}
  function userEdit(d,origin,opts={}) {
    const pm=C.read(d), e=randomEdit(g,pm,origin,{commentsHere:[...comments(d)],...opts});if(!e)return null;
    const old=blockValues(d),before=tokens(d),tb0=e.kind==='split'||e.kind==='join'?tokenBlocks(d):null;
    const b0=d.structure.frontiers();for(const [id,v] of e.comments??[]){const map=d.structure.getMap(d.draft?'d.comments':'comments');if(d.draft&&M.same(d.structure.getMap('comments').get(id),v))map.delete(id);else map.set(id,v);}
    let built=null;const result=e.build?C.edit(d,(tr,pm)=>{built=e.build(tr,pm);return built;},{rng:g.rng,message:opts.message}):{changed:[]};
    if(built?.docChanged)check(built.doc.eq(C.read(d)),'binding',`codec failed round trip for ${e.kind}: expected ${JSON.stringify(built.doc.toJSON())}; got ${JSON.stringify(C.read(d).toJSON())}`);
    d.structure.commit({message:opts.message});const b1=d.structure.frontiers();
    if(!M.same(b0,b1)){const r=result.changed.find(x=>x.id===null);if(r){r.before=b0;r.after=b1;}else result.changed.unshift({id:null,doc:d.structure,before:b0,after:b1});}
    const after=tokens(d),now=new Set(after),fresh=blockValues(d),modified=new Set([...new Set([...old.keys(),...fresh.keys()])].filter(id=>old.get(id)!==fresh.get(id)));matching(d,modified,new Set((e.comments??[]).map(([id])=>id)));
    for(const t of before)if(!now.has(t))deleted.add(t);
    if(d===liveTab){const bs=tokenBlocks(d);for(const t of after)if(!before.includes(t)&&t.startsWith('l'))liveTokenBlock.set(t,bs.get(t));}
    else {for(const id of new Set([...old.keys(),...fresh.keys()]))if(old.get(id)!==fresh.get(id))touched.add(id);if(e.comments){const changedComments=new Set(e.comments.map(([id])=>`comment_${id}`));for(const [id,td] of d.texts)if(td.getText('t').toDelta().some(p=>Object.keys(p.attributes??{}).some(k=>changedComments.has(k))))touched.add(id);}}
    if(tb0)for(const [t,id] of tokenBlocks(d))if(tb0.has(t)&&tb0.get(t)!==id)splitMoved.add(t);
    stats.kinds[e.kind]=(stats.kinds[e.kind]??0)+1;note(`  ${origin} ${e.kind}`);return {e,...result};
  }
  function structureAfter(candidates){const pending=new Set(M.changedBlocks(live,fork));const id=candidates.find(x=>!pending.has(x)&&visible(live.structure).has(x)&&value(live.structure,'node',x)==='paragraph');if(!id)return;const a=C.forkDocument(live,'900000000000000001',false),b=C.forkDocument(fork,'900000000000000002',true);try{const kinds=['level','align','move'];let kind=kinds[stats.structureAfter%3],key,want;const siblings=children(a.structure,value(a.structure,'parent',id));if(kind==='move'&&siblings.length<2)kind='align';if(kind==='move'){const rest=siblings.filter(x=>x!==id);const first=siblings.at(-1)===id;const lo=first?null:value(a.structure,'order',rest.at(-1)),hi=first?value(a.structure,'order',rest[0]):null;key=id;want=keyBetween(lo,hi,()=>.4);a.structure.getMap('order').set(key,want);}else{key=id+'/'+kind;const old=value(a.structure,'attrs',key);want=kind==='level'?(old===2?3:2):(old==='center'?'right':'center');a.structure.getMap('attrs').set(key,want);}a.structure.commit();M.forward(a,b);check(value(b.structure,kind==='move'?'order':'attrs',key)===want&&!M.changedBlocks(a,b).includes(id),'stale-override',`Live ${kind} did not reach ${id}`);stats.structureAfter++;stats['structure:'+kind]=(stats['structure:'+kind]??0)+1;}finally{C.freeDocument(a);C.freeDocument(b);}}
  function undoCheck(ids){const pending=M.changedBlocks(live,fork);for(const id of ids){check(pending.includes(id),'undo-pending',`block ${id} not pending after Undo`);for(const mode of ['apply','reset']){const a=C.forkDocument(live,'900000000000000003',false),b=C.forkDocument(fork,'900000000000000004',true);try{if(mode==='apply')M.applyBlocks(a,b,[id]);else M.resetBlocks(a,b,[id]);check(!M.changedBlocks(a,b).includes(id),'undo-'+mode,`${mode} after Undo left ${id} pending`);}finally{C.freeDocument(a);C.freeDocument(b);}}stats.undoReapply++;}}
  function matching(d,blocks,editedComments){if(!d.draft)return;for(const name of ['parent','node','attrs','comments'])for(const key of d.structure.getMap('d.'+name).keys()){const relevant=name==='comments'?(editedComments.has(key)||[...blocks].some(id=>M.carried(d,id).has(key))):blocks.has(name==='attrs'?key.split('/')[0]:key);if(!relevant)continue;const base=d.structure.getMap(name).get(key),over=d.structure.getMap('d.'+name).get(key);check(!M.same(name==='attrs'?(base??null):base,over),'matching-override',`${name}/${key} matches Live`);}for(const id of d.structure.getMap('d.order').keys())if(blocks.has(id))check(!sameOrderAsBase(d.structure,id),'matching-override',`order/${id} matches Live relative position`);stats.matchingChecks++;stats.matchingBlocks=(stats.matchingBlocks??0)+blocks.size;}

  function liveEdit(structure=g.chance(.3)){userEdit(liveTab,'l',{structure});stats.liveEdits++;if(g.chance(.8))syncLive();}
  function writerEdit(){ensure();const before=render(tab),r=userEdit(tab,'f');stats.edits++;
    if(r?.changed.length&&g.chance(.18)){for(const rec of r.changed)M.invertCommit(rec.doc,rec.before,rec.after,next(),'ctrlz');stats.ctrlz++;note('  CTRLZ');check(render(tab)===before,'ctrlz','tab not back to before edit');}
    if(g.chance(.6))syncTab();}
  function aiTurn(n){ensure();syncTab();const before=M.frontiers(fork),shadow=forkOf(fork,next()),work=C.lazyTurn(fork,next());
    try{for(let i=0;i<n;i++){userEdit(work,'a',{message:'turn'});stats.edits++;}stats.aiLazyForks+=work.forkTimes.size;stats.aiCreated+=work.ownedTexts.size-work.forkTimes.size;M.forward(work,fork);}finally{C.freeDocument(work);}setPeer(fork,next());M.forward(fork,tab);const turn={before,shadow};activeTurns.push(turn);return turn;}
  function restore(turn){syncTab();M.forward(live,fork);M.forward(live,turn.shadow);const expected=render(turn.shadow),oldBlocks=blockValues(fork);M.restoreBeforeOnLive(live,fork,turn.before);M.forward(fork,tab);stats.restores++;note('  RESTORE');const now=blockValues(fork),changed=[...new Set([...oldBlocks.keys(),...now.keys()])].filter(id=>oldBlocks.get(id)!==now.get(id));structureAfter(changed);check(render(fork)===expected,'restore',`fork differs from pre-turn state on Live: expected ${expected}, got ${render(fork)}`);}
  function markerAttrs(d,id,token){const delta=d.texts.get(id).getText('t').toDelta(),text=delta.map(p=>p.insert).join(''),start=text.indexOf(token);if(start<0)return null;let offset=0;const attrs=[];for(const span of delta){for(let i=0;i<span.insert.length;i++,offset++)if(offset>=start&&offset<start+token.length)attrs.push(span.attributes??{});}return attrs;}
  function typeIn(d,id,token) {let position=null;C.read(d).descendants((node,pos)=>{if(node.isTextblock && node.attrs.id===id)position=pos+node.nodeSize-1;});if(position===null)return false;C.edit(d,tr=>tr.insertText(' '+token+' ',position),{rng:g.rng});return true;}
  function press(){syncLive();syncTab();const pending=M.changedBlocks(live,fork);if(!pending.length)return null;
    let chosen=pending.filter(()=>g.chance(.5));if(!chosen.length)chosen=[g.pick(pending)];const before=render(live),fbefore=render(fork),oldBlocks=blockValues(live);
    const leaf=chosen.find(id=>fork.texts.has(id)&&live.texts.has(id)&&visible(live.structure).has(id)&&visible(fork.structure).has(id));
    const late=leaf?forkOf(fork,next()):null, draftToken=`x${seed}0${stats.presses}k`, liveToken=`y${seed}0${stats.presses}k`;
    const lateTyped=late&&typeIn(late,leaf,draftToken);
    const liveTyped=leaf&&typeIn(liveTab,leaf,liveToken);
    const r=M.applyBlocks(live,fork,chosen);stats.presses++;note(`  PRESS ${chosen.map(x=>x.slice(0,4))} -> ${r.chosen.map(x=>x.slice(0,4))}`);check(render(fork)===fbefore,'apply','fork changed during Apply');
    for(const id of chosen)check(!M.changedBlocks(live,fork).includes(id),'apply',`block ${id} still pending after Apply: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    structureAfter(r.chosen);const newBlocks=blockValues(live);for(const [id,b] of oldBlocks)if(!r.chosen.includes(id)&&newBlocks.has(id))check(b===newBlocks.get(id),'apply',`unchosen block ${id} changed`);
    check(M.applyBlocks(live,fork,chosen).changed.length===0,'apply','applying again was not a no-op');
    if(liveTyped){syncLive();stats.unsyncedLive++;const left=markerAttrs(live,leaf,liveToken),right=markerAttrs(fork,leaf,liveToken);if(left&&right){stats.boundarySampled++;if(!M.same(left,right))stats.boundaryDisagree++;else if(left.some(a=>Object.keys(a).some(k=>k.startsWith('comment_'))))stats.boundarySameMarked++;}const contains=(d)=>{const text=d.texts.get(leaf).getText('t').toString();let i=0;for(const ch of text)if(ch===liveToken[i])i++;return i===liveToken.length;};if(!left||!right)stats.markerSplit++;check(contains(live)&&contains(fork),'unsynced-live',`unsynced ${liveToken}: live ${JSON.stringify(tokenBlocks(live).get(liveToken))} fork ${JSON.stringify(tokenBlocks(fork).get(liveToken))} block live ${blockValues(live).get(leaf)} fork ${blockValues(fork).get(leaf)}`);}
    if(lateTyped){M.forward(late,fork);stats.lateDraft++;check(fork.texts.get(leaf).getText('t').toString().includes(draftToken)&&M.changedBlocks(live,fork).includes(leaf),'late-draft','typing after Apply not pending');touched.add(leaf);M.forward(fork,tab);}
    return {r,before,fbefore,chosen,liveTyped};}
  function undoPress(p,liveSince){syncTab();M.forward(live,fork);const fb=render(fork);note('  undo-press: start');
    for(const rec of p.r.changed){const bytes=M.invertCommit(rec.doc,rec.before,rec.after,next(),'undo press');note(`  undo-press: inverted ${rec.id?.slice(0,4)??'structure'}`);if(rec.id!==null){M.returnToPending(fork.texts.get(rec.id),bytes);note(`  undo-press: returned ${rec.id.slice(0,4)}`);}}for(const rec of p.r.forkChanged??[]){M.invertCommit(rec.doc,rec.before,rec.after,next(),'undo override');note('  undo-press: inverted fork override');}M.forward(live,fork);note('  undo-press: forwarded');
    M.forward(live,liveTab);M.forward(fork,tab);stats.pressUndos++;note('  UNDO PRESS');undoCheck(p.r.chosen);
    check(render(fork)===fb,'press-undo','fork changed by press Undo');if(!liveSince)check(render(live)===p.before,'press-undo','Live not back to before Apply');}
  function reset(all=false){syncTab();const p=M.changedBlocks(live,fork);if(!p.length)return null;const chosen=all?'all':[g.pick(p)],before=render(fork),pendingBefore=new Set(touched),oldBlocks=blockValues(fork),oldTextTokens=new Map([...fork.texts].map(([id,d])=>[id,new Set(d.getText('t').toString().match(TOKEN)??[])]));
    const r=M.resetBlocks(live,fork,chosen,all?'discard':'reset');M.forward(fork,tab);note(`  ${all?'DISCARD':'RESET '+chosen.map(x=>x.slice(0,4))} -> ${r.chosen.map(x=>x.slice(0,4))}`);if(all)stats.discards++;else stats.resets++;
    if(all)check(render(fork)===render(live),'discard','fork differs from Live');else for(const id of chosen)check(!M.changedBlocks(live,fork).includes(id),'reset',`block ${id} still pending: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    const restoredDocs=new Set(r.changed.filter(x=>x.id!==null).map(x=>x.id));for(const id of restoredDocs){const before=oldTextTokens.get(id)??new Set(),after=fork.texts.get(id)?.getText('t').toString().match(TOKEN)??[],onLive=new Set(live.texts.get(id)?.getText('t').toString().match(TOKEN)??[]);for(const token of after)if(!before.has(token)&&onLive.has(token))resetRestored.set(token,id);}
    structureAfter(r.chosen);const newBlocks=blockValues(fork);for(const [id,b] of oldBlocks)if(!r.chosen.includes(id)&&newBlocks.has(id))check(b===newBlocks.get(id),'reset',`unchosen block ${id} changed`);
    for(const id of r.chosen)touched.delete(id);return {r,before,pendingBefore};}
  function undoReset(rec,kind,checkBefore=true){syncTab();for(const x of rec.r.changed)if(x.id!==null){for(const [token,id] of resetRestored)if(id===x.id)resetRestored.delete(token);}for(const x of rec.r.changed)M.invertCommit(x.doc,x.before,x.after,next(),`undo ${kind}`);M.forward(fork,tab);
    note(`  UNDO ${kind}`);for(const id of rec.pendingBefore)touched.add(id);if(kind==='reset')stats.resetUndos++;else stats.discardUndos++;if(checkBefore)check(render(fork)===rec.before,`${kind}-undo`,'fork not back to before reset');}
  try {
    C.write(live,C.withIds(g.initialDoc(),g.rng),{rng:g.rng,message:'init'});
    if(g.chance(.6)){const e=randomEdit(g,C.read(live),'s',{structure:false});if(e?.kind==='comment'||e?.kind==='comment2'){for(const [id,b] of e.comments)live.structure.getMap('comments').set(id,b);C.edit(live,e.build,{rng:g.rng});live.structure.commit();}}
    liveTab=forkOf(live,'2');
    const count=1+g.int(8);let made=0,turn=null;
    while(made<count){if(g.chance(.25))liveEdit();if(g.chance(.6)){writerEdit();made++;}else{const n=Math.min(count-made,1+g.int(2)),t=aiTurn(n);made+=n;if(!turn&&g.chance(.35))turn=t;}}
    if(g.chance(.4))liveEdit();if(turn&&g.chance(.6))restore(turn);
    for(let a=0,n=2+g.int(3);a<n;a++){
      const k=g.r();if(k<.45){const p=press();if(p&&g.chance(.55)){for(let i=0,n=g.int(3);i<n;i++)userEdit(tab,'f');const since=g.chance(.3);if(since)liveEdit(false);syncLive();undoPress(p,since||p.liveTyped);}}
      else if(k<.7){const r=reset();if(r&&g.chance(.5))undoReset(r,'reset');}
      else if(k<.85){syncTab();syncLive();if(!M.changedBlocks(live,fork).length)continue;
        const discarded=new Set(tokens(fork).filter(t=>(t[0]==='f'||t[0]==='a')&&!tokens(live).includes(t)));
        const stale=g.chance(.5)?forkOf(tab,next()):null, r=reset(true);let typed=[];
        if(stale)for(let i=0,n=1+g.int(3);i<n;i++){const b=new Set(tokens(stale));userEdit(stale,'f',{structure:false});typed.push(...tokens(stale).filter(t=>!b.has(t)));}
        const order=g.int(3);let undone=false;if(order===0){undoReset(r,'discard');undone=true;}else if(order===1)aiTurn(1);
        if(stale){M.forward(stale,fork);M.forward(live,fork);M.forward(fork,tab);const now=new Set(tokens(fork)),back=[...discarded].filter(t=>now.has(t)&&!undone);outcomes.push({route:'B:same-room',back:back.length,typed:typed.length,kept:typed.filter(t=>now.has(t)).length});stats.stale++;check(!back.length,'stale-discarded-back',`discarded ${back.join(' ')}`);}
        if(order===1&&g.chance(.5))undoReset(r,'discard',false);
      } else {liveEdit();if(g.chance(.5))writerEdit();}
    }
    syncLive();syncTab();
    const fTokens=tokenBlocks(fork),lTokens=tokenBlocks(live);const copied=new Set();for(const [token,id] of resetRestored){const f=new Set(fork.texts.get(id)?.getText('t').toString().match(TOKEN)??[]),l=new Set(live.texts.get(id)?.getText('t').toString().match(TOKEN)??[]);if(f.has(token)&&!l.has(token))copied.add(id);}if(copied.size)stats.resetCopyObserved++;
    for(const id of M.changedBlocks(live,fork))check(touched.has(id),copied.has(id)?'reset-character-copy':'spurious-pending',`untouched block ${id} pending: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    for(const [tok,id] of liveTokenBlock)if(!deleted.has(tok)&&lTokens.has(tok)&&visible(fork.structure).has(id)){if(fTokens.get(tok)!==id&&!splitMoved.has(tok)){const text=fork.texts.get(id)?.getText('t').toString()??'';let at=0;for(const c of text)if(c===tok[at])at++;if(at===tok.length)stats.tokenSplit++;else check(false,'live-typing-lost',`Live token ${tok} characters missing from fork; id ${id}; live ${blockValues(live).get(id)}; fork ${blockValues(fork).get(id)}`);}}
    M.applyBlocks(live,fork,'all');syncTab();syncLive();check(render(live)===render(fork),'converge','Live and fork differ after Apply-all');
    check(!M.changedBlocks(live,fork).length,'pending','pending after Apply-all');check(render(tab)===render(fork),'tab','Draft tab differs');check(render(liveTab)===render(live),'live-tab','Live tab differs');
    M.prune(live);live.structure.commit();const bodies=live.structure.getMap('comments');for(const k of comments(live)){check(bodies.get(k)!==undefined,'bodies',`missing ${k}, Live ${JSON.stringify(C.read(live).toJSON())}, fork bodies ${JSON.stringify(fork.structure.getMap('comments').toJSON())}`);check(M.same(bodies.get(k),value(fork.structure,'comments',k)),'bodies',`body ${k} differs`);}
    const final=tokens(live);check(final.every((t,i)=>final.indexOf(t)===i||splitMoved.has(t)),'duplicate-text',`duplicate tokens ${final.filter((t,i)=>final.indexOf(t)!==i&&!splitMoved.has(t)).join(',')}`);
    const allIds=[];C.read(live).descendants(n=>{if(n.type.spec.attrs?.id!==undefined)allIds.push(n.attrs.id)});check(!allIds.includes(null)&&new Set(allIds).size===allIds.length,'block-ids','missing or duplicate block ids');
    C.read(live).check();return {ok:true,stats,outcomes,log};
  } catch(e){return {ok:false,cls:e.cls??'throw',msg:e.stack??String(e),stats,outcomes,log};}
  finally {for(const d of all)C.freeDocument(d);}
}
if(import.meta.url===`file://${process.argv[1]}`){
  const arg=(name,def)=>{const i=process.argv.indexOf(`--${name}`);return i<0?def:process.argv[i+1]};
  const seed=arg('seed',null);if(seed!==null){const r=runScript(Number(seed),{verbose:true});console.log(r.ok?'OK':`FAIL ${r.cls}\n${r.msg}`);process.exit(r.ok?0:1);}
  const start=Number(arg('start',0)),n=Number(arg('n',100)),fails={},firstSeeds={},totals={},routes={};let ok=0,peak=0;const begin=Date.now();
  for(let s=start;s<start+n;s++){const r=runScript(s);await new Promise(resolve=>setImmediate(resolve));peak=Math.max(peak,process.memoryUsage().rss);
    for(const [k,v] of Object.entries(r.stats))if(typeof v==='number')totals[k]=(totals[k]??0)+v;
    for(const o of r.outcomes){const x=routes[o.route]??={n:0,back:0,withBack:0,typed:0,kept:0};x.n++;x.back+=o.back;x.withBack+=o.back?1:0;x.typed+=o.typed;x.kept+=o.kept;}
    if(r.ok)ok++;else{fails[r.cls]=(fails[r.cls]??0)+1;(firstSeeds[r.cls]??=[]);if(firstSeeds[r.cls].length<5)firstSeeds[r.cls].push(s);if(fails[r.cls]===1)console.log(`seed ${s} FAIL ${r.msg.split('\n')[0]}`);}}
  console.log(`SUMMARY ${JSON.stringify({start,n,ok,fails,firstSeeds,totals,routes,ms:Date.now()-begin,peakRssMB:Math.round(peak/2**20)})}`);
}
