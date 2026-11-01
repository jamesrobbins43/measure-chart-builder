# Builds the standalone site page from the same sources as the artifact.
# Differences from the artifact: the song library talks to /api/songs (Cloudflare D1) instead of the artifact database,
# saving needs the editor key (open the site once with ?editor=KEY), and there are no downloads.
import sys, os
H=os.path.dirname(os.path.abspath(__file__)); T=os.path.join(H,'src')
t=open(os.path.join(T,'template.html')).read()
t=t.replace('__PARSER__',open(os.path.join(T,'parser.js')).read()).replace('__ANALYSIS__',open(os.path.join(T,'analysis.js')).read())
old="let DB=null; (async()=>{ try{ DB=await window.claude?.use?.('db'); }catch(e){ DB=null; } })();"
assert old in t
shim=r"""// song library on this site's server (/api/songs); same shape as the artifact database the page was written for
let DB=(()=>{
  let key=null; try{ const u=new URL(location.href), k=u.searchParams.get('editor'); if(k){ localStorage.setItem('mcb-editor',k); u.searchParams.delete('editor'); history.replaceState(null,'',u); } key=localStorage.getItem('mcb-editor'); }catch(e){}
  const err=(code)=>Object.assign(new Error(code),{code});
  return { canSave:!!key, collection(){ const f={min:-1e9,max:1e9}; const api={
    where(field,op,v){ if(op==='>=') f.min=v; if(op==='<=') f.max=v; return api; },
    async get(){ const r=await fetch(`/api/songs?min=${f.min}&max=${f.max}`); if(!r.ok) throw err('unavailable'); const {songs}=await r.json(); return {docs:songs.map(s=>({id:s.id,data:()=>s}))}; },
    doc(id){ id=id||crypto.randomUUID(); return { id, async set(d){ const r=await fetch(`/api/songs/${encodeURIComponent(id)}`,{method:'PUT',headers:{'content-type':'application/json','x-editor-key':key||''},body:JSON.stringify(d)}); if(r.status===403) throw err('invalid_argument'); if(!r.ok) throw err('unavailable'); } }; } }; return api; } };
})();"""
t=t.replace(old,shim,1)
# no downloads on the site (licensing)
t=t.replace("let dl=null; (async()=>{ try{ dl=await window.claude?.use?.('downloads'); }catch(e){ dl=null; } })();","let dl=null;")
assert '<div class="group" hidden>Download' in t
open(os.path.join(H,'public','index.html'),'w').write(t)
print('ok',len(t))
