import {HocuspocusProvider} from '../../../../../app/node_modules/@hocuspocus/provider';
const start=Date.now();
const p=new HocuspocusProvider({url:'ws://127.0.0.1:1',name:'probe',onStatus:({status})=>console.log(Date.now()-start,'status',status),onDisconnect:()=>console.log(Date.now()-start,'disconnect'),onClose:()=>console.log(Date.now()-start,'close')});
setTimeout(()=>{p.destroy();console.log('destroyed');},4500);
