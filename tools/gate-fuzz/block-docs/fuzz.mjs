// Seeded scripts against the block-docs model. This is under construction.
import {Gen, randomEdit, TOKEN} from '../gen.mjs';
import * as C from './codec.mjs';
import * as M from './model.mjs';
import {visible, ids} from './structure.mjs';

class Fail extends Error {constructor(cls,detail){super(`${cls}: ${detail}`);this.cls=cls;}}
const check=(ok,cls,detail)=>{if(!ok)throw new Fail(cls,typeof detail==='function'?detail():detail)};
const render=(d)=>JSON.stringify(C.read(d).toJSON());
const tokens=(d)=>C.read(d).textBetween(0,C.read(d).content.size,' ',' ').match(TOKEN)??[];
const comments=(d)=>{
  const out=new Set();for(const id of visible(d.structure))for(const p of d.texts.get(id)?.getText('t').toDelta()??[])
    for(const k of Object.keys(p.attributes??{}))if(k.startsWith('comment_'))out.add(k.slice(8));return out;
};
const setPeer=(d,peer)=>{d.peer=peer;d.structure.setPeerId(peer);for(const x of d.texts.values())x.setPeerId(peer);};
const tokenBlocks=(d)=>{
  const out=new Map();for(const id of visible(d.structure))for(const tok of d.texts.get(id)?.getText('t').toString().match(TOKEN)??[])out.set(tok,id);return out;
};
const blockValues=(d)=>{
  const result=new Map(),s=d.structure;
  for(const id of visible(s))result.set(id,JSON.stringify([['parent','order','node','attrs'].map(k=>s.getMap(k).get(id)),d.texts.get(id)?.getText('t').toDelta()??[]]));
  return result;
};
export function runScript(seed,{verbose=false}={}) {
  C.resetIds();const g=new Gen(seed), all=[], stats={edits:0,presses:0,pressUndos:0,resets:0,resetUndos:0,discards:0,discardUndos:0,restores:0,ctrlz:0,liveEdits:0,stale:0,lateDraft:0,unsyncedLive:0,boundarySameMarked:0,boundaryDisagree:0,kinds:{}}, outcomes=[],log=[];
  const note=(s)=>{log.push(s);if(verbose)console.log(s)};
  const make=(peer)=>{const d=C.newDocument(peer);all.push(d);return d};
  const forkOf=(d,peer)=>{const f=C.forkDocument(d,peer);all.push(f);return f};
  let peer=100;const next=()=>String(++peer);
  const live=make('1');let tab,fork,liveTab;const deleted=new Set(),touched=new Set(),liveTokenBlock=new Map(),splitMoved=new Set();
  function sync(a,b){M.forward(a,b);M.forward(b,a);}
  function syncLive(){sync(liveTab,live);if(fork)M.forward(live,fork);}
  function syncTab(){if(fork){M.forward(tab,fork);M.forward(live,fork);M.forward(fork,tab);}}
  function ensure(){if(fork)return;syncLive();fork=forkOf(live,'10');tab=forkOf(fork,next());note('fork created');}
  function userEdit(d,origin,opts={}) {
    const pm=C.read(d), e=randomEdit(g,pm,origin,{commentsHere:[...comments(d)],...opts});if(!e)return null;
    const old=blockValues(d),before=tokens(d),tb0=e.kind==='split'||e.kind==='join'?tokenBlocks(d):null;
    const b0=d.structure.frontiers();for(const [id,value] of e.comments??[])d.structure.getMap('comments').set(id,value);
    let built=null;const result=e.build?C.edit(d,(tr,pm)=>{built=e.build(tr,pm);return built;},{rng:g.rng,message:opts.message}):{changed:[]};
    if(built?.docChanged)check(built.doc.eq(C.read(d)),'binding',`codec failed round trip for ${e.kind}: expected ${JSON.stringify(built.doc.toJSON())}; got ${JSON.stringify(C.read(d).toJSON())}`);
    d.structure.commit({message:opts.message});const b1=d.structure.frontiers();
    if(!M.same(b0,b1)){const r=result.changed.find(x=>x.id===null);if(r){r.before=b0;r.after=b1;}else result.changed.unshift({id:null,doc:d.structure,before:b0,after:b1});}
    const after=tokens(d),now=new Set(after),fresh=blockValues(d);
    for(const t of before)if(!now.has(t))deleted.add(t);
    if(d===liveTab){const bs=tokenBlocks(d);for(const t of after)if(!before.includes(t)&&t.startsWith('l'))liveTokenBlock.set(t,bs.get(t));}
    else {for(const id of new Set([...old.keys(),...fresh.keys()]))if(old.get(id)!==fresh.get(id))touched.add(id);if(e.comments){const changedComments=new Set(e.comments.map(([id])=>`comment_${id}`));for(const [id,td] of d.texts)if(td.getText('t').toDelta().some(p=>Object.keys(p.attributes??{}).some(k=>changedComments.has(k))))touched.add(id);}}
    if(tb0)for(const [t,id] of tokenBlocks(d))if(tb0.has(t)&&tb0.get(t)!==id)splitMoved.add(t);
    stats.kinds[e.kind]=(stats.kinds[e.kind]??0)+1;note(`  ${origin} ${e.kind}`);return {e,...result};
  }
  function liveEdit(structure=g.chance(.3)){userEdit(liveTab,'l',{structure});stats.liveEdits++;if(g.chance(.8))syncLive();}
  function writerEdit(){ensure();const before=render(tab),r=userEdit(tab,'f');stats.edits++;
    if(r?.changed.length&&g.chance(.18)){for(const rec of r.changed)M.invertCommit(rec.doc,rec.before,rec.after,next(),'ctrlz');stats.ctrlz++;check(render(tab)===before,'ctrlz','tab not back to before edit');}
    if(g.chance(.6))syncTab();}
  function aiTurn(n){ensure();syncTab();setPeer(fork,next());const before=M.frontiers(fork),shadow=forkOf(fork,next());
    for(let i=0;i<n;i++){userEdit(fork,'a',{message:'turn'});stats.edits++;}setPeer(fork,next());M.forward(fork,tab);return {before,shadow};}
  function restore(turn){syncTab();M.forward(live,fork);M.forward(live,turn.shadow);const expected=render(turn.shadow);M.restoreBeforeOnLive(live,fork,turn.before);M.forward(fork,tab);stats.restores++;check(render(fork)===expected,'restore',`fork differs from pre-turn state on Live: expected ${expected}, got ${render(fork)}`);}
  function markerAttrs(d,id,token){const delta=d.texts.get(id).getText('t').toDelta(),text=delta.map(p=>p.insert).join(''),start=text.indexOf(token);if(start<0)return null;let offset=0;const attrs=[];for(const span of delta){for(let i=0;i<span.insert.length;i++,offset++)if(offset>=start&&offset<start+token.length)attrs.push(span.attributes??{});}return attrs;}
  function typeIn(d,id,token) {let position=null;C.read(d).descendants((node,pos)=>{if(node.isTextblock && node.attrs.id===id)position=pos+node.nodeSize-1;});if(position===null)return false;C.edit(d,tr=>tr.insertText(' '+token+' ',position),{rng:g.rng});return true;}
  function press(){syncLive();syncTab();const pending=M.changedBlocks(live,fork);if(!pending.length)return null;
    let chosen=pending.filter(()=>g.chance(.5));if(!chosen.length)chosen=[g.pick(pending)];const before=render(live),fbefore=render(fork),oldBlocks=blockValues(live);
    const leaf=chosen.find(id=>fork.texts.has(id)&&live.texts.has(id)&&visible(live.structure).has(id)&&visible(fork.structure).has(id));
    const late=leaf?forkOf(fork,next()):null, draftToken=`x${seed}0${stats.presses}k`, liveToken=`y${seed}0${stats.presses}k`;
    const lateTyped=late&&typeIn(late,leaf,draftToken);
    const liveTyped=leaf&&typeIn(liveTab,leaf,liveToken);
    const r=M.applyBlocks(live,fork,chosen);stats.presses++;check(render(fork)===fbefore,'apply','fork changed during Apply');
    for(const id of chosen)check(!M.changedBlocks(live,fork).includes(id),'apply',`block ${id} still pending after Apply: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    const newBlocks=blockValues(live);for(const [id,b] of oldBlocks)if(!chosen.includes(id)&&newBlocks.has(id))check(b===newBlocks.get(id),'apply',`unchosen block ${id} changed`);
    check(M.applyBlocks(live,fork,chosen).changed.length===0,'apply','applying again was not a no-op');
    if(lateTyped){M.forward(late,fork);stats.lateDraft++;check(fork.texts.get(leaf).getText('t').toString().includes(draftToken)&&M.changedBlocks(live,fork).includes(leaf),'late-draft','typing after Apply not pending');touched.add(leaf);M.forward(fork,tab);}
    if(liveTyped){syncLive();stats.unsyncedLive++;const left=markerAttrs(live,leaf,liveToken),right=markerAttrs(fork,leaf,liveToken);if(!M.same(left,right))stats.boundaryDisagree++;else if(left?.some(a=>Object.keys(a).some(k=>k.startsWith('comment_'))))stats.boundarySameMarked++;check(live.texts.get(leaf).getText('t').toString().includes(liveToken)&&fork.texts.get(leaf).getText('t').toString().includes(liveToken),'unsynced-live',`unsynced ${liveToken}: live ${JSON.stringify(tokenBlocks(live).get(liveToken))} fork ${JSON.stringify(tokenBlocks(fork).get(liveToken))} block live ${blockValues(live).get(leaf)} fork ${blockValues(fork).get(leaf)}`);}
    return {r,before,fbefore,chosen,liveTyped};}
  function undoPress(p,liveSince){syncTab();M.forward(live,fork);const fb=render(fork);
    for(const rec of p.r.changed){const bytes=M.invertCommit(rec.doc,rec.before,rec.after,next(),'undo press');const dest=rec.id===null?fork.structure:fork.texts.get(rec.id);M.returnToPending(dest,bytes);}
    M.forward(live,liveTab);M.forward(fork,tab);stats.pressUndos++;
    check(render(fork)===fb,'press-undo','fork changed by press Undo');if(!liveSince)check(render(live)===p.before,'press-undo','Live not back to before Apply');}
  function reset(all=false){syncTab();const p=M.changedBlocks(live,fork);if(!p.length)return null;const chosen=all?'all':[g.pick(p)],before=render(fork),pendingBefore=new Set(touched),oldBlocks=blockValues(fork);
    const r=M.resetBlocks(live,fork,chosen,all?'discard':'reset');M.forward(fork,tab);if(all)stats.discards++;else stats.resets++;
    if(all)check(render(fork)===render(live),'discard','fork differs from Live');else for(const id of chosen)check(!M.changedBlocks(live,fork).includes(id),'reset',`block ${id} still pending: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    const newBlocks=blockValues(fork);for(const [id,b] of oldBlocks)if(!r.chosen.includes(id)&&newBlocks.has(id))check(b===newBlocks.get(id),'reset',`unchosen block ${id} changed`);
    for(const id of r.chosen)touched.delete(id);return {r,before,pendingBefore};}
  function undoReset(rec,kind,checkBefore=true){syncTab();for(const x of rec.r.changed)M.invertCommit(x.doc,x.before,x.after,next(),`undo ${kind}`);M.forward(fork,tab);
    for(const id of rec.pendingBefore)touched.add(id);if(kind==='reset')stats.resetUndos++;else stats.discardUndos++;if(checkBefore)check(render(fork)===rec.before,`${kind}-undo`,'fork not back to before reset');}
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
    for(const id of M.changedBlocks(live,fork))check(touched.has(id),'spurious-pending',`untouched block ${id} pending: live ${blockValues(live).get(id)} fork ${blockValues(fork).get(id)}`);
    const fTokens=tokenBlocks(fork),lTokens=tokenBlocks(live);for(const [tok,id] of liveTokenBlock)if(!deleted.has(tok)&&lTokens.has(tok)&&visible(fork.structure).has(id))check(fTokens.get(tok)===id||splitMoved.has(tok),'live-typing-lost',`Live token ${tok} missing from fork; id ${id}; live ${blockValues(live).get(id)}; fork ${blockValues(fork).get(id)}`);
    M.applyBlocks(live,fork,'all');syncTab();syncLive();check(render(live)===render(fork),'converge','Live and fork differ after Apply-all');
    check(!M.changedBlocks(live,fork).length,'pending','pending after Apply-all');check(render(tab)===render(fork),'tab','Draft tab differs');check(render(liveTab)===render(live),'live-tab','Live tab differs');
    M.prune(live);live.structure.commit();const bodies=live.structure.getMap('comments');for(const k of comments(live)){check(bodies.get(k)!==undefined,'bodies',`missing ${k}, Live ${JSON.stringify(C.read(live).toJSON())}, fork bodies ${JSON.stringify(fork.structure.getMap('comments').toJSON())}`);check(M.same(bodies.get(k),fork.structure.getMap('comments').get(k)),'bodies',`body ${k} differs`);}for(const k of bodies.keys())check(comments(live).has(k),'bodies',`orphan ${k}, carried ${JSON.stringify([...comments(live)])}`);
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
