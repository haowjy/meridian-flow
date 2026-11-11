use std::{collections::HashSet, env, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
use base64::{engine::general_purpose::STANDARD, Engine};
use notify::{RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
struct Core { child: Child, input: ChildStdin, output: BufReader<std::process::ChildStdout> }
impl Core {
 fn start(command: &str, script: &str) -> Result<Self> { let mut child=Command::new(command).arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?; let input=child.stdin.take().unwrap();let output=BufReader::new(child.stdout.take().unwrap()); Ok(Self{child,input,output}) }
 fn call(&mut self, request: Value) -> Result<Value> {writeln!(self.input,"{}",request)?; self.input.flush()?;let mut line=String::new();if self.output.read_line(&mut line)?==0{return Err("core exited".into())} let v:Value=serde_json::from_str(&line)?; if v["ok"]!=true{return Err(format!("core error: {}",v["error"]).into())} Ok(v)}
}
impl Drop for Core {fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
fn process(path:&Path, root:&Path, db:&mut Connection, core:&mut Core, since:Instant) -> Result<()> {
 if path.extension().and_then(|x|x.to_str())!=Some("md") || !path.is_file() {return Ok(())}
 let name=path.strip_prefix(root)?.to_string_lossy().to_string(); let text=fs::read_to_string(path)?;let hash=Sha256::digest(text.as_bytes()).to_vec();
 let prev:Option<(Vec<u8>,Vec<u8>)>=db.query_row("SELECT hash,state FROM files WHERE path=?1",[&name],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
 if prev.as_ref().is_some_and(|p|p.0==hash){eprintln!("unchanged {name} watcher_ms={:.2}",since.elapsed().as_secs_f64()*1000.);return Ok(())}
 let delay=since.elapsed();let t=Instant::now();let state=prev.as_ref().map(|p|STANDARD.encode(&p.1));let result=core.call(json!({"a":state,"b":state,"text":text,"actor":"file-user"}))?;let call=t.elapsed();
 let output=result["markdown"].as_str().ok_or("missing markdown")?;let state=STANDARD.decode(result["state"].as_str().ok_or("missing state")?)?;let update=STANDARD.decode(result["update"].as_str().ok_or("missing update")?)?;let out_hash=Sha256::digest(output.as_bytes()).to_vec();
 // DB commits before disk write; startup reconciliation is intentionally examined by the spike.
 let t=Instant::now();let tx=db.transaction()?;tx.execute("INSERT INTO files(path,text,hash,state) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET text=excluded.text,hash=excluded.hash,state=excluded.state",params![name,output,out_hash,state])?;if result["changed"]==true {tx.execute("INSERT INTO updates(path,update_blob) VALUES(?1,?2)",params![name,update])?;}tx.commit()?;let storage=t.elapsed();
 if output!=text {fs::write(path,output)?;}
 eprintln!("commit {name} watcher_ms={:.2} core_ms={:.2} storage_ms={:.2} changed={}",delay.as_secs_f64()*1000.,call.as_secs_f64()*1000.,storage.as_secs_f64()*1000.,result["changed"]);Ok(())
}
fn main()->Result<()> {let args:Vec<String>=env::args().collect();if args.len()!=5{return Err("usage: daemon ROOT DB CORE_COMMAND CORE_SCRIPT".into())} let root=fs::canonicalize(&args[1])?;let mut db=Connection::open(&args[2])?;db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,text TEXT NOT NULL,hash BLOB NOT NULL,state BLOB NOT NULL); CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,path TEXT NOT NULL,update_blob BLOB NOT NULL);")?;let mut core=Core::start(&args[3],&args[4])?;
 let (send,recv)=mpsc::channel();let mut watcher=notify::recommended_watcher(move |x|{let _=send.send((Instant::now(),x));})?;watcher.watch(&root,RecursiveMode::Recursive)?;
 for e in WalkDir::new(&root).into_iter().filter_map(|x|x.ok()){if e.file_type().is_file(){process(e.path(),&root,&mut db,&mut core,Instant::now())?;}} eprintln!("ready");
 loop {let (first,event)=recv.recv()?;let mut paths=HashSet::<PathBuf>::new();if let Ok(e)=event {paths.extend(e.paths);}while let Ok((_,event))=recv.recv_timeout(Duration::from_millis(100)){if let Ok(e)=event {paths.extend(e.paths);}}for path in paths {if let Err(e)=process(&path,&root,&mut db,&mut core,first){eprintln!("error {e}");return Err(e)}}}
}
