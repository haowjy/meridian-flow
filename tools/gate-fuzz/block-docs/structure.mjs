// Structure values and the common visibility rule. Keys are ordered as strings,
// with a block id as the deterministic tie-breaker.
export const FIELDS = ['parent', 'order', 'node', 'attrs'];
export const ids = (doc) => [...doc.getMap('order').keys()];

export function visible(doc) {
  const parent = doc.getMap('parent');
  const order = doc.getMap('order');
  const memo = new Map();
  function visit(id, path) {
    if (memo.has(id)) return memo.get(id);
    if (path.has(id) || order.get(id) == null || parent.get(id) === undefined) return false;
    const p = parent.get(id);
    if (p !== null && typeof p !== 'string') return false;
    path.add(id);
    const result = p === null || visit(p, path);
    path.delete(id);
    memo.set(id, result);
    return result;
  }
  return new Set(ids(doc).filter((id) => visit(id, new Set())));
}

export function children(doc, parentId, shown = visible(doc)) {
  const parent = doc.getMap('parent');
  const order = doc.getMap('order');
  return [...shown].filter((id) => parent.get(id) === parentId).sort((a,b) => {
    const x = order.get(a), y = order.get(b);
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
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
