import {ensure} from '../_lib/db.js';
// POST /api/reports        -> anyone using the tool can send "something's wrong" with the song's details (no audio)
// GET  /api/reports        -> list reports, newest first (needs the editor key)
// PUT  /api/reports?id=..  -> mark one done (needs the editor key)
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const editor=(request,env)=>env.EDITOR_KEY && request.headers.get('x-editor-key')===env.EDITOR_KEY;
export async function onRequestPost({request,env}){
  const body=await request.text(); if(body.length>20000) return json({error:'too big'},413);
  let d; try{ d=JSON.parse(body); }catch(e){ return json({error:'bad json'},400); }
  if(!d || typeof d.message!=='string' || !d.message.trim()) return json({error:'empty'},400);
  d.message=d.message.slice(0,2000);
  await ensure(env);
  const {results}=await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE sent_at > ?1").bind(new Date(Date.now()-3600e3).toISOString()).all();
  if((results[0]?.n||0)>200) return json({error:'busy'},429); // simple flood guard
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO reports (id,data,sent_at) VALUES (?1,?2,?3)').bind(id,JSON.stringify(d),new Date().toISOString()).run();
  return json({id});
}
export async function onRequestGet({request,env}){
  if(!editor(request,env)) return json({error:'not allowed'},403);
  await ensure(env);
  const {results}=await env.DB.prepare('SELECT id,data,sent_at,done FROM reports ORDER BY sent_at DESC LIMIT 200').all();
  return json({reports:results.map(r=>({id:r.id,sentAt:r.sent_at,done:!!r.done,...JSON.parse(r.data)}))});
}
export async function onRequestPut({request,env}){
  if(!editor(request,env)) return json({error:'not allowed'},403);
  await ensure(env); const id=new URL(request.url).searchParams.get('id'); if(!id) return json({error:'no id'},400);
  await env.DB.prepare('UPDATE reports SET done=1 WHERE id=?1').bind(id).run(); return json({ok:true});
}
