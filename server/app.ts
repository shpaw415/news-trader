// news-trader — logique client de la page News Trader (extraite à l'identique de l'ancienne
// template string de server.ts : mêmes ids, mêmes classes, mêmes chemins fetch relatifs).
const $=(i)=>document.getElementById(i);
const T=new URLSearchParams(location.search).get('t');
const Q=T?('?t='+encodeURIComponent(T)):'';
const fmt=(v,c)=>new Intl.NumberFormat('fr-CA',{style:'currency',currency:c}).format(v);
let st=null;
function msg(t){$('msg').textContent=t;}
async function act(path,body){try{const r=await fetch('api/'+path+Q,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const j=await r.json();msg(j.ok?('✔ '+j.output.split('\n').filter(Boolean).join(' | ')):('✖ '+(j.error||'erreur')));load();}catch(e){msg('✖ '+e)}}
async function load(){
 try{const r=await fetch('api/state'+Q);st=await r.json();}catch(e){msg('✖ état indisponible');return}
 const c=st.config.currency;
 $('mktpill').textContent=st.marketOpen?'Marché ouvert':'Marché fermé';$('mktpill').className='pill '+(st.marketOpen?'open':'closed');
 $('autopill').style.display=st.config.autoTrade?'inline-block':'none';
 if(st.portfolio){$('pv').textContent=fmt(st.portfolio.marketValue,c);
  const pnl=$('pnl');pnl.textContent=fmt(st.portfolio.pnl,c)+' ('+st.portfolio.pnlPct+' %)';pnl.className='v '+(st.portfolio.pnl>=0?'pos':'neg');
  $('cash').textContent=fmt(st.portfolio.cash,c);$('npos').textContent=st.positions.length+'/'+st.config.maxPositions;
  $('upd').textContent='Dernier scan : '+(st.portfolio.lastScan?new Date(st.portfolio.lastScan).toLocaleString('fr-CA'):'jamais');}
 $('chips').innerHTML=(st.watchlist||[]).map(s=>'<span class="chip" onclick="delW(\''+s+'\')">'+s+' ✕</span>').join('')||'<span class="empty">Watchlist vide</span>';
 $('tpos').innerHTML='<tr><th>Symbole</th><th>Qté</th><th>PRU</th><th>Dernier</th><th>Valeur</th><th>P&amp;L</th><th>Stop / Objectif</th><th>Raison</th><th></th></tr>'+
  (st.positions.map(p=>'<tr><td><b>'+p.ticker+'</b></td><td>'+p.qty+'</td><td>'+p.entry.toFixed(2)+'</td><td>'+p.last.toFixed(2)+'</td><td>'+fmt(p.value,c)+'</td><td class="'+(p.pnl>=0?'pos':'neg')+'">'+fmt(p.pnl,c)+' ('+p.pnlPct+' %)</td><td style="color:var(--mu)">'+p.stop.toFixed(2)+' / '+p.target.toFixed(2)+'</td><td style="color:var(--mu);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(p.reason||'')+'</td><td><button onclick="closeP(\''+p.ticker+'\')">Clôturer</button></td></tr>').join(''))||'<tr><td class="empty">Aucune position ouverte.</td></tr>';
 $('sigs').innerHTML=st.signals.map(s=>'<div class="sig"><span class="score '+(s.score>=70?'hi':s.score>=50?'mid':'lo')+'">'+s.score+'</span><span>'+(s.direction>0?'▲':'▼')+' <b>'+s.ticker+'</b> · '+s.event+'</span><a href="'+s.link+'" target="_blank" rel="noopener">'+s.title+'</a><span class="m">'+new Date(s.published).toLocaleString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+(s.traded?' · tradé':'')+'</span></div>').join('')||'<div class="empty">Aucun signal — lance un scan.</div>';
 $('ttr').innerHTML='<tr><th>Date</th><th>Sens</th><th>Symbole</th><th>Qté</th><th>Prix</th><th>P&amp;L</th><th>Raison</th></tr>'+
  (st.trades.map(t=>'<tr><td style="color:var(--mu)">'+new Date(t.time).toLocaleString('fr-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</td><td class="'+(t.side==='buy'?'pos':'neg')+'">'+(t.side==='buy'?'ACHAT':'VENTE')+'</td><td><b>'+t.ticker+'</b></td><td>'+t.qty+'</td><td>'+t.price.toFixed(2)+'</td><td class="'+((t.pnl??0)>=0?'pos':'neg')+'">'+(t.pnl==null?'—':fmt(t.pnl,st.portfolio.currency))+'</td><td style="color:var(--mu)">'+(t.reason||'')+'</td></tr>').join(''))||'<tr><td class="empty">Aucune transaction.</td></tr>';
}
window.delW=(s)=>act('watchlist',{action:'remove',ticker:s});
window.closeP=(s)=>act('close',{ticker:s});
window.load=load;
$('bscan').onclick=()=>{msg('Scan en cours… (jusqu\'à 60 s)');$('bscan').disabled=true;act('scan').finally(()=>$('bscan').disabled=false)};
$('btick').onclick=()=>act('tick');
$('badd').onclick=()=>{const v=$('winput').value.trim().toUpperCase();if(v){act('watchlist',{action:'add',ticker:v});$('winput').value=''}};
$('winput').addEventListener('keydown',e=>{if(e.key==='Enter')$('badd').click()});
$('breset').onclick=()=>{if(confirm('Réinitialiser le portefeuille simulé au capital de départ ?'))act('reset',{confirm:true})};
load();setInterval(load,10000);
