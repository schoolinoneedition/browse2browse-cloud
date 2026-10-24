(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const engines = {duckduckgo:q=>`https://duckduckgo.com/?q=${q}`,google:q=>`https://www.google.com/search?q=${q}`,bing:q=>`https://www.bing.com/search?q=${q}`,brave:q=>`https://search.brave.com/search?q=${q}`,yahoo:q=>`https://search.yahoo.com/search?p=${q}`};
  const defaults={engine:'duckduckgo',homepage:'',theme:'system',layout:'comfortable',animations:true};
  let prefs={...defaults,...read('b2b-settings',{})}, session=null, socket=null, tabs=[], activeId=null, retryTimer=null, retryCount=0, dragId=null, connectPromise=null;
  let bookmarks=read('b2b-bookmarks',[]), supabaseClient=null, cloudUser=null, cloudLastUserId=null, cloudSaveTimer=null, cloudHydrating=false;
  if(!Array.isArray(bookmarks))bookmarks=[];
  const api=(window.B2B_CONFIG?.apiBase||'').replace(/\/$/,'');
  const view=$('remoteView');
  function read(k,d){try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}}
  function save(){
    try{
      localStorage.setItem('b2b-settings',JSON.stringify(prefs));
      localStorage.setItem('b2b-recent',JSON.stringify(tabs.filter(t=>t.url).slice(0,12).map(t=>({url:t.url,title:t.title}))));
      localStorage.setItem('b2b-bookmarks',JSON.stringify(bookmarks));
    }catch{}
    queueCloudSave();
  }
  function status(s){$('statusText').textContent=s}
  function cloudStatus(message){const node=$('syncStatus');if(node)node.textContent=message}
  function updateSyncUI(){
    const configured=!!supabaseClient;
    $('syncSignIn').disabled=!configured||!!cloudUser;
    $('syncSignOut').hidden=!configured||!cloudUser;
    $('syncEmail').disabled=!configured||!!cloudUser;
    if(!configured)cloudStatus('Local-only mode. Add your Supabase project URL and publishable key in config.js to enable account sync.');
    else if(cloudUser)cloudStatus('Signed in as '+(cloudUser.email||'your account')+'. Syncing preferences, bookmarks and recent sites.');
    else cloudStatus('Sign in by email to sync preferences, bookmarks and recent sites across devices.');
  }
  async function flushCloudSave(){
    if(!supabaseClient||!cloudUser||cloudHydrating)return;
    const userId=cloudUser.id;
    const recent=read('b2b-recent',[])
      .filter(x=>x&&typeof x.url==='string'&&/^https?:\/\//i.test(x.url)&&x.url.length<=2048)
      .slice(0,30);
    const savedBookmarks=bookmarks
      .filter(x=>x&&typeof x.url==='string'&&/^https?:\/\//i.test(x.url)&&x.url.length<=2048)
      .slice(0,100);
    const prefResult=await supabaseClient.from('browser2browse_preferences').upsert({
      user_id:userId,preferences:prefs,updated_at:new Date().toISOString()
    },{onConflict:'user_id'});
    if(prefResult.error)throw prefResult.error;

    const deleted=await Promise.all([
      supabaseClient.from('browser2browse_bookmarks').delete().eq('user_id',userId),
      supabaseClient.from('browser2browse_history').delete().eq('user_id',userId)
    ]);
    const deleteError=deleted.find(x=>x.error)?.error;
    if(deleteError)throw deleteError;

    if(savedBookmarks.length){
      const result=await supabaseClient.from('browser2browse_bookmarks').insert(
        savedBookmarks.map(item=>({
          user_id:userId,url:item.url,title:String(item.title||'').slice(0,300),
          ...(item.createdAt?{created_at:item.createdAt}:{})
        }))
      );
      if(result.error)throw result.error;
    }
    if(recent.length){
      const now=Date.now();
      const result=await supabaseClient.from('browser2browse_history').insert(
        recent.map((item,index)=>({
          user_id:userId,url:item.url,title:String(item.title||'').slice(0,300),
          visited_at:new Date(now-index*1000).toISOString()
        }))
      );
      if(result.error)throw result.error;
    }
    cloudStatus('Synced just now · '+(cloudUser.email||'your account'));
  }
  function queueCloudSave(){
    if(!supabaseClient||!cloudUser||cloudHydrating)return;
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer=setTimeout(()=>flushCloudSave().catch(error=>{
      cloudStatus('Cloud sync error: '+(error?.message||'Could not save data.'));
    }),700);
  }
  async function loadCloudData(userId){
    if(!supabaseClient||!cloudUser||cloudUser.id!==userId||cloudHydrating)return;
    cloudHydrating=true;
    let syncAfterLoad=false;
    try{
      const results=await Promise.all([
        supabaseClient.from('browser2browse_preferences').select('preferences').eq('user_id',userId).maybeSingle(),
        supabaseClient.from('browser2browse_bookmarks').select('url,title,created_at').eq('user_id',userId).order('created_at',{ascending:false}).limit(100),
        supabaseClient.from('browser2browse_history').select('url,title,visited_at').eq('user_id',userId).order('visited_at',{ascending:false}).limit(30)
      ]);
      const queryError=results.find(x=>x.error)?.error;
      if(queryError)throw queryError;
      const [prefResult,bookmarkResult,historyResult]=results;
      if(prefResult.data?.preferences&&typeof prefResult.data.preferences==='object'){
        prefs={...defaults,...prefResult.data.preferences};
      }
      const isValid=x=>x&&typeof x.url==='string'&&/^https?:\/\//i.test(x.url)&&x.url.length<=2048;
      const remoteBookmarks=(bookmarkResult.data||[]).filter(isValid).map(x=>({
        url:x.url,title:x.title||x.url,createdAt:x.created_at
      }));
      const localBookmarks=Array.isArray(bookmarks)?bookmarks.filter(isValid):[];
      const seenBookmarks=new Set();
      bookmarks=[...remoteBookmarks,...localBookmarks].filter(x=>{
        if(seenBookmarks.has(x.url))return false;
        seenBookmarks.add(x.url);return true;
      }).slice(0,100);
      const remoteRecent=(historyResult.data||[]).filter(isValid).map(x=>({
        url:x.url,title:x.title||x.url,visitedAt:x.visited_at
      }));
      const localRecent=read('b2b-recent',[]).filter(isValid);
      const seenRecent=new Set();
      const recent=[...remoteRecent,...localRecent].filter(x=>{
        if(seenRecent.has(x.url))return false;
        seenRecent.add(x.url);return true;
      }).slice(0,30).map(x=>({url:x.url,title:x.title||x.url}));
      try{
        localStorage.setItem('b2b-settings',JSON.stringify(prefs));
        localStorage.setItem('b2b-recent',JSON.stringify(recent));
        localStorage.setItem('b2b-bookmarks',JSON.stringify(bookmarks));
      }catch{}
      render();
      renderBookmarks();
      cloudStatus('XBT cloud data loaded · '+(cloudUser.email||'your account'));
      syncAfterLoad=true;
    }catch(error){
      cloudStatus('Could not sync XBT data: '+(error?.message||'Check browser2browse_* tables and permissions.'));
    }finally{cloudHydrating=false}
    if(syncAfterLoad)queueCloudSave();
  }
  function setCloudSession(session){
    const next=session?.user||null,nextId=next?.id||null,changed=nextId!==cloudLastUserId;
    cloudUser=next;cloudLastUserId=nextId;updateSyncUI();
    if(changed&&cloudUser)queueMicrotask(()=>loadCloudData(cloudUser.id));
  }
  async function initSupabase(){
    const cfg=window.B2B_CONFIG||{};
    if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!window.supabase?.createClient){updateSyncUI();return}
    try{
      supabaseClient=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      supabaseClient.auth.onAuthStateChange((_event,session)=>setCloudSession(session));
      const {data,error}=await supabaseClient.auth.getSession();
      if(error)throw error;
      setCloudSession(data.session);
    }catch(error){supabaseClient=null;cloudStatus('Supabase could not initialise: '+(error?.message||'Check the project URL and publishable key.'));$('syncSignIn').disabled=true}
  }
  async function signInToSync(){
    if(!supabaseClient)return;
    const email=$('syncEmail').value.trim();
    if(!email){cloudStatus('Enter your email address first.');$('syncEmail').focus();return}
    $('syncSignIn').disabled=true;
    try{
      const {error}=await supabaseClient.auth.signInWithOtp({email,options:{emailRedirectTo:new URL('./',location.href).href}});
      if(error)throw error;
      cloudStatus('Sign-in link sent. Open the email on this device to finish signing in.');
    }catch(error){cloudStatus('Could not send sign-in link: '+(error?.message||'Check Supabase Auth settings.'));updateSyncUI()}
  }
  async function signOutOfSync(){
    if(!supabaseClient)return;
    const {error}=await supabaseClient.auth.signOut();
    if(error)cloudStatus('Sign-out failed: '+error.message);
    else cloudStatus('Signed out. Local browsing data remains on this device.');
  }

  function setProgress(on){$('progress').parentElement.classList.toggle('loading',on);if(!on)$('progress').parentElement.classList.add('done');else $('progress').parentElement.classList.remove('done')}
  function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function urlFor(raw){let s=raw.trim();if(!s)return {error:'Enter a website or search query.'};if(/\s/.test(s)||(!s.includes('.')&&!/^https?:\/\//i.test(s)))return {url:engines[prefs.engine](encodeURIComponent(s))};if(!/^https?:\/\//i.test(s))s='https://'+s;try{const u=new URL(s);if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password)return {error:'Enter a valid HTTP or HTTPS address.'};return {url:u.href}}catch{return {error:'That address is not valid. Check it and try again.'}}
  }
  async function request(path,body,method='POST'){if(!api)throw Error('Remote browser service is not configured yet.');if(session&&path==='/api/tabs')path=`/api/sessions/${session.id}/tabs`;else if(session&&path.startsWith('/api/tabs/'))path=`/api/sessions/${session.id}${path.slice(4)}`;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(new DOMException('Request timed out.','TimeoutError')),25_000);try{const r=await fetch(api+path,{method,headers:{'content-type':'application/json','authorization':session?`Bearer ${session.token}`:''},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||`Service request failed (${r.status}).`);return j}catch(e){if(e?.name==='AbortError'||e?.name==='TimeoutError')throw Error('The cloud browser took too long to respond. Retrying automatically…');throw e}finally{clearTimeout(timeout)}}
  function statusError(e){$('newtab').hidden=true;view.hidden=true;$('message').hidden=false;$('message').innerHTML=`<div class="message-card"><div class="message-symbol">!</div><h2>Remote browser unavailable</h2><p>${esc(e.message||'The remote browser service could not be reached.')}</p><p class="host">${api?'The cloud browser could not connect. It may be starting, restarting, or offline, waking up, or not deployed yet.':'The cloud browser endpoint has not been configured yet.'}</p><div class="message-actions"><button class="primary-button" id="retryConnect">Try again</button><a class="secondary-button" href="https://github.com/schoolinoneedition/browse2browse-cloud" target="_blank" rel="noopener">Setup guide ↗</a></div></div>`;$('retryConnect').onclick=()=>{retryCount=0;connect()};status('Service unavailable');setProgress(false)}
  async function connect(){
    if(connectPromise)return connectPromise;
    clearTimeout(retryTimer);
    connectPromise=(async()=>{
      status(retryCount?'Cloud browser is waking up — retrying connection…':'Connecting to remote browser…');
      setProgress(true);
      try{
        if(!api)throw Error('Remote browser service is not configured yet.');
        if(!session)session=await request('/api/sessions',{});
        await new Promise((resolve,reject)=>{
          let ready=false;
          const ws=socket=new WebSocket(wsUrl());
          const readyTimer=setTimeout(()=>{
            if(!ready){ws.close();reject(Error('The remote browser stream did not become ready in time.'))}
          },18_000);
          ws.onopen=()=>{if(session)ws.send(JSON.stringify({type:'auth',token:session.token}))};
          ws.onerror=()=>{
            if(!ready){clearTimeout(readyTimer);ws.close();reject(Error('Could not open the remote browser stream.'))}
          };
          ws.onmessage=e=>{
            let m;try{m=JSON.parse(e.data)}catch{return}
            if(m.type==='ready'){
              ready=true;clearTimeout(readyTimer);retryCount=0;
              tabs=m.tabs||[];activeId=m.activeTabId;render();
              status('Connected to remote Chromium');setProgress(false);resolve();
            }else if(m.type==='frame'){
              if(m.tabId===activeId){view.src=`data:image/jpeg;base64,${m.data}`;view.hidden=false;$('newtab').hidden=true;$('message').hidden=true}
            }else if(m.type==='state'){
              const t=tabs.find(t=>t.id===m.tabId);
              if(t){Object.assign(t,m);renderTabs();if(m.tabId===activeId){$('address').value=m.url||'';status(m.loading?'Loading page…':'Connected');setProgress(m.loading);updateBookmarkButton();if(!m.loading)save()}}
            }else if(m.type==='error'){
              status(m.message||'Navigation failed');showRemoteError(m.message||'Navigation failed.');
            }
          };
          ws.onclose=e=>{
            clearTimeout(readyTimer);
            socket=null;
            if(!ready){
              if(session&&(e.code===4401||e.code===4408))session=null;
              reject(Error(e.code===4401||e.code===4408?'The remote browser session expired while connecting.':'The remote browser stream disconnected before becoming ready.'));
              return;
            }
            if(session&&(e.code===4401||e.code===4408)){
              session=null;retryCount=0;status('Session expired — starting a fresh browser…');retryTimer=setTimeout(connect,500);
            }else if(api&&retryCount<4){
              retryCount++;
              status('Connection interrupted — retry '+retryCount+' of 4…');
              retryTimer=setTimeout(connect,Math.min(1_000*2**Math.max(0,retryCount-1),8_000));
            }else statusError(Error('Connection lost after automatic retries. Check the backend service and try again.'));
          };
        });
      }catch(e){
        if(!api){statusError(e);return}
        if(retryCount<4){
          retryCount++;
          status('Cloud browser is waking up — retry '+retryCount+' of 4…');
          setProgress(true);
          retryTimer=setTimeout(connect,Math.min(1_000*2**Math.max(0,retryCount-1),8_000));
        }else statusError(e);
      }
    })();
    try{return await connectPromise}finally{connectPromise=null}
  }
  function wsUrl(){const u=new URL(api||location.origin);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/stream';u.search='';if(session?.id)u.searchParams.set('sessionId',session.id);return u.href}
  function send(obj){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(obj))}
  function renderTabs(){const strip=$('tabStrip');strip.replaceChildren();tabs.forEach(t=>{const b=document.createElement('button');b.className='tab'+(t.id===activeId?' active':'');b.draggable=true;b.role='tab';b.setAttribute('aria-selected',String(t.id===activeId));b.title=t.title||t.url||'New tab';b.innerHTML=`<span class="tab-favicon">${t.loading?'◌':'◉'}</span><span class="tab-label"></span><span class="tab-close" role="button" aria-label="Close tab" title="Close tab">×</span>`;b.querySelector('.tab-label').textContent=t.title||'New tab';b.onclick=e=>{if(e.target.closest('.tab-close'))closeTab(t.id);else activate(t.id)};b.ondragstart=()=>dragId=t.id;b.ondragover=e=>e.preventDefault();b.ondrop=e=>{e.preventDefault();reorder(dragId,t.id)};strip.append(b)});$('back').disabled=!active()?.canGoBack;$('forward').disabled=!active()?.canGoForward;$('stop').disabled=!active()?.loading;$('address').value=active()?.url||'';updateBookmarkButton();renderBookmarks()}

  function updateBookmarkButton(){
    const button=$('bookmark'),t=active();if(!button)return;
    const saved=!!t?.url&&bookmarks.some(b=>b.url===t.url);
    button.disabled=!t?.url;button.textContent=saved?'★':'☆';
    button.setAttribute('aria-pressed',String(saved));button.title=saved?'Remove bookmark':'Bookmark current page';
  }
  function toggleBookmark(){
    const t=active();if(!t?.url){status('Open a website before bookmarking it.');return}
    const index=bookmarks.findIndex(b=>b.url===t.url);
    if(index>=0){bookmarks.splice(index,1);status('Bookmark removed.')}
    else{bookmarks.unshift({url:t.url,title:t.title||new URL(t.url).hostname,createdAt:new Date().toISOString()});bookmarks=bookmarks.slice(0,100);status('Bookmark saved.')}
    save();renderBookmarks();updateBookmarkButton();
  }
  function renderBookmarks(){
    const root=$('bookmarksList');if(!root)return;root.replaceChildren();
    if(!bookmarks.length){const empty=document.createElement('p');empty.className='bookmark-empty';empty.textContent='No bookmarks saved yet.';root.append(empty);return}
    bookmarks.forEach((item,index)=>{
      const row=document.createElement('div');row.className='bookmark-row';
      const open=document.createElement('button');open.type='button';open.className='bookmark-open';open.textContent=item.title||item.url;open.title=item.url;
      open.onclick=()=>{navigate(item.url);$('settingsPanel').hidden=true};
      const remove=document.createElement('button');remove.type='button';remove.className='bookmark-remove';remove.textContent='×';remove.setAttribute('aria-label','Remove '+(item.title||item.url));
      remove.onclick=()=>{bookmarks.splice(index,1);save();renderBookmarks();updateBookmarkButton()};
      row.append(open,remove);root.append(row);
    });
  }
  function renderHome(){const recent=read('b2b-recent',[]).slice(0,6);$('newtab').innerHTML=`<div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><rect x="3" y="4" width="29" height="24" rx="6" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M9 12h16M9 17h8M21 24l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="9" r="1" fill="currentColor"/></svg></div><div class="brand-name">Browse2Browse</div><div class="brand-caption">A real Chromium browser, running remotely</div><form class="welcome-search" id="welcomeForm"><span class="search-icon">⌕</span><input id="welcomeInput" autocomplete="off" aria-label="Search or enter website address" placeholder="Search or enter a website address"><select id="welcomeEngine" class="engine-select" aria-label="Search engine"><option value="duckduckgo">DuckDuckGo</option><option value="google">Google</option><option value="bing">Bing</option><option value="brave">Brave</option><option value="yahoo">Yahoo</option></select></form><div class="section-label">RECENTLY VISITED</div><div class="recent-sites">${recent.length?recent.map((x,i)=>`<button class="site-shortcut" data-recent="${i}"><span class="site-icon">${esc((new URL(x.url).hostname[0]||'?').toUpperCase())}</span><span class="site-title">${esc(x.title||x.url)}</span><span class="site-url">${esc(new URL(x.url).hostname)}</span></button>`).join(''):'<div class="empty-recent">Recently visited websites will show up here.</div>'}</div><div class="newtab-bottom">Remote sessions are temporary and isolated · <strong>Made by Roy</strong></div>`;$('welcomeEngine').value=prefs.engine;$('welcomeEngine').onchange=e=>{prefs.engine=e.target.value;save()};$('welcomeForm').onsubmit=e=>{e.preventDefault();navigate($('welcomeInput').value)};$('newtab').querySelectorAll('[data-recent]').forEach(b=>b.onclick=()=>navigate(recent[+b.dataset.recent].url))}
  function render(){renderTabs();const t=active();const empty=!t?.url;$('newtab').hidden=!empty;view.hidden=empty;$('message').hidden=true;if(empty)renderHome();document.documentElement.classList.toggle('dark',prefs.theme==='dark'||(prefs.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches));document.documentElement.classList.toggle('no-motion',!prefs.animations);$('browser').classList.toggle('compact',prefs.layout==='compact')}
  async function newTab(){if(!session){await connect();if(!session)return}try{const x=await request('/api/tabs',{url:''});tabs.push(x.tab);activeId=x.tab.id;send({type:'activate',tabId:activeId});render()}catch(e){statusError(e)}}
  async function activate(id){activeId=id;send({type:'activate',tabId:id});render();setProgress(!!active()?.loading)}
  async function navigate(raw){const out=urlFor(raw);if(out.error){showRemoteError(out.error);return}let t=active();if(!t){await newTab();t=active()}try{status('Loading page…');setProgress(true);$('message').hidden=true;await request(`/api/tabs/${encodeURIComponent(t.id)}/navigate`,{url:out.url});t.url=out.url;save();renderTabs()}catch(e){showRemoteError(e.message)}}
  function showRemoteError(msg){$('message').hidden=false;view.hidden=true;$('newtab').hidden=true;$('message').innerHTML=`<div class="message-card"><div class="message-symbol">!</div><h2>Couldn’t load this page</h2><p>${esc(msg)}</p><div class="message-actions"><button class="primary-button" id="retryPage">Try again</button><button class="secondary-button" id="newTabFromError">New tab</button></div></div>`;$('retryPage').onclick=()=>navigate($('address').value);$('newTabFromError').onclick=newTab;setProgress(false)}
  async function closeTab(id){if(tabs.length<=1){try{await request(`/api/tabs/${encodeURIComponent(id)}`)}catch{}tabs=[];activeId=null;await newTab();return}try{await request(`/api/tabs/${encodeURIComponent(id)}`)}catch(e){status(e.message)}tabs=tabs.filter(t=>t.id!==id);if(activeId===id){activeId=tabs[Math.max(0,tabs.length-1)].id;send({type:'activate',tabId:activeId})}render()}
  async function go(action){try{await request(`/api/tabs/${encodeURIComponent(activeId)}/${action}`,{})}catch(e){status(e.message)}}
  async function reorder(from,to){if(!from||from===to)return;const i=tabs.findIndex(t=>t.id===from),j=tabs.findIndex(t=>t.id===to);if(i<0||j<0)return;const [x]=tabs.splice(i,1);tabs.splice(j,0,x);send({type:'reorder',ids:tabs.map(t=>t.id)});renderTabs()}
  function inputFromPointer(e,type){const r=view.getBoundingClientRect();if(!r.width||!r.height)return;send({type:'input',tabId:activeId,event:type,x:(e.clientX-r.left)*view.naturalWidth/r.width,y:(e.clientY-r.top)*view.naturalHeight/r.height,button:e.button})}
  view.addEventListener('pointerdown',e=>{view.focus();inputFromPointer(e,'mousePressed')});view.addEventListener('pointerup',e=>inputFromPointer(e,'mouseReleased'));let pointerPending=false;view.addEventListener('pointermove',e=>{if(pointerPending)return;pointerPending=true;requestAnimationFrame(()=>{pointerPending=false;inputFromPointer(e,'mouseMoved')})});view.addEventListener('wheel',e=>{e.preventDefault();const r=view.getBoundingClientRect();send({type:'input',tabId:activeId,event:'wheel',x:(e.clientX-r.left)*view.naturalWidth/r.width,y:(e.clientY-r.top)*view.naturalHeight/r.height,deltaX:e.deltaX,deltaY:e.deltaY})},{passive:false});view.addEventListener('contextmenu',e=>e.preventDefault());view.tabIndex=0;
  view.addEventListener('keydown',e=>{if(e.key==='Tab')e.preventDefault();send({type:'key',tabId:activeId,key:e.key,code:e.code,modifiers:{alt:e.altKey,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey}})});view.addEventListener('beforeinput',e=>{if(e.data)send({type:'type',tabId:activeId,text:e.data})});
  $('addressForm').onsubmit=e=>{e.preventDefault();navigate($('address').value)};$('clearAddress').onclick=()=>{$('address').value='';$('address').focus()};$('back').onclick=()=>go('back');$('forward').onclick=()=>go('forward');$('reload').onclick=()=>go('reload');$('stop').onclick=()=>go('stop');$('home').onclick=()=>prefs.homepage?navigate(prefs.homepage):(tabs.find(t=>!t.url)?activate(tabs.find(t=>!t.url).id):newTab());$('newTab').onclick=newTab;$('bookmark').onclick=toggleBookmark;
  $('settingsToggle').onclick=()=>{$('settingsPanel').hidden=!$('settingsPanel').hidden};$('closeSettings').onclick=()=>$('settingsPanel').hidden=true;$('fullscreen').onclick=async()=>{try{if(!document.fullscreenElement)await $('browser').requestFullscreen();else await document.exitFullscreen()}catch{status('Fullscreen is not available here')}};document.addEventListener('fullscreenchange',()=>$('fullscreen').title=document.fullscreenElement?'Exit fullscreen':'Fullscreen');
  $('engine').value=prefs.engine;$('homepage').value=prefs.homepage;$('theme').value=prefs.theme;if($('layout'))$('layout').value=prefs.layout;if($('animations'))$('animations').checked=prefs.animations;$('engine').onchange=e=>{prefs.engine=e.target.value;save()};$('homepage').onchange=e=>{prefs.homepage=e.target.value.trim();save()};$('theme').onchange=e=>{prefs.theme=e.target.value;save();render()};if($('layout'))$('layout').onchange=e=>{prefs.layout=e.target.value;save();render()};if($('animations'))$('animations').onchange=e=>{prefs.animations=e.target.checked;save();render()};$('syncSignIn').onclick=signInToSync;$('syncSignOut').onclick=signOutOfSync;$('clearData').onclick=async()=>{if(confirm('Clear local preferences, recent sites, bookmarks, and the remote browser session?')){if(supabaseClient&&cloudUser){const cleared=await Promise.all([supabaseClient.from('browser2browse_bookmarks').delete().eq('user_id',cloudUser.id),supabaseClient.from('browser2browse_history').delete().eq('user_id',cloudUser.id)]);const failure=cleared.find(x=>x.error);if(failure)cloudStatus('Some XBT cloud history could not be cleared: '+failure.error.message)}localStorage.removeItem('b2b-settings');localStorage.removeItem('b2b-recent');localStorage.removeItem('b2b-bookmarks');bookmarks=[];if(session)await request('/api/sessions/'+session.id,undefined,'DELETE').catch(()=>{});if(socket)socket.onclose=null;socket?.close();socket=null;session=null;tabs=[];activeId=null;prefs={...defaults};save();render();renderBookmarks();connect()}};
  $('clearHistory').onclick=()=>{try{localStorage.setItem('b2b-recent','[]')}catch{};if(supabaseClient&&cloudUser)supabaseClient.from('browser2browse_history').delete().eq('user_id',cloudUser.id).then(({error})=>{if(error)cloudStatus('Local history cleared; cloud history could not be cleared: '+error.message)});renderHome();$('historyList').innerHTML='<p class="empty-state">No recent sites yet.</p>';save();status('Recent sites cleared.')};
  $('clearSession').onclick=async()=>{if(session){await request('/api/sessions/'+session.id,undefined,'DELETE').catch(()=>{});session=null}socket?.close();socket=null;tabs=[];activeId=null;render();status('Remote session ended.');connect()};
  document.addEventListener('keydown',e=>{const mod=e.ctrlKey||e.metaKey;if(mod&&e.key.toLowerCase()==='t'){e.preventDefault();newTab()}else if(mod&&e.key.toLowerCase()==='w'){e.preventDefault();closeTab(activeId)}else if(mod&&e.key.toLowerCase()==='l'){e.preventDefault();$('address').focus();$('address').select()}else if(mod&&e.key.toLowerCase()==='r'){e.preventDefault();go('reload')}else if(e.altKey&&e.key==='ArrowLeft'){e.preventDefault();go('back')}else if(e.altKey&&e.key==='ArrowRight'){e.preventDefault();go('forward')}else if(e.key==='Escape'){if(!$('settingsPanel').hidden){$('settingsPanel').hidden=true}}else if(mod&&e.key==='Tab'){e.preventDefault();const i=tabs.findIndex(t=>t.id===activeId);activate(tabs[(i+(e.shiftKey?tabs.length-1:1))%tabs.length]?.id)}});
  window.addEventListener('beforeunload',()=>socket?.close());
  new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r&&r.width>0&&r.height>0)send({type:'resize',tabId:activeId,width:Math.round(r.width),height:Math.round(r.height)})}).observe($('viewport'));
  renderHome();renderBookmarks();$('newtab').hidden=false;initSupabase();connect();
})();

