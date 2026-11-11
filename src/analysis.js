// ---- audio analysis + chart alignment (shared by the page and the node test) ----
function makeFFT(n){
  const levels=Math.log2(n)|0, rev=new Uint32Array(n), cos=new Float64Array(n/2), sin=new Float64Array(n/2);
  for(let i=0;i<n;i++){ let r=0,x=i; for(let j=0;j<levels;j++){ r=(r<<1)|(x&1); x>>=1; } rev[i]=r; }
  for(let i=0;i<n/2;i++){ cos[i]=Math.cos(2*Math.PI*i/n); sin[i]=Math.sin(2*Math.PI*i/n); }
  return function(re,im){
    for(let i=0;i<n;i++){ const j=rev[i]; if(j>i){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; } }
    for(let size=2; size<=n; size<<=1){
      const half=size>>1, step=n/size;
      for(let i=0;i<n;i+=size){
        for(let j=i,k=0;j<i+half;j++,k+=step){
          const l=j+half, tr=re[l]*cos[k]+im[l]*sin[k], ti=-re[l]*sin[k]+im[l]*cos[k];
          re[l]=re[j]-tr; im[l]=im[j]-ti; re[j]+=tr; im[j]+=ti;
        }
      }
    }
  };
}
function hann(n){ const w=new Float32Array(n); for(let i=0;i<n;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/n); return w; }
const tick=()=>new Promise(r=>setTimeout(r,0));

// spectral-flux onset envelope
async function onsetEnvelope(x,sr,progress){
  const N=1024, hop=256, fft=makeFFT(N), win=hann(N);
  const frames=Math.max(1,Math.floor((x.length-N)/hop));
  const kmax=Math.min(N/2, Math.round(8000/sr*N));
  const env=new Float32Array(frames), prev=new Float32Array(kmax), re=new Float64Array(N), im=new Float64Array(N);
  for(let f=0;f<frames;f++){
    const o=f*hop;
    for(let i=0;i<N;i++){ re[i]=x[o+i]*win[i]; im[i]=0; }
    fft(re,im);
    let s=0;
    for(let k=1;k<kmax;k++){ const m=Math.log1p(100*Math.hypot(re[k],im[k])); const d=m-prev[k]; if(d>0) s+=d; prev[k]=m; }
    env[f]=s;
    if((f&4095)===0){ progress&&progress(f/frames); await tick(); }
  }
  // remove the slow trend so only attacks remain
  const W=Math.round(0.4*sr/hop), out=new Float32Array(frames); let acc=0;
  for(let f=0;f<frames;f++){ acc+=env[f]; if(f>=W) acc-=env[f-W]; const mean=acc/Math.min(f+1,W); out[f]=Math.max(0,env[Math.max(0,f-(W>>1))]-mean); }
  // align: out[f] holds the value for frame f-W/2; shift back
  const sh=new Float32Array(frames); const s2=W>>1; for(let f=0;f<frames;f++) sh[f]=out[Math.min(frames-1,f+s2)];
  let mx=0; for(const v of sh) if(v>mx) mx=v; if(mx>0) for(let f=0;f<frames;f++) sh[f]/=mx;
  return {env:sh, fps:sr/hop, offset:N/2/sr};
}

// 12-bin chroma and bass chroma, ~93 ms frames
async function chromaFrames(x,sr,progress){
  const N=4096, hop=2048, fft=makeFFT(N), win=hann(N);
  const frames=Math.max(1,Math.floor((x.length-N)/hop));
  const pcOf=new Int8Array(N/2).fill(-1), bassOf=new Int8Array(N/2).fill(-1);
  for(let k=1;k<N/2;k++){ const f=k*sr/N; const pc=((Math.round(12*Math.log2(f/440)+69)%12)+12)%12;
    if(f>=80&&f<=2200) pcOf[k]=pc; if(f>=40&&f<=220) bassOf[k]=pc; }
  const C=new Float32Array(frames*12), B=new Float32Array(frames*12), E=new Float32Array(frames);
  const re=new Float64Array(N), im=new Float64Array(N);
  for(let f=0;f<frames;f++){
    const o=f*hop; let e=0;
    for(let i=0;i<N;i++){ const v=x[o+i]; re[i]=v*win[i]; im[i]=0; e+=v*v; }
    E[f]=Math.sqrt(e/N);
    fft(re,im);
    for(let k=1;k<N/2;k++){ const m=Math.hypot(re[k],im[k]); if(pcOf[k]>=0) C[f*12+pcOf[k]]+=m; if(bassOf[k]>=0) B[f*12+bassOf[k]]+=m; }
    if((f&255)===0){ progress&&progress(f/frames); await tick(); }
  }
  return {C,B,E,fps:sr/hop,offset:N/2/sr,frames};
}

function envAt(env,fps,offset,t){ const i=(t-offset)*fps; if(i<0||i>=env.length-1) return 0; const a=i|0, fr=i-a; return env[a]*(1-fr)+env[a+1]*fr; }
function gridScore(O,P,ph,t0,t1){ let s=0,n=0; for(let t=ph; t<t1; t+=P){ if(t>=t0){ s+=envAt(O.env,O.fps,O.offset,t); n++; } } return n?s/n:0; }

// steady-tempo beat grid: period P (seconds per counted beat) and phase of the first beat
function findGrid(O,dur,bpmHint){
  let cands=[];
  // autocorrelation of the envelope for 50-200 BPM, then fold into 66-140
  const fps=O.fps, env=O.env, lo=Math.round(0.3*fps), hi=Math.round(1.2*fps);
  let ab=0,bl=lo;
  for(let l=lo;l<=hi;l++){ let s=0; for(let i=0;i+l<env.length;i+=2) s+=env[i]*env[i+l]; if(s>ab){ab=s;bl=l;} }
  let Pa=bl/fps; while(60/Pa>140) Pa*=2; while(60/Pa<66) Pa/=2;
  if(bpmHint){ const Ph=60/bpmHint; cands=[Ph];
    /* CJ (Cornerstone): charts can be off by a few BPM (71.5 on the chart, 75 on the recording), so also try the tempo the audio itself repeats at, when it's near the chart's */
    let q=Pa; while(q>Ph*1.33) q/=2; while(q<Ph*0.75) q*=2; if(q>Ph*0.85 && q<Ph*1.18 && Math.abs(q/Ph-1)>0.025) cands.push(q); }
  else cands=[Pa];
  let best={s:-1};
  for(const [ci,P0] of cands.entries()){
    // search the half-beat grid (catches 8th-note pulse), then decide which half is the beat
    for(let P=P0*0.97; P<=P0*1.03; P+=0.0004){
      const h=P/2;
      for(let ph=0; ph<h; ph+=0.004){ const raw=gridScore(O,h,ph,0,dur), s=raw*(ci?1:1.03); /* a small edge to the chart's tempo */ if(s>best.s) best={s,raw,P,ph}; }
    }
  }
  // fine search around the best
  let {P,ph}=best, s0=best.raw;
  for(let p=P-0.0006;p<=P+0.0006;p+=0.00005) for(let q=ph-0.006;q<=ph+0.006;q+=0.001){ const s=gridScore(O,p/2,q,0,dur); if(s>s0){s0=s;P=p;ph=q;} }
  // correct slow drift with a line fit through local phase offsets
  const pts=[];
  for(let t0=10;t0<dur-15;t0+=15){
    let bs=-1,bd=0; for(let d=-0.06;d<=0.06;d+=0.002){ const s=gridScore(O,P/2,ph+d,t0,t0+15); if(s>bs){bs=s;bd=d;} }
    pts.push([t0+7.5,bd]);
  }
  if(pts.length>4){
    const n=pts.length, mx=pts.reduce((a,p)=>a+p[0],0)/n, my=pts.reduce((a,p)=>a+p[1],0)/n;
    let sxy=0,sxx=0; for(const [x,y] of pts){ sxy+=(x-mx)*(y-my); sxx+=(x-mx)**2; }
    const slope=sxy/sxx;
    if(Math.abs(slope)<0.002){ P=P*(1+slope); ph=ph+(my-slope*mx); }
  }
  // which half-grid phase is the beat (stronger attacks)
  const h=P/2; ph=((ph%h)+h)%h;
  const a=gridScore(O,P,ph,0,dur), b=gridScore(O,P,ph+h,0,dur);
  const beat0=a>=b?ph:ph+h;
  return {P, beat0, conf:best.s};
}

// 6/8, 9/8, 12/8: find the eighth-note length. Charts give the tempo of the quarter or dotted quarter,
// so try both and keep the one whose groups of 3 eighths (and whole bars) repeat most strongly in the audio.
function compoundEighth(O,bpmHint,meter){
  const env=O.env, fps=O.fps, n=env.length, m=env.reduce((a,b)=>a+b,0)/n;
  const ac=lagS=>{ const L=Math.round(lagS*fps); let best=-1e9; for(let l=L-2;l<=L+2;l++){ if(l<1||l>=n) continue; let s=0; for(let i=0;i+l<n;i+=2) s+=(env[i]-m)*(env[i+l]-m); if(s>best) best=s; } return best; };
  let cands=[]; if(bpmHint) cands=[60/(bpmHint*2),60/(bpmHint*3),60/bpmHint,60/(bpmHint*1.5)];
  else for(let p=0.18;p<=0.6;p+=0.01) cands.push(p);
  cands=cands.filter(p=>p>=0.17&&p<=0.62); if(!cands.length) cands=[0.3];
  let best=null; for(const p of cands){ const sc=ac(3*p)+ac(meter*p); if(!best||sc>best.sc) best={p,sc}; }
  return best.p;
}
// where the singing starts: lead vocals sit in the centre of the mix, so track energy (250 Hz-3.5 kHz)
// that is much stronger in the middle than at the sides, and mark where it rises after a gap
async function vocalOnsets(L,R,sr,progress,opt={}){
  const N=1024, hop=256, H=N/2, fft=makeFFT(N), win=hann(N), fps=sr/hop;
  const k0=Math.round(250*N/sr), k1=Math.round(3500*N/sr), frames=Math.max(0,Math.floor((L.length-N)/hop));
  const v=new Float32Array(frames), re=new Float64Array(N), im=new Float64Array(N); let t0=Date.now();
  for(let f=0;f<frames;f++){ const o=f*hop;
    for(let i=0;i<N;i++){ re[i]=L[o+i]*win[i]; im[i]=R[o+i]*win[i]; }
    fft(re,im); let c=0;
    for(let k=k0;k<=k1;k++){ const j=N-k; const lr=(re[k]+re[j])/2, li=(im[k]-im[j])/2, rr=(im[k]+im[j])/2, ri=-(re[k]-re[j])/2;
      const M=Math.hypot(lr+rr,li+ri)/2, S=Math.hypot(lr-rr,li-ri)/2; c+=Math.max(0,M-2*S); }
    v[f]=c;
    if(progress && Date.now()-t0>40){ t0=Date.now(); progress(f/frames); await new Promise(r=>setTimeout(r,0)); } }
  // smooth ~120 ms, threshold well above the quiet level
  const W=Math.round(0.06*fps), sm=new Float32Array(frames); { let acc=0; for(let i=0;i<frames;i++){ acc+=v[i]; if(i>=2*W+1) acc-=v[i-2*W-1]; sm[Math.max(0,i-W)]=acc/(2*W+1); } }
  const sorted=[...sm].sort((a,b)=>a-b), q=p=>sorted[Math.floor(p*(sorted.length-1))]||0;
  const lo=q(0.25), hi=q(0.9), thr=lo+(hi-lo)*0.3;
  const on=[]; let below=0;
  for(let i=1;i<frames;i++){ if(sm[i]<thr){ below++; continue; } if(below>=Math.round((opt.gap??0.45)*fps)){ // rose after a gap: back up to where the rise began
      let j=i; while(j>0 && sm[j-1]<sm[j] && sm[j-1]>lo) j--; on.push(j/fps); } below=0; }
  // finer onsets (short gaps): roughly where each new word or held note comes in
  const fine=[]; below=0; const gF=Math.round(0.08*fps);
  for(let i=1;i<frames;i++){ if(sm[i]<thr){ below++; continue; } if(below>=gF){ let j=i; while(j>0 && sm[j-1]<sm[j] && sm[j-1]>lo) j--; fine.push(j/fps); } below=0; }
  return {onsets:on, fine, fps};
}
function beatSegments(Cf,P,beat0,dur){
  const beats=[]; for(let t=beat0;t<dur-0.05;t+=P) beats.push(t);
  const n=beats.length, C=new Float32Array(n*12), B=new Float32Array(n*12), E=new Float32Array(n);
  for(let i=0;i<n;i++){
    const a=Math.max(0,Math.floor((beats[i]-Cf.offset)*Cf.fps)), b=Math.min(Cf.frames,Math.max(a+1,Math.floor((beats[i]+P-Cf.offset)*Cf.fps)));
    let e=0;
    for(let f=a;f<b;f++){ for(let k=0;k<12;k++){ C[i*12+k]+=Cf.C[f*12+k]; B[i*12+k]+=Cf.B[f*12+k]; } e+=Cf.E[f]; }
    let nc=0,mb=0; for(let k=0;k<12;k++){ nc+=C[i*12+k]**2; if(B[i*12+k]>mb) mb=B[i*12+k]; }
    nc=Math.sqrt(nc)||1; for(let k=0;k<12;k++){ C[i*12+k]/=nc; B[i*12+k]/=(mb||1); }
    E[i]=e/Math.max(1,b-a);
  }
  return {beats,C,B,E,n};
}

function downbeatPhase(S,meter){
  const nov=new Float32Array(S.n);
  for(let i=1;i<S.n;i++){ let d=0; for(let k=0;k<12;k++) d+=S.C[i*12+k]*S.C[(i-1)*12+k]; nov[i]=1-d; }
  let best=0,bp=0;
  for(let p=0;p<meter;p++){ let s=0,c=0; for(let i=p;i<S.n;i+=meter){ s+=nov[i]; c++; } s/=c||1; if(s>best){best=s;bp=p;} }
  return bp;
}

// ---- chords ----
const PC={C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11,Cb:11};
function chordTemplate(name){
  const m=(name||'').match(/^([A-G][b#]?)(.*?)(?:\/([A-G][b#]?))?$/); if(!m) return null;
  const root=PC[m[1]]; let q=m[2]||''; const bass=m[3]!==undefined?PC[m[3]]:root;
  let iv=[[0,1],[4,1],[7,0.8]];
  if(/^m(?!aj)|^min/.test(q)) iv=[[0,1],[3,1],[7,0.8]];
  if(/dim|°/.test(q)) iv=[[0,1],[3,1],[6,0.8]];
  if(/aug|\+/.test(q)) iv=[[0,1],[4,1],[8,0.8]];
  if(/sus2/.test(q)) iv=[[0,1],[2,0.9],[7,0.8]]; else if(/sus/.test(q)) iv=[[0,1],[5,0.9],[7,0.8]];
  if(/^5$/.test(q)) iv=[[0,1],[7,1]];
  if(/maj7|M7/.test(q)) iv.push([11,0.5]); else if(/7/.test(q)) iv.push([10,0.5]);
  if(/add4|add11/.test(q)) iv.push([5,0.4]); if(/add9|add2/.test(q)) iv.push([2,0.4]); if(/6/.test(q)&&!/add/.test(q)) iv.push([9,0.4]);
  const t=new Float32Array(12); for(const [i,w] of iv) t[(root+i)%12]=w;
  let n=0; for(const v of t) n+=v*v; n=Math.sqrt(n); for(let k=0;k<12;k++) t[k]/=n;
  return {t,bass,root};
}

// expand sections (with repeats) into a flat event list
function expandEvents(sections){
  const ev=[];
  sections.forEach((s,si)=>{
    const reps=s.repeat||1;
    for(let r=0;r<reps;r++) s.events.forEach((e,k)=>ev.push({...e, sec:si, label:s.label, k, pass:r}));
  });
  // lyrics written before a section's first chord are sung as a pickup at the end of the previous event
  const out=[];
  for(const e of ev){
    if(!e.chord && out.length){ const prev=out[out.length-1]; prev.lines=[...prev.lines, ...e.lines.map(l=>{ const c=[...l]; c.pickup=true; return c; })]; continue; }
    out.push({...e});
  }
  let last=null; for(const e of out){ if(e.chord) last=e.chord; else e.chord=last||'N.C.'; }
  // keep k (position inside its section pass) consistent after merging
  let prevKey=null, k=0; for(const e of out){ const key=e.sec+'/'+e.pass; k= key===prevKey? k+1 : 0; e.k=k; prevKey=key; }
  return out;
}

// semi-Markov alignment: each event lasts a whole number of beats, in chart order
// opt.sub=2: S is cut into half beats, so chords can land on the "and" (meter and downPhase stay in beats)
function alignEvents(S,events,meterBeats,downPhaseBeats,opt={}){
  const sub=opt.sub||1, meter=meterBeats*sub, downPhase=downPhaseBeats*sub;
  const N=events.length, T=S.n, D=Math.min(64*sub,T);
  const shift=opt.shift||0;
  const rot=tp=>{ if(!tp||!shift) return tp; const t=new Float32Array(12); for(let k=0;k<12;k++) t[(k+shift)%12]=tp.t[k]; return {t,bass:(tp.bass+shift)%12,root:(tp.root+shift)%12}; };
  const temps=events.map(e=>rot(chordTemplate(e.chord)));
  // per-beat scores, centred across the song's distinct chords so silence scores ~0
  const uniq=[...new Set(events.map(e=>e.chord))], uT=uniq.map(c=>rot(chordTemplate(c)));
  const raw=(tp,i)=>{ if(!tp) return 0; let c=0; for(let k=0;k<12;k++) c+=S.C[i*12+k]*tp.t[k]; return c+0.35*S.B[i*12+tp.bass]; };
  const mean=new Float32Array(T); const emax=Math.max(...S.E)||1;
  for(let i=0;i<T;i++){ let s=0,n=0; for(const tp of uT){ if(tp){ s+=raw(tp,i); n++; } } mean[i]=n?s/n:0; }
  const loud=i=>Math.min(1,S.E[i]/(emax*0.08));
  // prefix sums per event
  const pre=events.map((e,j)=>{ const a=new Float32Array(T+1); for(let i=0;i<T;i++) a[i+1]=a[i]+((temps[j]?(raw(temps[j],i)-mean[i])*loud(i):0)+0.02)/sub; return a; }); // N.C. scores neutral, not penalised when the band keeps playing
  // short bars: in 4/4 a section can end with a 2-beat bar, which moves beat 1 by half a bar for the rest of the song.
  // h = how many half-bar moves so far (mod 2); it can only change where a new section starts.
  const H=(opt.short??true)&&meterBeats===4&&!opt.compound?2:1, HALF=meter/2, SHORT=opt.shortCost??0.4;
  // bars whose length was set by hand (CJ: "Beats in this bar"): [start, beats] in beats from the first downbeat.
  // Every beat after one moves beat 1 by (beats - meter); no automatic short bar may end inside one.
  const FIX=(opt.fixedBars||[]).map(([s0,L])=>({a:downPhase+Math.round(s0*sub),z:downPhase+Math.round((s0+L)*sub),d:Math.round((L-meterBeats)*sub)})).filter(f=>f.z>f.a);
  const offA=new Int32Array(T+2), noFlip=new Uint8Array(T+2); for(const f of FIX){ for(let i=Math.max(0,f.z);i<=T+1;i++) offA[i]+=f.d; for(let i=Math.max(0,f.a+1);i<=Math.min(T+1,f.z);i++) noFlip[i]=1; }
  const off=i=>offA[Math.max(0,Math.min(T+1,i))];
  const pos=(i,h=0)=>((i-downPhase-h*HALF-off(i))%meter+meter)%meter;
  const grp=opt.compound?3:2; // compound meters group eighths in threes
  const SW=opt.startW??1; // CJ: after a hand-set bar, chord changes lean harder toward beat 1
  const startBonus=(i,h)=>{ const p=pos(i,h); if(p%sub) return -0.3*SW; const pb=p/sub; return SW*(pb===0?0.35:((meterBeats===4&&pb===2)||(opt.compound&&pb%3===0))?0.12:opt.compound?-(opt.offGrp??0.35):-(opt.off4??0.3)); }; // 4/4: changes on beats 2 and 4 cost more (CJ, Praise: one chord per beat in the chorus) // 6/8: chords change on the big beats (CJ, I Believe)
  const durBonus=d=>(d%sub? -0.05 : (d/sub)%meterBeats===0?0.12:(d/sub)%grp===0?0.04:0);
  const NEG=-1e9, lam=0.0, REP=opt.rep??0.8, STR0=(opt.stretch??0.08)/sub;
  const sylls=events.map(e=>e.lines.reduce((a,l)=>a+l.reduce((x,w)=>x+syl(w),0),0)); // pickups into the next line are sung during this chord too
  // a sung line rarely takes much longer than ~0.6 s a syllable; past that, holding the chord costs a little each beat
  const Pb=S.n>1?(S.beats[1]-S.beats[0])*sub:0.6, SPS=opt.secPerSyl??0.6;
  const STR=STR0*Math.min(1,Pb*sub/0.6); // per second, not per beat, so short beats (6/8 eighths) don't make holding a chord dearer
  const maxNat=sylls.map((n,j)=>events[j].quick? sub : (n? Math.max(4,n*SPS/Pb) : 2*meterBeats)*sub);
  const minS=sylls.map(n=>Math.max(1,Math.ceil(n*0.16/(S.n>1?(S.beats[1]-S.beats[0])*sub:0.6)*sub))); /* CJ: in 4/4 a passing chord may take just beat 4, leading into the next bar */
  const minD=sylls.map((n,j)=>Math.max(!events[j].quick?(opt.compound?(opt.minGrp??2):(opt.min4??2))*sub:1,Math.ceil(n*0.16/Pb*sub))); // CJ (I Believe): in 6/8 a chord lasts at least a dotted quarter, so no bar gets 3-4 chords // no faster than ~6 syllables a second
  // a chord line with no words (intro, interlude) is usually played a bar per chord, even when a bar is a rest
  const secOf=events.map(e=>e.sec+'/'+e.pass), words=e=>e.lines.some(l=>!l.pickup&&l.length), bare=events.map((e0,j)=>{ if(words(e0)||e0.quick) return false; // only short all-instrumental sections (busy instrumentals change chords mid-bar)
    const same=events.filter((e,k)=>secOf[k]===secOf[j]); return same.length<=4 && same.every(e=>!e.quick && !words(e)) ? same.length : 0; }), BF=0.4, barFit=(d,n)=>(d===meter?BF:(n===1&&(d===4*meter||d===8*meter))?BF:(n<4&&d%meter===0)?0:-1) // four chords written for a bare line = four bars;
  // pattern memory: a later verse/chorus usually holds each chord about as long as the first one did (opt.refDur, in beats)
  const REF=opt.refDur||null, DEV=(opt.devCost??0.12)/sub;
  const quick=events.map(e=>!!e.quick), afterQuick=events.map((e,j)=>j>0&&!!events[j-1].quick);
  // a section can be played again right after itself (charts often write a repeat once)
  const firstOf=new Int32Array(N).fill(-1), lastOf=new Int32Array(N).fill(-1);
  { let i=0; while(i<N){ let k=i; while(k+1<N && events[k+1].sec===events[i].sec && events[k+1].pass===events[i].pass) k++; for(let q=i;q<=k;q++){ firstOf[q]=i; } lastOf[k]=i; i=k+1; } }
  // phrase memory: sections usually last a multiple of 4 bars, so a section that starts 4, 8, 12... bars
  // after the previous section started is preferred. Q = bar of the last section start, mod 4.
  const PH=opt.phrase??0.6, Q0=PH>0?4:1, Q=Q0*H, W=T+1; // state q = phrase bar (mod 4) + Q0 * h
  const dp=new Float64Array(N*W*Q).fill(NEG), bpD=new Int16Array(N*W*Q), bpP=new Int32Array(N*W*Q), bpQ=new Int8Array(N*W*Q);
  const arrV=new Float64Array(N*W*Q).fill(NEG), arrF=new Int32Array(N*W*Q), arrQ=new Int8Array(N*W*Q);
  const at=(j,b,q)=>(j*W+b)*Q+q;
  const anchor={}; for(const [j,v] of Object.entries(opt.anchors||{})) anchor[j]=v*sub;
  const barQ=(a,h)=>(((Math.floor((a-downPhase-h*HALF-off(a))/meter))%Q0)+Q0)%Q0;
  const isStart=j=>firstOf[j]===j;
  const repSrc=new Int32Array(N).fill(-1); for(let j=0;j<N;j++) if(isStart(j)) for(let k=j;k<N&&firstOf[k]===j;k++){ if(lastOf[k]===j){ repSrc[j]=k; break; } }
  // a section written "4X" may be played fewer times: the next section can follow any pass from the second on
  const SKIP=opt.skipCost??0.5, skipSrc=Array.from({length:N},()=>[]);
  for(let j=1;j<N;j++){ const pe=events[j-1]; if(!isStart(j) || pe.sec===events[j].sec || !(pe.pass>0)) continue;
    for(let k=0;k<j-1;k++){ const e=events[k], nx=events[k+1]; if(e.sec===pe.sec && e.pass>=1 && nx.pass===e.pass+1 && nx.sec===e.sec) skipSrc[j].push([k,SKIP*(pe.pass-e.pass)]); } }
  const fillArrive=a=>{ // best ways to be at the start of each event at beat a
    for(let j=0;j<N;j++){
      if(anchor[j]!==undefined && a!==anchor[j]) continue;
      if(j===0){ if(opt.minT!=null && S.beats[Math.min(a,S.n-1)]<opt.minT) continue; const q=barQ(a,0); const i=at(0,a,q); arrV[i]=lam*a; arrF[i]=-1; arrQ[i]=q; continue; }
      if(!isStart(j)){ for(let q=0;q<Q;q++){ const v=dp[at(j-1,a,q)]; if(v>NEG/2){ const i=at(j,a,q); arrV[i]=v; arrF[i]=j-1; arrQ[i]=q; } } continue; }
      const srcs=[[j-1,0]]; if(repSrc[j]>=0){ let nb=0; for(let k=j;k<N&&firstOf[k]===j;k++) if(bare[k]) nb++; srcs.push([repSrc[j],REP+BF*nb]); } // a repeat mustn't pay for itself with the bar-per-chord bonus
      for(const x of skipSrc[j]) srcs.push(x);
      for(const [k,cost] of srcs) for(let s=0;s<Q;s++){ const v0=dp[at(k,a,s)]; if(v0<=NEG/2) continue; const q=s%Q0, h=(s/Q0)|0;
        for(let h2=0;h2<H;h2++){
          if(h2!==h && (pos(a,h2)!==0 || noFlip[a])) continue; // a short bar only ever ends right where this section starts on beat 1
          const qn=barQ(a,h2), i=at(j,a,qn+Q0*h2), onBar=pos(a,h2)===0;
          const v=v0-cost-(h2===h ? (onBar&&q===qn?0:PH) : SHORT+(q===barQ(a,h)?0:PH)); // after a short bar, count whole bars in the old grid
          if(v>arrV[i]){ arrV[i]=v; arrF[i]=k; arrQ[i]=s; } } }
    }
  };
  for(let b=1;b<=T;b++){
    fillArrive(b-1);
    for(let j=0;j<N;j++){
      const P=pre[j], dm=Math.min(D,b);
      for(let q=0;q<Q;q++){
        let best=NEG,bd=0,bf=-1,bq=0;
        for(let d=opt.compound?minD[j]:Math.min(minD[j],Math.max(sub,minS[j]));d<=dm;d++){ const a=b-d, ia=at(j,a,q), pv=arrV[ia]; if(pv<=NEG/2) continue; const sh1=d<minD[j]&&(meterBeats===3||d*Pb/sub<(opt.minSec??0.78))&&!(d===sub&&pos(a,(q/Q0)|0)===(meterBeats-1)*sub)?(opt.short1??0.3):0; /* a one-beat chord is allowed but costs extra, except a passing chord on beat 4 (CJ); only at quicker tempos: Goodbye Yesterday (75 BPM) really does change every beat */
          const v=pv-sh1+(P[b]-P[a])+(afterQuick[j]?0:startBonus(a,(q/Q0)|0))+(quick[j]?0:durBonus(d))+(bare[j]?barFit(d,bare[j]):0)-(d>maxNat[j]?(quick[j]?0.15:STR)*(d-maxNat[j]):0)-(REF&&REF[j]>0?DEV*Math.max(0,Math.abs(d-REF[j]*sub)-sub):0); if(v>best){best=v;bd=d;bf=arrF[ia];bq=arrQ[ia];} }
        const io=at(j,b,q); dp[io]=best; bpD[io]=bd; bpP[io]=bf; bpQ[io]=bq;
      }
    }
  }
  let bestEnd=0,bestQ=0,bv=NEG; for(let b=1;b<=T;b++) for(let q=0;q<Q;q++){ const v=dp[at(N-1,b,q)]+lam*(T-b); if(v>bv){bv=v;bestEnd=b;bestQ=q;} }
  const path=[]; let j=N-1, b=bestEnd, q=bestQ;
  while(j>=0 && b>0){ const io=at(j,b,q), d=bpD[io], f=bpP[io], pq=bpQ[io]; path.push({j,start:b-d,h:(q/Q0)|0}); b-=d; if(j===0||f<0) break; j=f; q=pq; }
  path.reverse();
  // half-bar moves along the path, in beats from the first downbeat (each one ends a 2-beat bar)
  const moves=[]; for(let k=1;k<path.length;k++) if(path[k].h!==path[k-1].h) moves.push((path[k].start-downPhase)/sub);
  if(sub>1) for(const p of path) p.start/=sub;
  return {path,end:bestEnd/sub,score:bv,moves,fixed:(opt.fixedBars||[]).map(f=>[+f[0],+f[1]])};
}

// reference length for each event from the first time its section type was played (Verse 1 for Verse 2, ...)
function refDurations(events,al){
  const key=e=>e.label.replace(/\s*\(\d+x\)\s*$/i,'').replace(/\s*\d+\s*$/,'').toLowerCase()+'|'+e.k;
  const ref=new Map(), out=new Float32Array(events.length);
  al.path.forEach((p,i)=>{ const e=events[p.j], d=(i+1<al.path.length?al.path[i+1].start:al.end)-p.start, kk=key(e), own=e.sec+'/'+e.pass;
    const r=ref.get(kk); if(!r) ref.set(kk,{d,own}); else if(r.own!==own && !out[p.j]) out[p.j]=r.d; });
  return out;
}
// which transposition of the chart best matches the recording (0 = same key)
function keyShifts(S,events){
  const prof=new Float32Array(12); for(let i=0;i<S.n;i++) for(let k=0;k<12;k++) prof[k]+=S.C[i*12+k]*S.E[i];
  const cp=new Float32Array(12); for(const e of events){ const tp=chordTemplate(e.chord); if(tp) for(let k=0;k<12;k++) cp[k]+=tp.t[k]; }
  const z=a=>{ const m=a.reduce((x,y)=>x+y,0)/12; const d=Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0))||1; return a.map(v=>(v-m)/d); };
  const P=z([...prof]), Q=z([...cp]); const sc=[];
  for(let s=0;s<12;s++){ let c=0; for(let k=0;k<12;k++) c+=P[(k+s)%12]*Q[k]; sc.push([s,c]); }
  return sc.sort((a,b)=>b[1]-a[1]);
}
const NOTES_FLAT=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'], NOTES_SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT_KEYS=new Set(['F','Bb','Eb','Ab','Db','Gb','Cb','Dm','Gm','Cm','Fm','Bbm','Ebm']);
function transposeKey(key,n){ const m=(key||'C').match(/^([A-G][b#]?)(m?)$/); if(!m) return key; const pc=(PC[m[1]]+n+120)%12; const flat=NOTES_FLAT[pc]+m[2]; const sharp=NOTES_SHARP[pc]+m[2]; return FLAT_KEYS.has(flat)||!['G','D','A','E','B','F#','C#','Em','Bm','F#m','C#m','G#m','Am'].includes(sharp)&&flat.length<=sharp.length ? flat : sharp; }
function transposeChord(c,n,toKey){
  if(!n||!c) return c; const useFlat=FLAT_KEYS.has(toKey)||/b/.test(toKey||'');
  const T=x=>{ const pc=(PC[x]+n+120)%12; return (useFlat?NOTES_FLAT:NOTES_SHARP)[pc]; };
  return c.replace(/^([A-G][b#]?)/,(m)=>T(m)).replace(/\/([A-G][b#]?)$/,(m,b)=>'/'+T(b));
}

function syl(w){ w=w.toLowerCase().replace(/[^a-z]/g,''); let n=(w.match(/[aeiouy]+/g)||[]).length; if(w.endsWith('e')&&n>1&&!w.endsWith('le')) n--; return Math.max(1,n); }

// build the bar-by-bar chart
function buildSong(meta,sections,S,P,downPhase,meter,events,al,dur,vox){
  const beats=S.beats, beatT=x=>{ const i=Math.floor(x), r=x-i; return (i<beats.length? beats[i] : beats[0]+i*P)+r*P; };
  const bar0Beat=downPhase, bar0=beatT(bar0Beat), barLen=P*meter;
  // music end from energy
  const emax=Math.max(...S.E); let lastLoud=S.n-1; while(lastLoud>0 && S.E[lastLoud]<emax*0.03) lastLoud--;
  const endT=Math.max(beatT(al.end), beatT(lastLoud+1));
  // bar starts in beats from the first downbeat; a half-bar move (al.moves) ends a short bar there
  const total=(endT-bar0)/P-0.05*meter, moves=(al.moves||[]).slice().sort((a,b)=>a-b), bs=[]; { let x=0, mi=0;
    const fx=(al.fixed||[]).filter(f=>f[1]>0).sort((a,b)=>a[0]-b[0]); // bars set by hand: [start, beats]
    while(bs.length===0 || x<total){ bs.push(x); const f=fx.find(f=>Math.abs(f[0]-x)<1e-6); let nx;
      if(f){ nx=x+f[1]; while(mi<moves.length && moves[mi]<=nx+1e-6) mi++; }
      else { nx=x+meter; const g=fx.find(f=>f[0]>x+1e-6 && f[0]<nx-1e-6); if(g) nx=g[0];
        while(mi<moves.length && moves[mi]<=x+1e-6) mi++; if(mi<moves.length && moves[mi]<nx-1e-6){ nx=moves[mi]; mi++; } }
      x=nx; } }
  const nb=bs.length;
  const bars=bs.map((x,i)=>({chords:[],lyrics:[],section:null,s:x,len:(i+1<nb?bs[i+1]:x+meter)-x}));
  const barOf=x=>{ if(x<bs[0]) return Math.floor(x/meter); let lo=0,hi=nb-1; while(lo<hi){ const m=(lo+hi+1)>>1; if(bs[m]<=x+1e-6) lo=m; else hi=m-1; } return lo; };
  const nearBar=x=>{ const i=Math.max(0,barOf(x)); return (i+1<nb && bs[i+1]-x<x-bs[i]) ? i+1 : i; }; const usedOn=new Set(), phrases=[]; let pend=null, lastEnd=-1e9;
  const place=(t)=>{ const x=Math.round((t-bar0)/(P/2))/2, bar=barOf(x); return {bar, half:bar<0?0:Math.round((x-bs[bar])*2)}; };
  al.path.forEach((p,k)=>{
    const e=events[p.j];
    const t0=beatT(p.start), t1=beatT(k+1<al.path.length?al.path[k+1].start:al.end);
    const jumped=k>0 && al.path[k-1].j>=p.j;
    const isFirst=e.k===0 && (e.pass===0 || jumped);
    let {bar,half}=place(t0); if(bar<0){bar=0;half=0;} if(bar>=nb) return;
    bars[bar].chords.push([1+half/2,e.chord]);
    if(isFirst){ let sb=Math.max(0,Math.min(nb-1,nearBar((t0-bar0)/P))); while(sb<nb-1 && bars[sb].section) sb++; if(!bars[sb].section){ bars[sb].section=e.label; bars[sb].secIdx=e.sec; bars[sb].evIdx=p.j; } }
    // lyrics
    const main=e.lines.filter(l=>!l.pickup), pick=e.lines.filter(l=>l.pickup);
    const span=t1-t0, totSyl=main.reduce((a,l)=>a+l.reduce((x,w)=>x+syl(w),0),0)||1;
    let tl=t0;
    if(pend && !main.length){ const ps=pend.reduce((x,w)=>x+syl(w),0); phrases.push({t:t0-ps*P/4,words:pend,end:t0}); pend=null; }
    main.forEach((l,li)=>{
      const ls=l.reduce((x,w)=>x+syl(w),0), lspan=span*ls/totSyl;
      const rate=Math.min(P/2,Math.max(P/4,lspan/ls));
      // a phrase = any pickup words carried from the previous chord + this line
      const pre=(li===0&&pend)?pend:[]; const preSyl=pre.reduce((x,w)=>x+syl(w),0);
      phrases.push({t:tl-preSyl*Math.min(rate,P/4*1.5),words:[...pre,...l],end:tl+lspan});
      tl+=lspan;
    });
    if(main.length) pend=null;
    if(pick.length) pend=[...(pend||[]), ...pick.flat()];
  });
  // place phrases: start where we heard the singer start (if close), keep them in order,
  // and spread each phrase's syllables until the next phrase starts (not crammed at the front)
  { const SMIN=0.13, SMAX=0.5; let prev=-1e9;
    for(const ph of phrases){ ph.st=Math.max(prev,snap(ph.t)); ph.syl=ph.words.reduce((x,w)=>x+syl(w),0)||1; prev=ph.st+ph.syl*SMIN; }
    phrases.forEach((ph,i)=>{ const nx=i+1<phrases.length?phrases[i+1].st:ph.st+ph.syl*SMAX+P;
      const room=nx-ph.st-Math.min(P/2,0.25), want=Math.max(ph.end-ph.st, 0);
      let r=Math.max(SMIN,Math.min(SMAX,room/ph.syl));
      if(!vox||!vox.onsets.length) r=Math.max(SMIN,Math.min(SMAX,Math.min(room,want||room)/ph.syl));
      // nudge words onto the finer vocal onsets inside this phrase, in order (each snap re-anchors the rest)
      const fine=(vox&&vox.fine)||[]; let shift=0, lastT=ph.st-1, fi=0;
      let c=0; ph.words.forEach((w,wi)=>{ let t=ph.st+c*r+shift;
        if(wi===0) t=ph.st; else if(fine.length){ const tol=Math.max(r*1.6,P*0.6); let best=null;
          while(fi<fine.length && fine[fi]<=lastT+0.09) fi++;
          for(let k=fi;k<fine.length && fine[k]<Math.min(t+tol,nx-0.05);k++){ if(fine[k]<t-tol) continue; if(best===null||Math.abs(fine[k]-t)<Math.abs(best-t)) best=fine[k]; }
          if(best!==null){ shift+=best-t; t=best; } }
        addWord(t,w); lastT=t; c+=syl(w); }); });
  }
  function snap(t){ if(!vox||!vox.onsets.length) return t; const lo=Math.max(lastEnd-0.02,t-barLen*0.75), hi=t+P*1.01; let best=null;
    for(const o of vox.onsets){ if(o<lo) continue; if(o>hi) break; if(!usedOn.has(o) && (best===null || Math.abs(o-t)<Math.abs(best-t))) best=o; }
    if(best===null) return t; usedOn.add(best); return best; }
  function addWord(t,w){ t=Math.max(t,lastEnd); lastEnd=t+P/4*0.98; const x=Math.round((t-bar0)/(P/4))/4, bar=barOf(x); if(bar<0||bar>=nb) return; bars[bar].lyrics.push([Math.min(bars[bar].len*4-1,Math.round((x-bs[bar])*4)),w]); }
  // keep each bar's words in order and in distinct 16ths
  for(const b of bars){ b.lyrics.sort((x,y)=>x[0]-y[0]); b.chords.sort((x,y)=>x[0]-y[0]);
    // collapse duplicate chord positions (keep last)
    const m=new Map(); for(const c of b.chords) m.set(c[0],c[1]); b.chords=[...m.entries()].sort((a,c)=>a[0]-c[0]); }
  // repeat the ringing chord on beat 1 of bars with no change
  let ring=null; for(const b of bars){ if(!b.chords.length && ring) b.chords=[[1,ring]]; else if(b.chords.length && b.chords[0][0]>1 && ring) b.chords.unshift([1,ring]); if(b.chords.length) ring=b.chords[b.chords.length-1][1]; }
  // bars before the chart's first chord (ambience, a swell) are a lead-in, not part of the first section
  if(!bars[0].section){ const fb=bars.findIndex(b=>b.section); if(fb>0 && bars.slice(0,fb).every(b=>!b.chords.length)) bars[0].section='Lead-in'; else if(sections[0]) bars[0].section=sections[0].label; }
  return {title:meta.title, artist:meta.artist, key:meta.key, bpm:Math.round(60/P*10)/10, meter, bar0, beat:P, bars};
}

// ---- rough drum / bass split (harmonic-percussive separation by median filtering) ----
// L,R: stereo at sr (22050 works well). Returns drums (stereo) and bass (mono), same length and rate.
// Everything else = original - drums - bass, so the player can rebalance without new artifacts at 100%.
function med(a,n){ // median of the first n values of a (partial sort, a is scratch)
  const k=n>>1; let lo=0, hi=n-1;
  while(lo<hi){ const x=a[k]; let i=lo, j=hi;
    do{ while(a[i]<x) i++; while(x<a[j]) j--; if(i<=j){ const t=a[i]; a[i]=a[j]; a[j]=t; i++; j--; } }while(i<=j);
    if(j<k) lo=i; if(k<i) hi=j; }
  return a[k];
}
async function separateDrumsBass(L,R,sr,progress){
  const N=1024, hop=512, H=N/2+1, KT=9, KF=17, hT=KT>>1, hF=KF>>1;
  const fft=makeFFT(N), win=hann(N).map(Math.sqrt), len=L.length; // sqrt-hann in and out: exact rebuild at 50% overlap
  const frames=Math.ceil(len/hop)+2;
  const dL=new Float32Array(len), dR=new Float32Array(len), bs=new Float32Array(len), gL=new Float32Array(len), gR=new Float32Array(len);
  // guitars: in most band mixes they're panned left/right, so take the sustained, side-panned part between ~150 Hz and 6 kHz
  const gb=new Float32Array(H); for(let k=0;k<H;k++){ const f=k*sr/N; gb[k]= f<120||f>7000?0 : f<220?(f-120)/100 : f>5000?(7000-f)/2000 : 1; }
  const norm=1/N;
  const low=new Float32Array(H); for(let k=0;k<H;k++){ const f=k*sr/N; low[k]= f<=110?1 : f>=220?0 : 0.5+0.5*Math.cos(Math.PI*(f-110)/110); }
  // ring buffers of spectra (L, R as re/im) and mono magnitude
  const RING=KT; const ring=[]; for(let i=0;i<RING;i++) ring.push({lr:new Float64Array(H),li:new Float64Array(H),rr:new Float64Array(H),ri:new Float64Array(H),m:new Float32Array(H)});
  const re=new Float64Array(N), im=new Float64Array(N), re2=new Float64Array(N), im2=new Float64Array(N), re3=new Float64Array(N), im3=new Float64Array(N), sc=new Float32Array(Math.max(KT,KF));
  const at=(x,i)=> i>=0&&i<len? x[i] : 0;
  let t0=Date.now();
  for(let t=0;t<frames+hT;t++){
    if(t<frames){ // analyse frame t
      const o=(t-1)*hop, F=ring[t%RING];
      for(let i=0;i<N;i++){ re[i]=at(L,o+i)*win[i]; im[i]=at(R,o+i)*win[i]; }
      fft(re,im);
      for(let k=0;k<H;k++){ const j=(N-k)%N;
        const lr=(re[k]+re[j])/2, li=(im[k]-im[j])/2, rr=(im[k]+im[j])/2, ri=-(re[k]-re[j])/2;
        F.lr[k]=lr; F.li[k]=li; F.rr[k]=rr; F.ri[k]=ri; const mr=lr+rr, mi=li+ri; F.m[k]=Math.sqrt(mr*mr+mi*mi)/2; }
    }
    const c=t-hT; if(c<0) continue; if(c>=frames) break;
    const F=ring[c%RING], a0=Math.max(0,c-hT), a1=Math.min(frames-1,c+hT, t<frames?t:frames-1);
    re.fill(0); im.fill(0); re2.fill(0); im2.fill(0); re3.fill(0); im3.fill(0);
    for(let k=0;k<H;k++){
      let n=0; for(let q=a0;q<=a1;q++) sc[n++]=ring[q%RING].m[k];
      const Hm=med(sc,n);
      n=0; for(let q=Math.max(0,k-hF);q<=Math.min(H-1,k+hF);q++) sc[n++]=F.m[q];
      const Pm=med(sc,n);
      const p2=Pm*Pm, h2=Hm*Hm, mP=(p2+h2)>1e-12? p2/(p2+h2) : 0, mB=(1-mP)*low[k];
      // drums: stereo, packed as DL + i*DR
      const DLr=F.lr[k]*mP, DLi=F.li[k]*mP, DRr=F.rr[k]*mP, DRi=F.ri[k]*mP;
      re[k]=DLr-DRi; im[k]=DLi+DRr;
      if(k>0&&k<N/2){ const j=N-k; re[j]=DLr+DRi; im[j]=-DLi+DRr; }
      const mG=(1-mP)*gb[k];
      if(mG>0){ // side = (L-R)/2 ; guitar left = side, right = -side
        const Sr=(F.lr[k]-F.rr[k])/2*mG, Si=(F.li[k]-F.ri[k])/2*mG; // GL=S, GR=-S, packed as GL + i*GR
        const GLr=Sr, GLi=Si, GRr=-Sr, GRi=-Si;
        re3[k]=GLr-GRi; im3[k]=GLi+GRr; if(k>0&&k<N/2){ re3[N-k]=GLr+GRi; im3[N-k]=-GLi+GRr; } }
      if(mB>0){ const Br=(F.lr[k]+F.rr[k])/2*mB, Bi=(F.li[k]+F.ri[k])/2*mB; re2[k]=Br; im2[k]=Bi; if(k>0&&k<N/2){ re2[N-k]=Br; im2[N-k]=-Bi; } }
    }
    // inverse via conjugation
    for(let i=0;i<N;i++){ im[i]=-im[i]; im2[i]=-im2[i]; im3[i]=-im3[i]; }
    fft(re,im); fft(re2,im2); fft(re3,im3);
    const o=(c-1)*hop;
    for(let i=0;i<N;i++){ const p=o+i; if(p<0||p>=len) continue; const w=win[i]*norm; dL[p]+=re[i]*w; dR[p]+=-im[i]*w; bs[p]+=re2[i]*w; gL[p]+=re3[i]*w; gR[p]+=-im3[i]*w; }
    if(Date.now()-t0>40){ t0=Date.now(); if(progress) progress(c/frames); await new Promise(r=>setTimeout(r,0)); }
  }
  return {dL,dR,bass:bs,gL,gR};
}

if(typeof module!=='undefined') module.exports={vocalOnsets,compoundEighth,separateDrumsBass,keyShifts,transposeChord,transposeKey,onsetEnvelope,chromaFrames,findGrid,beatSegments,downbeatPhase,chordTemplate,expandEvents,alignEvents,buildSong};
