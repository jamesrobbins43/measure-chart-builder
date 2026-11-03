import {ensure} from '../_lib/db.js';
// POST /api/stats  -> the tool logs each new song someone loads (title, artist, key, length, a random browser id; no audio)
// GET  /api/stats  -> totals and most-loaded songs for the stats page (needs the editor key)
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const cut=(v,n)=>String(v??'').slice(0,n);
export async function onRequestPost({request,env}){
  const body=await request.text(); if(body.length>2000) return json({error:'too big'},413);
  let d; try{ d=JSON.parse(body); }catch(e){ return json({error:'bad json'},400); }
  await ensure(env);
  await env.DB.prepare('INSERT INTO uses (id,title,artist,song_key,dur,who,at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
    .bind(crypto.randomUUID(),cut(d.title,120).trim(),cut(d.artist,120).trim(),cut(d.key,12),+d.dur||0,cut(d.who,40),new Date().toISOString()).run();
  return json({ok:true});
}
export async function onRequestGet({request,env}){
  if(!env.EDITOR_KEY || request.headers.get('x-editor-key')!==env.EDITOR_KEY) return json({error:'not allowed'},403);
  await ensure(env);
  const days=Math.min(3650,Math.max(1,+new URL(request.url).searchParams.get('days')||30)), since=new Date(Date.now()-days*864e5).toISOString();
  const q=(sql,...b)=>env.DB.prepare(sql).bind(...b).all().then(r=>r.results);
  const [tot,songs,daily]=await Promise.all([
    q('SELECT COUNT(*) AS loads, COUNT(DISTINCT who) AS people FROM uses WHERE at>=?1',since),
    q(`SELECT MIN(title) AS title, MAX(artist) AS artist, COUNT(*) AS loads, COUNT(DISTINCT who) AS people, MAX(at) AS last
       FROM uses WHERE at>=?1 GROUP BY lower(title) ORDER BY loads DESC, last DESC LIMIT 200`,since),
    q("SELECT substr(at,1,10) AS day, COUNT(*) AS loads, COUNT(DISTINCT who) AS people FROM uses WHERE at>=?1 GROUP BY day ORDER BY day",since)]);
  return json({days,total:tot[0],songs,daily});
}
