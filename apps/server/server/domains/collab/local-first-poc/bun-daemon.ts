import {watch, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {subject} from './bun-proof';
import * as Y from 'yjs';

const dir=process.argv[2];
const db=new Database(join(dir,'state.sqlite'));
db.run('create table if not exists docs (path text primary key, hash text, state blob)');
const own=new Map<string,string>(); let queue=Promise.resolve();
function hash(s:string){return new Bun.CryptoHasher('sha256').update(s).digest('hex')}
watch(dir,{recursive:true},(_event,name)=>{
 console.log(JSON.stringify({event:'raw',kind:_event,name,time:Date.now()}));
 if (!name?.endsWith('.md')) return;
 queue=queue.then(async()=>{
  const path=join(dir,name.toString()); let text:string;try{text=readFileSync(path,'utf8')}catch{return}
  const h=hash(text); if(own.get(path)===h){console.log(JSON.stringify({event:'own',name}));return}
  const old=db.query('select hash, state from docs where path=?').get(path) as any;
  if(old?.hash===h){console.log(JSON.stringify({event:'unchanged',name}));return}
  const s=subject(old?.state && Buffer.from(old.state).toString('base64'));
  await s.write(text,'writer'); const normalized=await s.serialize(); const nh=hash(normalized);
  db.run('insert or replace into docs values(?,?,?)',[path,nh,Y.encodeStateAsUpdate(s.doc)]);
  console.log(JSON.stringify({event:'commit',name,time:Date.now(),text:normalized}));
  if(normalized!==text){own.set(path,nh);writeFileSync(path,normalized)}
  s.doc.destroy();
 }).catch(console.error);
});
console.log(JSON.stringify({event:'ready',time:Date.now()}));
