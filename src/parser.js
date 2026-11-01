// ---- chart parsing (shared by the page and the node test) ----
const SECTION_RE=/^(intro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|bridge|interlude|instrumental|refrain|tag|outro|ending|turnaround|vamp|breakdown|channel|hook|solo|coda)\b\s*(\d+)?\s*(?:\(?\s*(\d+)\s*x\s*\)?)?\s*:?\s*$/i;
const CHORD_RE=/^(N\.?C\.?|[A-G][b#♭♯]?(?:maj|min|m|dim|aug|sus|add|M|°|ø|\+)?\d*(?:sus\d?|add\d+|maj\d+|b\d+|#\d+|\(.+?\))*(?:\/[A-G][b#♭♯]?)?)$/;
const isChord=t=>CHORD_RE.test(t.replace(/^\((.+)\)$/,'$1').replace(/[♭]/g,'b').replace(/[♯]/g,'#'));
function titleCase(s){return s.toLowerCase().replace(/(^|[^a-z0-9'’])([a-z])/g,(m,p,c)=>p+c.toUpperCase()).replace(/\bX\b/,'x')}

// pages: [{width, height, items:[{str,x,y,w,h}]}]  (y = PDF baseline, up is larger)
function pdfItemsToLines(pages){
  const out=[];
  for(const pg of pages){
    let items=pg.items.filter(it=>it.str && it.str.trim()!=='');
    if(!items.length) continue;
    const hs=items.map(i=>i.h).sort((a,b)=>a-b); const medH=hs[hs.length>>1]||9;
    // two-column layout? section headers or chord text starting past the middle
    const mid=pg.width/2;
    const right=items.filter(i=>i.x>mid-10);
    const twoCol=right.length>items.length*0.15;
    const cols=twoCol?[items.filter(i=>i.x<mid-10),items.filter(i=>i.x>=mid-10)]:[items];
    for(const col of cols){
      // superscripts: small items attach to the chord just left of them, slightly above its baseline
      const big=col.filter(i=>i.h>=medH*0.86), small=col.filter(i=>i.h<medH*0.86);
      // group big items into lines by baseline
      big.sort((a,b)=>b.y-a.y||a.x-b.x);
      const lines=[];
      for(const it of big){
        const L=lines.find(l=>Math.abs(l.y-it.y)<medH*0.3);
        if(L) L.items.push(it); else lines.push({y:it.y,items:[it]});
      }
      for(const s of small){
        // find line whose baseline is just below the superscript
        const L=lines.filter(l=>s.y>=l.y-1 && s.y-l.y<medH*0.9).sort((a,b)=>(s.y-a.y)-(s.y-b.y))[0];
        if(L) L.items.push({...s,sup:true});
      }
      lines.sort((a,b)=>b.y-a.y);
      for(const L of lines){
        L.items.sort((a,b)=>a.x-b.x);
        // join characters into words by gaps
        const words=[]; let cur=null;
        for(const it of L.items){
          const gap=cur? it.x-(cur.x+cur.w) : 1e9;
          const thresh=Math.max(2.2, medH*0.32);
          if(cur && (gap<thresh || (it.sup && gap<medH))){ cur.text+=it.str; cur.w=it.x+it.w-cur.x; }
          else { if(cur) words.push(cur); cur={text:it.str,x:it.x,w:it.w}; }
        }
        if(cur) words.push(cur);
        // items that are whole phrases with spaces: split them, estimating x per character
        const split=[];
        for(const w of words){
          const t=w.text; if(!/\s/.test(t.trim())){ split.push({text:t.trim(),x:w.x,w:w.w}); continue; }
          const cw=w.w/Math.max(1,t.length); let i=0;
          for(const m of t.matchAll(/\S+/g)){ split.push({text:m[0],x:w.x+m.index*cw,w:m[0].length*cw}); i++; }
        }
        out.push({y:L.y, page:pages.indexOf(pg), words:split, text:split.map(w=>w.text).join(' ')});
      }
    }
  }
  return out;
}

// plain text (chords over lyrics, monospace): x = character column
function textToLines(txt){
  return txt.replace(/\r/g,'').split('\n').map(line=>{
    const words=[...line.matchAll(/\S+/g)].map(m=>({text:m[0],x:m.index,w:m[0].length}));
    return {words,text:words.map(w=>w.text).join(' ')};
  });
}

function parseLines(lines){
  const meta={title:'',artist:'',key:'',bpm:0,time:'4/4'};
  const sections=[]; let sec=null;
  const skip=t=>/worshiponline|page \d+ of \d+|^s ?o ?n ?g s ?t ?r ?u ?c ?t ?u ?r ?e$|ccli|copyright|©|all rights reserved/i.test(t);
  const orderLine=ws=>ws.length>=3 && ws.every(w=>/^(I|C\d*|PC\d*|INT\d*|V\d*|B\d*|INS|R\d*|END|T\d*|TAG|O|OUT|IN|TA)$/i.test(w.text));
  let pendingChords=null;
  const flushChords=()=>{ if(pendingChords && sec){ sec.lines.push({chords:pendingChords,lyric:[]}); } pendingChords=null; };
  lines.forEach((L,idx)=>{
    const t=L.text.trim(); if(!t) { return; }
    if(skip(t)) return;
    const km=t.match(/\bKEY\s*:?\s*([A-G][b#]?m?)\b/i), bm=t.match(/\bBPM\s+(\d{2,3})\b/i)||t.match(/\b(\d{2,3})\s*BPM\b/i), tm=t.match(/\b(\d{1,2}\/\d{1,2})\b(?!.*\/)/);
    if(km||bm){ if(km) meta.key=km[1]; if(bm) meta.bpm=+bm[1]; const ts=t.match(/TIME SIG\s*:?\s*(\d+\/\d+)/i)||t.match(/\b((?:2|3|4|5|6|7|9|12)\/(?:4|8))\b/); if(ts) meta.time=ts[1];
      const left=t.split(/\s*\|\s*|\s{2,}KEY/i)[0]; if(/\|/.test(t)) meta.artist=t.split('|')[0].trim(); return; }
    if(orderLine(L.words)) return;
    const sm=t.replace(/^[\[(]\s*|\s*[\])]\s*:?$/g,'').match(SECTION_RE);
    if(sm){ flushChords();
      const name=titleCase(sm[1]+(sm[2]?' '+sm[2]:'')); const rep=sm[3]?+sm[3]:1;
      sec={name,repeat:rep,label:name+(rep>1?` (${rep}x)`:''),lines:[]}; sections.push(sec); return; }
    if(!sec){ if(!meta.title && t.length>1) meta.title=titleCase(t); return; }
    const ws=L.words;
    if(ws.length && ws.every(w=>isChord(w.text))){ flushChords(); pendingChords=ws.map(w=>({name:w.text.replace(/^\((.+)\)$/,'$1'),x:w.x})); return; }
    // standalone superscript fragments like "7" or "add4" left over: ignore
    if(ws.every(w=>/^(\d+|add\d+|sus\d?|maj\d*)$/i.test(w.text))) return;
    sec.lines.push({chords:pendingChords||[],lyric:ws}); pendingChords=null;
  });
  flushChords();
  // turn each section into events: a chord + the words sung while it rings
  for(const s of sections){
    const ev=[];
    for(const ln of s.lines){
      const lw=ln.lyric;
      if(!ln.chords.length){
        // lyric with no chord above: belongs to the chord already ringing; start a new lyric line
        if(ev.length){ ev[ev.length-1].lines.push(lw.map(w=>w.text)); }
        else ev.push({chord:null,lines:[lw.map(w=>w.text)]});
        continue;
      }
      // each chord starts at the word it sits over (the first word whose right edge passes the chord)
      const cx=ln.chords.map(c=>c.x);
      const start=cx.map(x=>{ let i=lw.findIndex(w=>w.x+(w.w||w.text.length)>x+0.5); return i<0?lw.length:i; });
      for(let k=1;k<start.length;k++) if(start[k]<start[k-1]) start[k]=start[k-1];
      const pre=lw.slice(0,start[0]);
      if(pre.length){ const pl=pre.map(w=>w.text); pl.pickup=true; if(ev.length) ev[ev.length-1].lines.push(pl); else ev.push({chord:null,lines:[pl]}); }
      ln.chords.forEach((c,k)=>{
        const words=lw.slice(start[k], k+1<start.length?start[k+1]:lw.length).map(w=>w.text);
        // a chord with no words under it, written beside the next chord on a sung line, is a quick change (often just an eighth)
        ev.push({chord:c.name,lines:words.length?[words]:[], quick:!words.length && lw.length>0 && k+1<ln.chords.length && start[k]<lw.length});
      });
    }
    s.events=ev.filter(e=>e.chord||e.lines.length);
  }
  return {meta,sections};
}
if(typeof module!=='undefined') module.exports={pdfItemsToLines,textToLines,parseLines,isChord};
