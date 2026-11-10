import {ensure} from '../../_lib/db.js';
// GET /api/songs?min=<sec>&max=<sec>  -> saved songs whose length is in that range (for fingerprint matching)
// POST /api/songs                     -> save a new song (needs the editor key)
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function onRequestGet({request,env}){
  await ensure(env); const u=new URL(request.url), min=+u.searchParams.get('min'), max=+u.searchParams.get('max');
  // ?list=1 -> every saved song, names only (CJ: the library list under the upload area)
  if(u.searchParams.get('list')){ const {results}=await env.DB.prepare('SELECT id,dur,data FROM songs ORDER BY saved_at DESC LIMIT 1000').all();
    return json({songs:results.map(r=>{ let d={}; try{ d=JSON.parse(r.data); }catch(e){} return {id:r.id,dur:r.dur,title:d.title||'',artist:d.artist||'',chartKey:d.chartKey||'',savedAt:d.savedAt||null,hasChart:!!(d.chart&&Array.isArray(d.chart.sections))}; })}); }
  if(!(max>min) || max-min>20) return json({error:'bad range'},400);
  const {results}=await env.DB.prepare('SELECT id,data FROM songs WHERE dur BETWEEN ?1 AND ?2 LIMIT 50').bind(min,max).all();
  return json({songs:results.map(r=>({id:r.id,...JSON.parse(r.data)}))});
}
export async function onRequestPost({request,env}){
  if(!env.EDITOR_KEY || request.headers.get('x-editor-key')!==env.EDITOR_KEY) return json({error:'not allowed'},403);
  await ensure(env); const d=await request.json(); if(!(d && d.dur>0 && Array.isArray(d.env))) return json({error:'bad song'},400);
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO songs (id,dur,data,saved_at) VALUES (?1,?2,?3,?4)').bind(id,d.dur,JSON.stringify(d),new Date().toISOString()).run();
  return json({id});
}
