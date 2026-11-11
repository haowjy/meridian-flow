import subprocess,tempfile,os,time,json,threading,queue
q=queue.Queue()
with tempfile.TemporaryDirectory(prefix='p16411-watch-') as d:
 open(os.path.join(d,'chapter.md'),'w').write('baseline\n')
 p=subprocess.Popen(['/tmp/p16411-daemon',d],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 threading.Thread(target=lambda:[q.put(x) for x in p.stdout],daemon=True).start()
 try:
  print('ready',q.get(timeout=10).strip())
  path=os.path.join(d,'chapter.md')
  def save(s,rename=False):
   t=time.time_ns()//1000000
   if rename:
    tmp=os.path.join(d,'tmp');open(tmp,'w').write(s);os.replace(tmp,path)
   else: open(path,'w').write(s)
   print('save',t,repr(s))
  def drain(seconds):
   end=time.monotonic()+seconds
   while time.monotonic()<end:
    try: print('event',q.get(timeout=max(0,end-time.monotonic())).strip())
    except queue.Empty: break
  time.sleep(.2);save('first line\n',True);drain(1)
  save('second line\n');time.sleep(.05);save('third line\n');drain(1)
  save('normalization **test**\n\n\n');drain(1)
  save('different\n');drain(.3);save('normalization **test**\n');drain(.5)
 finally:
  p.terminate();p.wait(timeout=5);print('stderr',p.stderr.read())
