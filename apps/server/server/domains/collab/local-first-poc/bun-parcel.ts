import watcher from '@parcel/watcher';
const s=await watcher.subscribe(process.argv[2],(_,events)=>console.log(JSON.stringify(events)));
console.log('ready');setTimeout(()=>s.unsubscribe(),4000);
