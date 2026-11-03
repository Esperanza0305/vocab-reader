'use strict';
/* ---------- IndexedDB ---------- */
const DB_NAME='vocab-reader',DB_VER=1;let _db;
function db(){return _db||(_db=new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,DB_VER);
 r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore('books',{keyPath:'id'});d.createObjectStore('files',{keyPath:'id'});
  const w=d.createObjectStore('words',{keyPath:'id'});w.createIndex('bookId','bookId');d.createObjectStore('kv',{keyPath:'k'});};
 r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
async function tx(store,mode,fn){const d=await db();return new Promise((res,rej)=>{const t=d.transaction(store,mode);const s=t.objectStore(store);let out;const r=fn(s);if(r)r.onsuccess=()=>out=r.result;t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error);});}
const idb={get:(s,k)=>tx(s,'readonly',o=>o.get(k)),all:(s)=>tx(s,'readonly',o=>o.getAll()),put:(s,v)=>tx(s,'readwrite',o=>o.put(v)),del:(s,k)=>tx(s,'readwrite',o=>o.delete(k))};
async function kvGet(k,def){const r=await idb.get('kv',k);return r?r.v:def}
const kvSet=(k,v)=>idb.put('kv',{k,v});

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(t._t);t._t=setTimeout(()=>t.hidden=true,1800);}
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);

/* ---------- dictionary ---------- */
const shardCache={};let lemmaMap=null;
async function loadShard(k){if(!/^[a-z]$/.test(k))return {};return shardCache[k]||(shardCache[k]=fetch(`dict/${k}.json`).then(r=>r.json()).catch(()=>{delete shardCache[k];return {}}));}
async function loadLemma(){return lemmaMap||(lemmaMap=await fetch('dict/lemma.json').then(r=>r.json()).catch(()=>({})));}
function candidates(w){const c=[];const add=x=>{if(x&&x.length>1&&!c.includes(x))c.push(x)};
 if(w.endsWith("'s"))add(w.slice(0,-2));
 if(w.endsWith('ies'))add(w.slice(0,-3)+'y');if(w.endsWith('es'))add(w.slice(0,-2));if(w.endsWith('s'))add(w.slice(0,-1));
 if(w.endsWith('ied'))add(w.slice(0,-3)+'y');if(w.endsWith('ed')){add(w.slice(0,-2));add(w.slice(0,-1));const b=w.slice(0,-2);if(/(.)\1$/.test(b))add(b.slice(0,-1));}
 if(w.endsWith('ing')){const b=w.slice(0,-3);add(b);add(b+'e');if(/(.)\1$/.test(b))add(b.slice(0,-1));if(b.endsWith('y'))add(b.slice(0,-1)+'ie');}
 if(w.endsWith('er')){add(w.slice(0,-2));add(w.slice(0,-1));}if(w.endsWith('est')){add(w.slice(0,-3));add(w.slice(0,-2));}
 if(w.endsWith('ly'))add(w.slice(0,-2));return c;}
function normWord(raw){return raw.toLowerCase().replace(/[’‘]/g,"'").replace(/^[^a-z]+|[^a-z]+$/g,'');}
async function lemmaOf(w){const lm=await loadLemma();if(lm[w])return lm[w];const sh=await loadShard(w[0]);if(sh[w])return w;
 for(const c of candidates(w)){const s=await loadShard(c[0]);if(s[c])return c;}return w;}
async function lookup(raw){const w=normWord(raw);if(!w)return null;const lemma=await lemmaOf(w);
 const e=(await loadShard(lemma[0]))[lemma];const surf=lemma!==w?(await loadShard(w[0]))[w]:null;
 return {word:w,lemma,phonetic:e?e[0]:(surf?surf[0]:''),meaning:e?e[1]:(surf?surf[1]:'（詞典裡找不到這個字）'),found:!!(e||surf)};}

/* ---------- FSRS ---------- */
const F=window.FSRS;const scheduler=F.fsrs(F.generatorParameters({enable_fuzz:true,enable_short_term:true}));
const ser=c=>({...c,due:new Date(c.due).toISOString(),last_review:c.last_review?new Date(c.last_review).toISOString():null});
const de=c=>({...c,due:new Date(c.due),last_review:c.last_review?new Date(c.last_review):undefined});

/* ---------- state ---------- */
let words=[],books=[];let savedLemmas=new Set();
async function refresh(){books=(await idb.all('books')).sort((a,b)=>(b.opened||b.added)-(a.opened||a.added));words=await idb.all('words');savedLemmas=new Set(words.map(w=>w.lemma));updateBadge();}

/* ---------- tabs ---------- */
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>show(b.dataset.view));
function show(v){document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+v));
 document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('active',x.dataset.view===v));
 ({library:renderLibrary,review:renderReview,words:renderWords,settings:renderSettings})[v]();}

/* ---------- library ---------- */
$('#epubInput').onchange=async e=>{for(const f of e.target.files){try{await importEpub(f)}catch(err){console.error(err);toast('匯入失敗：'+f.name)}}e.target.value='';await refresh();renderLibrary();};
async function importEpub(file){const buf=await file.arrayBuffer();const book=ePub(buf.slice(0));await book.ready;
 const md=await book.loaded.metadata;let cover=null;
 try{const cu=await book.coverUrl();if(cu){const bl=await fetch(cu).then(r=>r.blob());cover=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(bl)});}}catch(e){}
 const id=uid();await idb.put('files',{id,data:buf});
 await idb.put('books',{id,title:md.title||file.name.replace(/\.epub$/i,''),author:md.creator||'',cover,added:Date.now(),cfi:null,pct:0});book.destroy();toast('已匯入：'+(md.title||file.name));}
function renderLibrary(){const el=$('#bookList');$('#libEmpty').hidden=books.length>0;
 el.innerHTML=books.map(b=>{const n=words.filter(w=>w.bookId===b.id).length;return `<div class="book" data-id="${b.id}">
 <div class="cover">${b.cover?`<img src="${b.cover}" alt="">`:esc(b.title)}</div><div class="bar"><i style="width:${Math.round((b.pct||0)*100)}%"></i></div>
 <div class="meta"><div class="t">${esc(b.title)}</div><div class="s">${esc(b.author)}</div><div class="s">${n} 個生詞・${Math.round((b.pct||0)*100)}%</div></div>
 <button class="del" data-del="${b.id}" aria-label="刪除">✕</button></div>`}).join('');
 el.querySelectorAll('.book').forEach(d=>d.onclick=e=>{if(e.target.dataset.del)return;openBook(d.dataset.id)});
 el.querySelectorAll('[data-del]').forEach(d=>d.onclick=async()=>{const b=books.find(x=>x.id===d.dataset.del);if(!confirm(`刪除《${b.title}》？（已存的單字會保留）`))return;await idb.del('books',b.id);await idb.del('files',b.id);await refresh();renderLibrary();});}

/* ---------- reader ---------- */
let R={book:null,rend:null,meta:null};let fontPct=100;
async function openBook(id,cfi){const meta=await idb.get('books',id);const file=await idb.get('files',id);if(!meta||!file){toast('找不到這本書的檔案，請重新匯入');return;}
 closePopup();if(R.book)R.book.destroy();$('#reader').hidden=false;$('#readerTitle').textContent=meta.title;$('#viewer').innerHTML='';
 meta.opened=Date.now();await idb.put('books',meta);R.meta=meta;fontPct=await kvGet('fontPct',110);
 const book=ePub(file.data.slice(0));R.book=book;
 const rend=book.renderTo('viewer',{width:'100%',height:'100%',flow:'paginated',spread:'none',allowScriptedContent:false});R.rend=rend;
 rend.themes.default({body:{'font-family':'Georgia, "Times New Roman", serif !important','line-height':'1.6 !important','padding':'0 6px !important'},'::highlight(vr-saved)':{'background-color':'#f3dfd3','text-decoration':'underline dotted #c2603a'},'.vr-saved':{'background':'#f3dfd3'}});
 rend.themes.fontSize(fontPct+'%');
 rend.hooks.content.register(c=>hookContents(c));
 rend.on('relocated',async loc=>{R.loc=loc;const m=R.meta;m.cfi=loc.start.cfi;if(book.locations.length()){m.pct=book.locations.percentageFromCfi(loc.start.cfi);}
  $('#progress').textContent=book.locations.length()?Math.round((m.pct||0)*100)+'%':(loc.start.displayed?`${loc.start.displayed.page}/${loc.start.displayed.total}`:'');await idb.put('books',m);});
 await rend.display(cfi||meta.cfi||undefined);
 if(cfi){try{rend.annotations.highlight(cfi,{},null,'vr-jump',{fill:'#c2603a','fill-opacity':'0.35'});setTimeout(()=>{try{rend.annotations.remove(cfi,'highlight')}catch(_){}},5000);}catch(_){}}
 book.loaded.navigation.then(nav=>{$('#tocList').innerHTML=nav.toc.map(t=>`<a href="#" data-h="${esc(t.href)}">${esc(t.label.trim())}</a>`).join('');
  $('#tocList').querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();$('#toc').hidden=true;rend.display(a.dataset.h)});});
 book.ready.then(()=>book.locations.generate(1600)).then(()=>{if(R.loc)rend.emit('relocated',R.loc)}).catch(()=>{});}
$('#readerBack').onclick=async()=>{closePopup();$('#reader').hidden=true;if(R.book){R.book.destroy();R.book=null;}await refresh();show(document.querySelector('.tabs .active').dataset.view);};
$('#prevPage').onclick=()=>R.rend&&R.rend.prev();$('#nextPage').onclick=()=>R.rend&&R.rend.next();
$('#fontUp').onclick=()=>setFont(fontPct+10);$('#fontDown').onclick=()=>setFont(fontPct-10);
function setFont(p){fontPct=Math.max(70,Math.min(220,p));kvSet('fontPct',fontPct);if(R.rend)R.rend.themes.fontSize(fontPct+'%');toast('字體 '+fontPct+'%');}
$('#tocBtn').onclick=()=>$('#toc').hidden=false;$('#toc').onclick=e=>{if(e.target.id==='toc')$('#toc').hidden=true};
document.addEventListener('keydown',e=>{if($('#reader').hidden)return;if(e.key==='ArrowRight')R.rend.next();if(e.key==='ArrowLeft')R.rend.prev();if(e.key==='Escape')closePopup();});

function hookContents(c){const doc=c.document,win=c.window;let sx=0,sy=0,st=0;
 doc.addEventListener('touchstart',e=>{const t=e.changedTouches[0];sx=t.clientX;sy=t.clientY;st=Date.now()},{passive:true});
 doc.addEventListener('touchend',e=>{const t=e.changedTouches[0];const dx=t.clientX-sx,dy=t.clientY-sy;if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)*1.5){closePopup();dx<0?R.rend.next():R.rend.prev();doc._swiped=Date.now();}},{passive:true});
 doc.addEventListener('click',e=>{if(doc._swiped&&Date.now()-doc._swiped<400)return;onTap(e,c)});
 setTimeout(()=>highlightSaved(c),0);}
function caretAt(doc,x,y){if(doc.caretRangeFromPoint)return doc.caretRangeFromPoint(x,y);const p=doc.caretPositionFromPoint&&doc.caretPositionFromPoint(x,y);if(!p)return null;const r=doc.createRange();r.setStart(p.offsetNode,p.offset);return r;}
const WCH=/[A-Za-z'’\-]/;
function wordRangeAt(doc,x,y){const cr=caretAt(doc,x,y);if(!cr)return null;const n=cr.startContainer;if(n.nodeType!==3)return null;const s=n.data;let i=cr.startOffset,a=i,b=i;
 while(a>0&&WCH.test(s[a-1]))a--;while(b<s.length&&WCH.test(s[b]))b++;while(a<b&&/['’\-]/.test(s[a]))a++;while(b>a&&/['’\-]/.test(s[b-1]))b--;if(b<=a)return null;
 const r=doc.createRange();r.setStart(n,a);r.setEnd(n,b);const rect=r.getBoundingClientRect();if(x<rect.left-4||x>rect.right+4||y<rect.top-4||y>rect.bottom+4)return null;return r;}
function sentenceOf(range){let blk=range.startContainer.parentElement;while(blk&&!/^(P|DIV|LI|BLOCKQUOTE|H\d|TD|DD|BODY)$/.test(blk.tagName))blk=blk.parentElement;blk=blk||range.startContainer.parentElement;
 const pre=range.cloneRange();pre.setStart(blk,0);pre.setEnd(range.startContainer,range.startOffset);const off=pre.toString().length;const text=blk.textContent;
 let e;const re=/[.!?]+["”’)]*(\s|$)/g;re.lastIndex=off;const m=re.exec(text);e=m?m.index+m[0].length:text.length;
 const before=text.slice(0,off);let start=-1;const re2=/[.!?]+["”’)]*\s+(?=[“"‘A-Z])/g;let mm;while((mm=re2.exec(before)))start=mm.index+mm[0].length;
 const s=start<0?0:start;return text.slice(s,e).replace(/\s+/g,' ').trim().slice(0,400);}
let cur=null;
async function onTap(e,c){const doc=c.document;const r=wordRangeAt(doc,e.clientX,e.clientY);
 if(!r){if(!$('#popup').hidden){closePopup();return;}const fr=doc.defaultView.frameElement.getBoundingClientRect();const w=$('#viewer').clientWidth;const x=fr.left+e.clientX;if(x<w*0.22)R.rend.prev();else if(x>w*0.78)R.rend.next();return;}
 const raw=r.toString();const sel=doc.getSelection();sel.removeAllRanges();sel.addRange(r);
 let cfi=null;try{cfi=c.cfiFromRange(r)}catch(_){}
 const info=await lookup(raw);if(!info)return;cur={...info,surface:raw,sentence:sentenceOf(r),cfi,bookId:R.meta.id,bookTitle:R.meta.title};showPopup(cur);}
function showPopup(i){$('#popWord').textContent=i.lemma;$('#popPh').textContent=i.phonetic?`/${i.phonetic}/`:'';
 $('#popForm').textContent=i.lemma!==i.word?`原文：${i.surface}`:'';$('#popDef').textContent=i.meaning;$('#popSent').innerHTML=markSent(i.sentence,i.surface);
 const ex=words.find(w=>w.id===i.bookId+'|'+i.lemma);$('#popSave').textContent=ex?'✓ 已存（更新例句）':'＋ 存入單字本';$('#popup').hidden=false;}
function closePopup(){$('#popup').hidden=true;try{R.rend&&R.rend.getContents().forEach(c=>c.document.getSelection().removeAllRanges())}catch(_){}}
$('#popClose').onclick=closePopup;
$('#popSpeak').onclick=()=>{if(!cur)return;const u=new SpeechSynthesisUtterance(cur.lemma);u.lang='en-US';speechSynthesis.cancel();speechSynthesis.speak(u);};
$('#popSave').onclick=async()=>{if(!cur)return;const id=cur.bookId+'|'+cur.lemma;const old=await idb.get('words',id);
 const rec=old?{...old,sentence:cur.sentence,surface:cur.surface,cfi:cur.cfi}:{id,word:cur.lemma,lemma:cur.lemma,surface:cur.surface,phonetic:cur.phonetic,meaning:cur.meaning,sentence:cur.sentence,cfi:cur.cfi,bookId:cur.bookId,bookTitle:cur.bookTitle,created:Date.now(),card:ser(F.createEmptyCard(new Date()))};
 await idb.put('words',rec);await refresh();toast(old?'已更新例句':'已存入：'+cur.lemma);closePopup();R.rend.getContents().forEach(highlightSaved);};
function markSent(s,w){if(!s)return '';const i=s.toLowerCase().indexOf(String(w).toLowerCase());if(i<0)return esc(s);return esc(s.slice(0,i))+'<mark>'+esc(s.slice(i,i+w.length))+'</mark>'+esc(s.slice(i+w.length));}

/* highlight saved words (CSS Custom Highlight API; no DOM changes so CFIs stay valid) */
async function highlightSaved(c){const doc=c.document,win=c.window;if(!doc||!doc.body||!savedLemmas.size)return;
 const HL=win.Highlight,reg=win.CSS&&win.CSS.highlights;if(!HL||!reg)return;
 await loadLemma();const ranges=[];const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);const re=/[A-Za-z][A-Za-z'’\-]*/g;let n;
 const memo=new Map();
 while((n=walker.nextNode())){let m;re.lastIndex=0;while((m=re.exec(n.data))){const w=normWord(m[0]);if(!w)continue;
  let hit=memo.get(w);if(hit===undefined){hit=savedLemmas.has(w)||savedLemmas.has(lemmaMap[w])||candidates(w).some(x=>savedLemmas.has(x));memo.set(w,hit);}
  if(hit){const r=doc.createRange();r.setStart(n,m.index);r.setEnd(n,m.index+m[0].length);ranges.push(r);}}}
 reg.set('vr-saved',new HL(...ranges));}

/* ---------- review ---------- */
function deckOptions(sel,withCounts){const cur=sel.value;const ids=[...new Set(words.map(w=>w.bookId))];
 const label=id=>(books.find(b=>b.id===id)||{}).title||(words.find(w=>w.bookId===id)||{}).bookTitle||'未知書籍';
 sel.innerHTML=`<option value="all">全部混合</option>`+ids.map(id=>`<option value="${id}">${esc(label(id))}</option>`).join('');if([...sel.options].some(o=>o.value===cur))sel.value=cur;}
function inDeck(w,d){return d==='all'||w.bookId===d}
function todayKey(){const d=new Date();return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()}
async function dueList(deck){const now=new Date();const lim=await kvGet('newLimit',0);const seen=await kvGet('newSeen',{});const used=seen[todayKey()]||0;
 const ws=words.filter(w=>inDeck(w,deck));const rev=ws.filter(w=>w.card.state!==0&&new Date(w.card.due)<=now).sort((a,b)=>new Date(a.card.due)-new Date(b.card.due));
 let nw=ws.filter(w=>w.card.state===0).sort((a,b)=>a.created-b.created);if(lim>0)nw=nw.slice(0,Math.max(0,lim-used));return {rev,nw,total:ws.length,queue:[...rev,...nw]};}
async function updateBadge(){const {queue}=await dueList('all');const b=$('#dueBadge');b.hidden=!queue.length;b.textContent=queue.length;}
$('#deckSelect').onchange=()=>renderReview();
let flipped=false;
async function renderReview(){const sel=$('#deckSelect');deckOptions(sel);const {rev,nw,total,queue}=await dueList(sel.value);
 $('#reviewStats').innerHTML=`<div><b>${rev.length}</b><span>待複習</span></div><div><b>${nw.length}</b><span>新字</span></div><div><b>${total}</b><span>總字數</span></div>`;
 const area=$('#reviewCard');if(!total){area.innerHTML='<p class="empty">還沒有單字。打開一本書，點單字就能存起來。</p>';return;}
 if(!queue.length){const next=words.filter(w=>inDeck(w,sel.value)).map(w=>new Date(w.card.due)).sort((a,b)=>a-b)[0];
  area.innerHTML=`<p class="empty">🎉 今天的複習完成了！<br>下一張卡片：${next?next.toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}</p>`;return;}
 const w=queue[0];flipped=false;drawCard(w);}
function fmtIv(d){const m=(new Date(d)-new Date())/60000;if(m<60)return Math.max(1,Math.round(m))+' 分';if(m<1440)return Math.round(m/60)+' 小時';if(m<43200)return Math.round(m/1440)+' 天';if(m<525600)return Math.round(m/43200)+' 個月';return (m/525600).toFixed(1)+' 年';}
function drawCard(w){const area=$('#reviewCard');
 if(!flipped){area.innerHTML=`<div class="card-word">${esc(w.word)}</div><div class="card-ph">${w.phonetic?'/'+esc(w.phonetic)+'/':''}</div>
  <div class="card-sent" style="margin-top:24px">${markSent(w.sentence,w.surface||w.word)}</div><div class="grow"></div><button class="btn primary" id="flipBtn" style="width:100%;padding:14px">顯示答案</button>`;
  $('#flipBtn').onclick=()=>{flipped=true;drawCard(w)};return;}
 const pv=scheduler.repeat(de(w.card),new Date());const G=F.Rating;
 area.innerHTML=`<div class="card-word" style="margin-top:6px">${esc(w.word)} <button class="icon" id="cardSpeak">🔊</button></div><div class="card-ph">${w.phonetic?'/'+esc(w.phonetic)+'/':''}</div>
 <div class="card-def">${esc(w.meaning)}</div><div class="card-sent">${markSent(w.sentence,w.surface||w.word)}</div>
 <div class="card-src"><span>📖 ${esc(w.bookTitle)}</span>${w.cfi?'<button class="btn" id="jumpBtn">跳回原文</button>':''}</div><div class="grow"></div>
 <div class="rate"><button class="r1" data-r="${G.Again}">重來<small>${fmtIv(pv[G.Again].card.due)}</small></button><button class="r2" data-r="${G.Hard}">困難<small>${fmtIv(pv[G.Hard].card.due)}</small></button>
 <button class="r3" data-r="${G.Good}">良好<small>${fmtIv(pv[G.Good].card.due)}</small></button><button class="r4" data-r="${G.Easy}">簡單<small>${fmtIv(pv[G.Easy].card.due)}</small></button></div>`;
 $('#cardSpeak').onclick=()=>{const u=new SpeechSynthesisUtterance(w.word);u.lang='en-US';speechSynthesis.speak(u)};
 if($('#jumpBtn'))$('#jumpBtn').onclick=()=>openBook(w.bookId,w.cfi);
 area.querySelectorAll('[data-r]').forEach(b=>b.onclick=async()=>{const wasNew=w.card.state===0;w.card=ser(pv[+b.dataset.r].card);w.reviews=(w.reviews||0)+1;await idb.put('words',w);
  if(wasNew){const s=await kvGet('newSeen',{});const k=todayKey();s[k]=(s[k]||0)+1;await kvSet('newSeen',{[k]:s[k]});}await refresh();renderReview();});}

/* ---------- word list ---------- */
$('#wordsDeck').onchange=()=>renderWords();$('#wordSearch').oninput=()=>renderWords();
function renderWords(){const sel=$('#wordsDeck');deckOptions(sel);const q=$('#wordSearch').value.trim().toLowerCase();
 const ws=words.filter(w=>inDeck(w,sel.value)&&(!q||w.word.includes(q)||w.meaning.includes(q))).sort((a,b)=>b.created-a.created);
 $('#wordList').innerHTML=ws.length?ws.map(w=>`<div class="w"><div class="h"><b>${esc(w.word)}</b><span class="muted small">${w.phonetic?'/'+esc(w.phonetic)+'/':''}</span><span class="grow"></span><span class="muted small">${w.card.state===0?'新':'下次 '+new Date(w.card.due).toLocaleDateString('zh-TW',{month:'numeric',day:'numeric'})}</span></div>
 <div class="d">${esc(w.meaning.split('\n').slice(0,2).join('；'))}</div><div class="wl-sent">${markSent(w.sentence,w.surface||w.word)}</div>
 <div class="acts">${w.cfi?`<button class="icon" data-j="${esc(w.id)}">跳回原文</button>`:''}<button class="icon" data-d="${esc(w.id)}">刪除</button></div></div>`).join(''):'<p class="empty">沒有符合的單字</p>';
 $('#wordList').querySelectorAll('[data-j]').forEach(b=>b.onclick=()=>{const w=words.find(x=>x.id===b.dataset.j);openBook(w.bookId,w.cfi)});
 $('#wordList').querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{if(!confirm('刪除這個單字？'))return;await idb.del('words',b.dataset.d);await refresh();renderWords();});}

/* ---------- settings / backup ---------- */
function ab2b64(buf){let s='';const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s);}
function b642ab(b){const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u.buffer;}
$('#exportBtn').onclick=async()=>{const inc=$('#includeBooks').checked;const data={app:'vocab-reader',version:1,exported:new Date().toISOString(),books:await idb.all('books'),words:await idb.all('words'),settings:{fontPct:await kvGet('fontPct',110),newLimit:await kvGet('newLimit',0)}};
 if(inc)data.files=(await idb.all('files')).map(f=>({id:f.id,b64:ab2b64(f.data)}));
 const blob=new Blob([JSON.stringify(data)],{type:'application/json'});const name=`生詞閱讀備份-${new Date().toISOString().slice(0,10)}.json`;
 const file=new File([blob],name,{type:'application/json'});
 if(navigator.canShare&&navigator.canShare({files:[file]})){try{await navigator.share({files:[file],title:name});return;}catch(e){if(e.name==='AbortError')return;}}
 const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);toast('已匯出備份');};
$('#importInput').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{const d=JSON.parse(await f.text());if(d.app!=='vocab-reader')throw 0;
 let nw=0;for(const w of d.words||[]){const old=await idb.get('words',w.id);if(!old||new Date(w.card.last_review||0)>=new Date(old.card.last_review||0)){await idb.put('words',w);nw++;}}
 for(const b of d.books||[]){const old=await idb.get('books',b.id);if(!old)await idb.put('books',b);}
 for(const x of d.files||[])await idb.put('files',{id:x.id,data:b642ab(x.b64)});
 if(d.settings){await kvSet('fontPct',d.settings.fontPct);await kvSet('newLimit',d.settings.newLimit);}
 await refresh();toast(`已還原 ${nw} 個單字`);renderSettings();}catch(err){toast('這不是有效的備份檔');}};
$('#newLimit').onchange=e=>{kvSet('newLimit',Math.max(0,+e.target.value||0)).then(updateBadge)};
$('#dictDownload').onclick=async()=>{const b=$('#dictDownload');b.disabled=true;const L='abcdefghijklmnopqrstuvwxyz'.split('');let i=0;
 for(const k of L){b.textContent=`下載中 ${++i}/26`;await loadShard(k);}await loadLemma();await kvSet('dictFull',true);b.textContent='✓ 已下載完整詞典';};
async function renderSettings(){$('#newLimit').value=await kvGet('newLimit',0);if(await kvGet('dictFull',false)){$('#dictDownload').textContent='✓ 已下載完整詞典（可重新下載）';$('#dictDownload').disabled=false;}
 let s='';if(navigator.storage&&navigator.storage.estimate){const e=await navigator.storage.estimate();s=`已使用 ${(e.usage/1048576).toFixed(1)} MB`;}
 const p=navigator.storage&&navigator.storage.persisted?await navigator.storage.persisted():false;$('#storageStatus').textContent=`${s}${s?'・':''}${p?'✅ 已設為長期保存':'⚠️ 尚未設為長期保存'}`;}

/* ---------- boot ---------- */
(async()=>{if(navigator.storage&&navigator.storage.persist){try{await navigator.storage.persist()}catch(e){}}
 if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('sw.js');
 await refresh();renderLibrary();loadLemma();
 window.__app={idb,lookup,refresh,openBook,get words(){return words},get R(){return R}};})();
