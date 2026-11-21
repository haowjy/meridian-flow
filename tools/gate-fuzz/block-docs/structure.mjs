// Structure values and the common visibility rule. Keys are ordered as strings,
// with a block id as the deterministic tie-breaker.
export const FIELDS = ['parent', 'order', 'node', 'attrs'];
export function value(doc, name, key) {
  const base=doc.getMap(name), override=doc.getMap('d.'+name);
  const v=doc._draft ? override.get(key) : undefined;
  return v===undefined ? base.get(key) : v;
}
export const ids = doc => [...new Set([...doc.getMap('order').keys(),...(doc._draft?[...doc.getMap('d.order').keys()]:[])])];
export function attributes(doc,id) {
  const keys=new Set([...doc.getMap('attrs').keys(),...(doc._draft?[...doc.getMap('d.attrs').keys()]:[])]), out={};
  for(const k of keys) if(k.startsWith(id+'/')) {const v=value(doc,'attrs',k);if(v!==null&&v!==undefined)out[k.slice(id.length+1)]=v;}
  return out;
}
export function parents(doc) {
  const all=ids(doc), known=new Set(all), result=new Map(all.map(id=>[id,value(doc,'parent',id)]));
  for(const id of all) {let x=id,path=[],seen=new Map();while(typeof x==='string'&&known.has(x)) {if(seen.has(x)){const cycle=path.slice(seen.get(x));result.set(cycle.sort()[0],null);break;}seen.set(x,path.length);path.push(x);x=result.get(x);}}
  return result;
}
export function visible(doc) {
  const p=parents(doc),memo=new Map();
  function visit(id) {if(memo.has(id))return memo.get(id);if(value(doc,'order',id)==null||!p.has(id)||p.get(id)===undefined){memo.set(id,false);return false;}const par=p.get(id);memo.set(id,false);const result=par===null||(typeof par==='string'&&visit(par));memo.set(id,result);return result;}
  const shown=new Set(ids(doc).filter(visit));let changed=true;while(changed){changed=false;for(const id of [...shown]){const parent=p.get(id),type=value(doc,'node',id);const invalidParent=parent!==null&&!shown.has(parent);const empty=(type==='table'||type==='table_row')&&![...shown].some(k=>p.get(k)===id&&(type==='table'?value(doc,'node',k)==='table_row':['table_header','table_cell'].includes(value(doc,'node',k))));if(invalidParent||empty){shown.delete(id);changed=true;}}}return shown;
}
export function children(doc,parentId,shown=visible(doc)) {
  const p=parents(doc);return [...shown].filter(id=>p.get(id)===parentId).sort((a,b)=>{const x=value(doc,'order',a),y=value(doc,'order',b);return x<y?-1:x>y?1:a<b?-1:a>b?1:0;});
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function keyBetween(lower, upper, rng) {
  let prefix = '';
  for (let i=0;;i++) {
    const lo=lower && i<lower.length ? ALPHABET.indexOf(lower[i]) : 0;
    const hi=upper && i<upper.length ? ALPHABET.indexOf(upper[i]) : 61;
    if (lo<0 || hi<0 || lo>hi) throw new Error('invalid fractional key bounds');
    if (hi-lo>1) {
      const random = () => ALPHABET[Math.floor(rng()*62)];
      return prefix + ALPHABET[Math.floor((lo+hi)/2)] + random() + random() + 'V';
    }
    prefix += ALPHABET[lo];
    if (lo<hi) upper=null;
  }
}

// Keep the longest increasing subsequence; only the other siblings get new keys.
export function orderKeys(list, current, rng) {
  const n=list.length, len=Array(n).fill(0), prev=Array(n).fill(-1);
  let best=-1;
  for(let i=0;i<n;i++) {
    const k=current.get(list[i]); if (typeof k!=='string') continue;
    len[i]=1;
    for(let j=0;j<i;j++) if(len[j] && current.get(list[j])<k && len[j]+1>len[i]) {len[i]=len[j]+1;prev[i]=j;}
    if(best<0 || len[i]>len[best]) best=i;
  }
  const keep=new Set(); for(let i=best;i>=0;i=prev[i]) keep.add(i);
  const result=new Map(); let lower=null;
  for(let i=0;i<n;i++) {
    if(keep.has(i)) {lower=current.get(list[i]);result.set(list[i],lower);continue;}
    let upper=null; for(let j=i+1;j<n;j++) if(keep.has(j)){upper=current.get(list[j]);break;}
    lower=keyBetween(lower,upper,rng); result.set(list[i],lower);
  }
  return result;
}
export function sameOrderAsBase(doc,id) {
  const override=doc.getMap('d.order').get(id),base=doc.getMap('order').get(id);
  if(typeof override!=='string'||typeof base!=='string'||doc.getMap('parent').get(id)!==value(doc,'parent',id))return false;
  const compare=(a,b,x,y)=>a<b?-1:a>b?1:x<y?-1:x>y?1:0;
  for(const other of children(doc,value(doc,'parent',id)))if(other!==id){const key=value(doc,'order',other);if(compare(override,key,id,other)!==compare(base,key,id,other))return false;}
  return true;
}
