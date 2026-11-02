import {ensure} from '../../_lib/db.js';
// PUT /api/songs/<id> -> update a saved song's fixes (needs the editor key)
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function onRequestPut({request,env,params}){
  if(!env.EDITOR_KEY || request.headers.get('x-editor-key')!==env.EDITOR_KEY) return json({error:'not allowed'},403);
  await ensure(env); const d=await request.json(); if(!(d && d.dur>0 && Array.isArray(d.env))) return json({error:'bad song'},400);
  await env.DB.prepare('INSERT INTO songs (id,dur,data,saved_at) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET dur=?2,data=?3,saved_at=?4').bind(params.id,d.dur,JSON.stringify(d),new Date().toISOString()).run();
  return json({id:params.id});
}
// DELETE /api/songs/<id> -> remove a saved song so the site works it out again (needs the editor key)
export async function onRequestDelete({request,env,params}){
  if(!env.EDITOR_KEY || request.headers.get('x-editor-key')!==env.EDITOR_KEY) return json({error:'not allowed'},403);
  await ensure(env); await env.DB.prepare('DELETE FROM songs WHERE id=?1').bind(params.id).run();
  return json({ok:true});
}
