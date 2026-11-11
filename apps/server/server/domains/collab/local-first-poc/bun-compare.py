import json, subprocess
from pathlib import Path

cases = {
 'paragraph':'One small sentence.\n\nAnother paragraph.\n', 'heading':'# The gate\n\nA line.\n',
 'list':'- outer\n  - inner\n- [x] task\n- [ ] todo\n', 'table':'| Left | Right |\n| :--- | ---: |\n| a | b |\n',
 'image':'Before ![alt](https://example.org/a.png) after.\n', 'link':'A [link](https://example.org) here.\n',
 'code':'```ts\nconst a = 1;\n```\n', 'break':'first  \nsecond\n', 'mdx':'<Note title="Tip">\n\nA note.\n\n</Note>\n',
 'figure':'<Figure src="https://example.org/a.png" caption="Hi" />\n', 'empty':'\n', 'quote':'> A quote.\n', 'strong':'**Bold** and *italic*.\n',
 'unicode':'é e\u0301 👨‍👩‍👧‍👦 ß İ 中文\n'
}
for path in Path('apps/server/server/domains/import/__fixtures__/notes-folder/Chapters').glob('*.md'):
 cases['fixture '+path.name]=path.read_text()
def invoke(runtime, request):
 p=subprocess.run([runtime,'apps/server/server/domains/collab/local-first-poc/bun-deterministic.mjs','--compare'],input=json.dumps(request)+'\n',text=True,capture_output=True,check=True)
 return json.loads(p.stdout)
for name,text in cases.items():
 a=invoke('node',{'text':text}); b=invoke('bun',{'text':text})
 print(name, 'initial', a==b, 'node_ok',a.get('ok'),'bun_ok',b.get('ok'))
 if a.get('ok') and b.get('ok'):
  print(name,'markdown',a['markdown']==b['markdown'],'update',a['update']==b['update'])
  request={'a':a['state'],'text':a['markdown']+'\nExtra prose.\n','actor':'writer'}
  x=invoke('node',request); y=invoke('bun',request)
  print(name,'edit',x==y,'node_ok',x.get('ok'),'bun_ok',y.get('ok'))
