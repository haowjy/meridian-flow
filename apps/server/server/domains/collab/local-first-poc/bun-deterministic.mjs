// Comparison only: replace random author IDs before lib0 binds getRandomValues.
import {webcrypto} from 'node:crypto';
let n=900000;
webcrypto.getRandomValues = array => { for(let i=0;i<array.length;i++) array[i]=++n; return array; };
await import('/tmp/p16411-proof.mjs');
