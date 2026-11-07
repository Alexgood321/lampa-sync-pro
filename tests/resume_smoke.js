/*
 * Offline UI test for card resume / TorrServer file resolution.
 * Run: node tests/resume_smoke.js after checkout.
 */
function runResumeSmoke(source) {
  'use strict';
  var passed=0;
  function assert(ok,msg){if(!ok)throw new Error('FAIL '+msg);passed++;}
  function emitter(){
    var m={};
    return {follow:function(n,fn){(m[n]||(m[n]=[])).push(fn);},
      remove:function(n,fn){m[n]=(m[n]||[]).filter(function(f){return f!==fn;});},
      emit:function(n,v){(m[n]||[]).slice().forEach(function(f){f(v);});}};
  }
  var settings={},queue=['test@example.org','password123'],renders=[],urls=[],
    styleNodes=[],styleById={},
    timers=[],selectedUI=null,openedTorrents=[],nativeFocused=[],scrollTargets=[],
    androidMode=false,internalTorrent=true;
  var app=emitter(),player=emitter(),video=emitter(),tl=emitter();
  var rec={episode_key:'s2:e5',source_key:'torrent:0123456789ABCDEF0123456789ABCDEF01234567:4',
    source_kind:'torrent',source_recipe:{infohash:'0123456789ABCDEF0123456789ABCDEF01234567',
      file_index:4,file_path:'S02E05.mkv'},position_seconds:1120,
    duration_seconds:2700,watched_state:'in_progress',revision:1};
  var torrentItems=[
    {id:4,path:'S02E05.mkv',path_human:'S02E05.mkv'},
    {id:5,path:'S02E06.mkv',path_human:'S02E06.mkv'}
  ];
  var button=null,sourceButton=null,sourceEntries=[],sourceMenuPosition='',
    played=null,playlist=null,random=0,db={},storage={},
    cardOrder=['native-play','hdrezka-play'],resumeScope=false,
    openedOnline=0,selectedOnline=[],seededRoad=null,onlineMode=false;
  function visualOrder() {
    var rank={'sync-resume':-3,'native-play':-2,'hdrezka-play':-1};
    return cardOrder.slice().sort(function(a,b){return rank[a]-rank[b];}).join(',');
  }
  var fakeDocument={
    head:{appendChild:function(el){styleNodes.push(el);styleById[el.id]=el;}},
    getElementById:function(id){return styleById[id] || null;},
    createElement:function(tag){return {tagName:tag,textContent:''};}
  };
  var anchor={length:1,last:function(){return this;},
    after:function(b){sourceButton=b;sourceEntries.push(b);sourceMenuPosition='after Torrent';}};
  var playAnchor={length:1,first:function(){return this;},after:function(b){button=b;}};
  var cardToolbar={length:1,last:function(){return this;},find:function(sel){
    return sel==='.button--play'?playAnchor:empty;},
    prepend:function(b){button=b;cardOrder.unshift('sync-resume');},
    addClass:function(s){if(s==='lsp-has-resume')resumeScope=true;return this;},
    removeClass:function(s){if(s==='lsp-has-resume')resumeScope=false;return this;}};
  var empty={length:0,last:function(){return this;},remove:function(){},append:function(){},trigger:function(){}};
  var onlineAnchor={length:1,last:function(){return this;},trigger:function(e){if(e==='hover:enter'){openedOnline++;onlineMode=true;}return this;}};
  function onlineEpisode(num) {
    return {nodeMock:true,number:num,find:function(selector){
      if(selector==='.online-prestige__episode-number')
        return {text:function(){return String(num);}};
      if(selector==='.time-line')
        return {attr:function(){return 'online-hash-'+num;}};
      return empty;
    },trigger:function(type){if(type==='hover:enter')selectedOnline.push(num);return this;}};
  }
  var episodeNodes=[onlineEpisode(5),onlineEpisode(6)];
  var episodeList={length:2,each:function(fn){episodeNodes.forEach(function(n,i){fn(i,n);});}};
  var onlinePanel={find:function(selector){return selector==='.online-prestige--full'?episodeList:empty;}};
  var sourceMenu={length:1,last:function(){return this;},
    prepend:function(b){sourceButton=b;sourceEntries.push(b);sourceMenuPosition='before sources';}};
  var root={find:function(sel){
    if(sel==='.view--torrent' || sel==='.buttons--container > .view--torrent')return anchor;
    if(sel==='.buttons--container')return sourceMenu;
    if(sel==='.full-start-new__buttons' ||
      sel==='.full-start-new__buttons, .full-start__buttons')return cardToolbar;
    if(sel==='.view--online')return onlineAnchor;
    if(sel==='.view--lsp-resume')return {remove:function(){
      button=null;cardOrder=cardOrder.filter(function(x){return x!=='sync-resume';});
    }};
    if(sel==='.view--lsp-resume-source')return {remove:function(){sourceEntries=[];sourceButton=null;}};
    return empty;
  }};
  function dom(html){
    if(html && html.nodeMock)return html;
    if(String(html).indexOf('torrent-files')!==-1) {
      return {length:1,items:[],kind:'torrent-files',hasClass:function(x){return x==='torrent-files';},
        append:function(row){this.items.push(row);return this;}};
    }
    if(String(html).indexOf('view--lsp-resume')!==-1){
      var obj={html:html,attrs:{},value:'',
        find:function(sel){
          if(sel==='span')return {text:function(t){obj.value=t;return this;}};
          if(sel==='.lsp-resume-episode')return {text:function(t){obj.episode=t;return this;}};
          return empty;
        },
        attr:function(k,v){this.attrs[k]=v;return this;},
        on:function(k,cb){this[k]=cb;return this;}};
      return obj;
    }
    return empty;
  }
  var win={
    appready:true,document:fakeDocument,crypto:{getRandomValues:function(arr){
      random++;for(var i=0;i<arr.length;i++)arr[i]=random*11+i*17;return arr;}},
    localStorage:{getItem:function(k){return db[k]||null;},
      setItem:function(k,v){db[k]=v;}},
    addEventListener:function(){},removeEventListener:function(){},$:dom,
    Lampa:{
      Listener:app,
      Player:{listener:player,play:function(x){played=x;},playlist:function(x){playlist=x;}},
      PlayerVideo:{listener:video},
      Timeline:{listener:tl,view:function(hash){return {hash:hash,time:0,duration:2700,
        percent:0,handler:function(){}};},
        update:function(road){seededRoad=road;}},
      Storage:{get:function(k,def){return Object.prototype.hasOwnProperty.call(storage,k)?storage[k]:def;},
        set:function(k,v){storage[k]=v;},
        field:function(k){return k==='internal_torrclient' ? internalTorrent : false;}},
      Activity:{active:function(){return onlineMode?{component:'lampac',activity:{render:function(){return onlinePanel;}}}:null;}},
      Noty:{show:function(){}},
      Platform:{is:function(k){return k==='android'&&androidMode;}},
      Torrent:{open:function(hash,card){openedTorrents.push({hash:hash,card:card});}},
      Select:{show:function(params){selectedUI=params;}},
      Controller:{enabled:function(){return {name:'modal'};},
        collectionFocus:function(item,viewport){nativeFocused.push(item);}},
      Modal:{scroll:function(){return {
        render:function(){return {0:{contains:function(){return true;}}};},
        update:function(item){scrollTargets.push(item);}
      };}},
      SettingsApi:{addComponent:function(){},addParam:function(x){settings[x.param.name]=x;}},
      Input:{edit:function(o,cb){cb(queue.shift());}},
      Torserver:{
        files:function(hash,yes,no){yes({file_stats:torrentItems});},
        hash:function(d,yes,no){yes({hash:'0123456789ABCDEF0123456789ABCDEF01234567'});},
        parse:function(d){var m=d.path.match(/S(\d+)E(\d+)/);return{
          hash:'hash-'+d.path,season:Number(m[1]),episode:Number(m[2])};},
        stream:function(path,hash,index){return 'https://torrserver.example/stream?link='+hash+'&index='+index;}
      }
    }
  };
  function FakeXHR(){this.headers={};}
  FakeXHR.prototype.open=function(method,url){this.method=method;this.url=url;urls.push(url);};
  FakeXHR.prototype.setRequestHeader=function(k,v){this.headers[k]=v;};
  FakeXHR.prototype.send=function(body){
    var response={};
    if(this.url.indexOf('grant_type=password')!==-1){
      response={user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.org'},
        access_token:'fake_jwt',refresh_token:'fake_refresh',expires_in:3600};
    }else if(this.url.indexOf('lsp_sync_snapshot')!==-1){
      response={status:'ok',revision:0,watch_state:[],source_progress:[],resume_pointers:[]};
    }else if(this.url.indexOf('lsp_get_resume')!==-1){
      response=rec;
    }else if(this.url.indexOf('lsp_sync_push')!==-1){
      response={status:'ok',revision:0,accepted:0,ignored:0,duplicates:0};
    }
    this.status=200;this.responseText=JSON.stringify(response);this.onload();
  };
  function later(fn,ms){var t={fn:fn,ms:ms,active:true};timers.push(t);return t;}
  function cancel(t){if(t)t.active=false;}
  function flushTimer(ms){
    var t=timers.filter(function(x){return x.active&&x.ms===ms;})[0];
    if(!t)throw new Error('Missing expected timer: '+ms);
    t.active=false;t.fn();
  }
  new Function('window','XMLHttpRequest','setTimeout','clearTimeout','setInterval','clearInterval',
    source)(win,FakeXHR,later,cancel,function(){return 2;},function(){});
  settings.lsp_login.onChange();
  var movie={id:7000,source:'tmdb',media_type:'tv',name:'Mock TV',first_air_date:'2000-01-01'};
  function showCard(){
    app.emit('full',{type:'complite',data:{movie:movie},body:root});
  }
  showCard();
  assert(!!button,'cloud resume button appears directly on the card toolbar');
  assert(cardOrder.join(',')==='sync-resume,native-play,hdrezka-play',
    'initial DOM insertion puts Continue first');
  assert(styleNodes.length===1 && styleNodes[0].id==='lsp-card-action-order',
    'one persistent stylesheet is installed for asynchronous priority clones');
  assert(resumeScope && styleNodes[0].textContent.includes('.lsp-has-resume'),
    'priority rules activate only on cards with a Continue action');
  assert(styleNodes[0].textContent.indexOf('.view--lsp-resume{order:-3 !important;}')>=0 &&
    styleNodes[0].textContent.indexOf('.button--play{order:-2 !important;}')>=0 &&
    styleNodes[0].textContent.indexOf('.button--priority{order:-1 !important;}')>=0,
    'flex rules explicitly rank Continue, native Play and pinned source');
  assert(styleNodes[0].textContent.includes('.view--lsp-resume:not(.focus)') &&
    styleNodes[0].textContent.includes('background-color:#168c58 !important;color:#fff !important;'),
    'Continue primary button uses green background and white foreground');
  assert(styleNodes[0].textContent.includes('.view--lsp-resume.focus') &&
    styleNodes[0].textContent.includes('background-color:#fff !important;color:#117b4a !important;'),
    'focused Continue button has readable high-contrast inverted colors');
  assert(styleNodes[0].textContent.includes('width:1.5em !important;height:1.5em !important;'),
    'Continue svg is sized exactly as native Lampa button glyphs');
  assert(!styleNodes[0].textContent.includes('.view--lsp-resume-source:not(.focus)'),
    'native source picker retains its standard Lampa button color');
  // Lampa calls onPriorityButton() later and prepends the source clone,
  // AFTER the resume button was inserted. CSS order must still win.
  cardOrder=cardOrder.filter(function(x){return x!=='hdrezka-play';});
  cardOrder.unshift('hdrezka-play');
  assert(cardOrder[0]==='hdrezka-play' &&
    visualOrder()==='sync-resume,native-play,hdrezka-play',
    'late HDRezka priority clone cannot visually overtake Continue');
  assert(!!sourceButton && sourceEntries.length===1,
    'source picker contains one Continue entry');
  assert(sourceMenuPosition==='after Torrent',
    'source Continue is placed directly after Torrents');
  assert(sourceButton !== button &&
    sourceButton.html.indexOf('view--lsp-resume-source')!==-1,
    'source picker and visible card buttons are distinct DOM elements');
  assert(button.html.indexOf('<svg viewBox="0 0 32 32"')!==-1 &&
    button.html.includes('stroke-width="2.7"') &&
    button.html.includes('m13 11 9 5-9 5z') &&
    button.attrs['aria-label'].indexOf('Продолжить')!==-1,
    'Continue has a full-size play-and-resume SVG with an accessible label');
  assert(sourceButton.html.includes('viewBox="0 0 32 32"'),
    'menu entry uses the same balanced SVG');
  assert(button.html.indexOf('view--lsp-resume')!==-1,
    'card action uses its own class, separate from native source selection');
  assert(typeof button['hover:enter']==='function','button has action');
  assert(button.value.indexOf('С2E5')!==-1 && button.value.indexOf('18:40')!==-1,
    'button labels the episode and timecode');
  assert(button.episode==='S02E05',
    'season and episode are visible on mobile without relying on a hidden span');
  assert(!sourceButton.html.includes('lsp-resume-episode') &&
    sourceButton.value.includes('С2E5'),
    'source menu uses only the full label, without duplicate episode badge');
  button['hover:enter']();
  assert(openedTorrents.length===1,'Continue opens native torrent file cards');
  assert(played===null,'Continue never autoplays the saved episode');
  assert(openedTorrents[0].hash===rec.source_recipe.infohash,
    'same saved torrent infohash is used');
  var savedItem={0:{offsetParent:{}}},savedNativeRoad={hash:'native-hash',time:0,duration:0,percent:0};
  app.emit('torrent_file',{type:'render',element:{id:4,path:'S02E05.mkv',
    season:2,episode:5,torrent_hash:rec.source_recipe.infohash,timeline:savedNativeRoad},
    item:savedItem,params:{movie:movie}});
  flushTimer(80);
  assert(nativeFocused[0]===savedItem && scrollTargets[0]===savedItem,
    'native file list focuses and scrolls to the saved episode');
  assert(savedNativeRoad.time===1120 && savedNativeRoad.duration===2700,
    'cloud checkpoint is added only to chosen player item, not global Timeline');
  assert(played===null,'focusing a series row does not launch playback');
  sourceButton['hover:enter']();
  assert(openedTorrents.length===2,'source menu Continue opens the same torrent cards');
  var beforeFocus=nativeFocused.length;
  app.emit('torrent_file',{type:'render',element:{id:4,path:'S02E05.mkv',
    season:2,episode:5,torrent_hash:'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'},
    item:{0:{offsetParent:{}}},params:{movie:movie}});
  assert(nativeFocused.length===beforeFocus &&
    !timers.some(function(t){return t.active&&t.ms===80;}),
    'event from a different torrent cannot steal file-list focus');
  app.emit('torrent_file',{type:'render',element:{id:5,path:'S02E06.mkv',
    season:2,episode:6,torrent_hash:rec.source_recipe.infohash},
    item:{0:{offsetParent:{}}},params:{movie:movie}});
  assert(!timers.some(function(t){return t.active&&t.ms===80;}),
    'next episode does not override saved-episode selection');
  assert(sourceEntries.length===1,'source menu has no duplicates');
  rec.watched_state='completed';
  showCard();
  assert(!!button && !!sourceButton,'both buttons remain after completed episode');
  assert(visualOrder()==='sync-resume,native-play,hdrezka-play',
    'card refresh preserves visual order after late pinned source');
  assert(styleNodes.length===1,'card refresh never duplicates the CSS order rules');
  assert(sourceEntries.length===1,'card refresh never duplicates the source entry');
  button['hover:enter']();
  assert(openedTorrents.length===3 && played===null,
    'completed series still offers choice of saved or next episode, not autoplay');
  var completedNativeRoad={time:2500,duration:2700,percent:93};
  app.emit('torrent_file',{type:'render',element:{id:4,path:'S02E05.mkv',
    season:2,episode:5,torrent_hash:rec.source_recipe.infohash,timeline:completedNativeRoad},
    item:{0:{offsetParent:{}}},params:{movie:movie}});
  assert(completedNativeRoad.time===0,
    'replaying the completed saved file starts at zero rather than end credits');
  // Android external torrent mode uses native Lampa Select, because
  // Torrent.open would directly run Android.playHash without file selection.
  androidMode=true;internalTorrent=false;
  sourceButton['hover:enter']();
  assert(!!selectedUI && selectedUI.items.length===2,
    'Android external mode offers a file picker instead of playing a hash');
  assert(selectedUI.items[0].selected && !selectedUI.items[1].selected,
    'saved episode is initially highlighted in fallback picker');
  assert(played===null,'fallback picker does not autoplay');
  selectedUI.items[1].onSelect();
  assert(!!played && played.id===5 && played.timeline.time===0,
    'user can select the next episode, which starts at zero');
  selectedUI.items[0].onSelect();
  assert(played.id===4 && played.timeline.time===0,
    'manually replaying completed episode starts at zero');
  rec.watched_state='in_progress';
  showCard();
  sourceButton['hover:enter']();
  selectedUI.items[0].onSelect();
  assert(played.id===4 && played.timeline.time===1120,
    'manually choosing an unfinished episode restores the cloud checkpoint');
  assert(Array.isArray(playlist) && playlist.length===2,
    'fallback picker preserves the native player playlist');
  androidMode=false;internalTorrent=true;
  torrentItems.splice(1,1);
  selectedUI=null;played=null;
  showCard();button['hover:enter']();
  assert(selectedUI && selectedUI.items.length===1 && played===null,
    'a one-file torrent shows a chooser instead of triggering Lampa ten-second autoplay');
  torrentItems.push({id:5,path:'S02E06.mkv',path_human:'S02E06.mkv'});
  assert(!urls.some(function(u){return u.indexOf('/stream?link=')!==-1;}),
    'stream traffic never passes through Supabase');
  androidMode=false;internalTorrent=true;
  // Fast native-style picker: no second files() request or Lampa 2-second timer.
  var fastFilesRequests=0,fastOpened=[],fastUpdates=[],fastRows=[],fastEvents=[],fastTemplates=[],fastModalClosed=false;
  var oldTorFiles=win.Lampa.Torserver.files;
  var nativeOpens=openedTorrents.length;
  win.Lampa.Torserver.files=function(h,yes,no){fastFilesRequests++;oldTorFiles(h,yes,no);};
  win.Lampa.Utils={bytesToSize:function(n){return String(n)+' B';}};
  win.Lampa.Timeline.render=function(){return '<timeline/>';};
  win.Lampa.Timeline.link=function(card,s,e){return {card:card,season:s,episode:e};};
  win.Lampa.Template={get:function(name,file) {
    fastTemplates.push(name);
    var obj={length:1,0:{},file:file,listeners:{},attr:function(){return this;},
      append:function(){return this;},on:function(type,fn){this.listeners[type]=fn;return this;},
      find:function(){return {append:function(){}};}};
    fastRows.push(obj);return obj;
  }};
  app.send=app.emit;
  app.follow('torrent_file',function(e){fastEvents.push(e.type);});
  win.Lampa.Modal.listener=emitter();
  win.Lampa.Modal.listener.follow('update',function(e) {
    if(e.new_html && e.new_html.hasClass('torrent-files'))fastUpdates.push(e.new_html);
  });
  win.Lampa.Modal.open=function(data){fastOpened.push(data);fastModalClosed=false;};
  win.Lampa.Modal.update=function(data){win.Lampa.Modal.listener.emit('update',{new_html:data});};
  win.Lampa.Modal.close=function(){fastModalClosed=true;};
  win.Lampa.Modal.opened=function(){return !fastModalClosed;};
  win.Lampa.Favorite={add:function(){}};
  win.Lampa.Player.callback=function(){};
  win.Lampa.Controller.toggle=function(){};
  selectedUI=null;played=null;
  showCard();
  button['hover:enter']();
  assert(fastFilesRequests===1 && openedTorrents.length===nativeOpens,
    'fast Continue reuses first TorrServer metadata and skips slow native open');
  assert(fastOpened.length===1 && fastUpdates.length===1,
    'fast native-styled file window is visible on the first response');
  assert(fastEvents[0]==='list_open' &&
    fastEvents.filter(function(x){return x==='render';}).length===2,
    'NUM receives native list_open and render events');
  assert(fastTemplates.every(function(x){return x==='torrent_file_serial';}),
    'native torrent-file-serial templates preserved for NUM');
  assert(nativeFocused[nativeFocused.length-1]===fastRows[0] &&
    scrollTargets[scrollTargets.length-1]===fastRows[0],
    'saved episode receives immediate native focus and scroll');
  assert(fastRows[0].file.timeline.time===1120 &&
    fastRows[1].file.timeline.time===0,
    'cloud checkpoint affects saved episode only');
  assert(played===null,'loading the list never autoplays an episode');
  assert(!timers.some(function(t){return t.active&&t.ms===2000;}),
    'no fixed 2000ms wait on fast path');
  fastRows[1].listeners['hover:enter']();
  assert(played && played.id===5 && played.timeline.time===0,
    'following episode can still be started manually');
  fastRows[0].listeners['hover:enter']();
  assert(played && played.id===4 && played.timeline.time===1120 &&
    playlist.length===2,'saved episode resumes with full playlist');
  assert(typeof fastRows[0].listeners['hover:long']==='function' &&
    typeof fastRows[0].listeners['hover:focus']==='function',
    'native focus and NUM-compatible long-press hooks remain');
  fastRows[0].listeners['hover:long']();
  assert(selectedUI && selectedUI.items.length===2,
    'native long-press still offers timeline actions');
  fastOpened[0].onBack();
  assert(fastModalClosed && fastEvents[fastEvents.length-1]==='list_close',
    'closing the fast picker sends NUM-compatible list_close');
  // Safety: if a custom Lampa skin lacks a working torrent template,
  // Continue falls back to the original native picker, without blank UI.
  var previousTemplate=win.Lampa.Template.get;
  var beforeFallback=openedTorrents.length;
  var beforeFastModal=fastOpened.length;
  win.Lampa.Template.get=function(){throw new Error('unavailable template');};
  showCard();
  button['hover:enter']();
  assert(fastFilesRequests===2 && openedTorrents.length===beforeFallback+1,
    'template failure falls back to original native picker');
  assert(fastOpened.length===beforeFastModal,'template failure opens no blank custom modal');
  win.Lampa.Template.get=previousTemplate;
  // A failure during Modal.update must close the partially created modal
  // before invoking the compatibility path, never stack two dialogs.
  var priorUpdate=win.Lampa.Modal.update,prevNativeCount=openedTorrents.length;
  var prevEventCount=fastEvents.filter(function(x){return x==='list_close';}).length;
  win.Lampa.Modal.update=function(){throw new Error('broken modal');};
  showCard();button['hover:enter']();
  assert(fastModalClosed && openedTorrents.length===prevNativeCount+1,
    'modal-render failure closes fast window and restores native picker');
  assert(fastEvents.filter(function(x){return x==='list_close';}).length===prevEventCount+1,
    'exceptional fast window closes NUM list state');
  win.Lampa.Modal.update=priorUpdate;
  // Native Lampac online resume remains part of our own Sync Pro button.
  rec={episode_key:'s2:e5',source_key:'lampac:kodik:88',source_kind:'lampac',
    source_recipe:{balanser:'kodik',voice_id:'88',voice_name:'Studio',
      season_index:1,voice_index:2},
    position_seconds:1120,duration_seconds:2400,watched_state:'in_progress',revision:2};
  showCard();
  assert(!!button && sourceButton && button.value.indexOf('С2E5')>=0,
    'card and source buttons both support Lampac online episodes');
  button['hover:enter']();
  assert(openedOnline===1,'native online action opens');
  assert(selectedOnline[0]===5,'matching online episode auto-selected');
  onlineMode=false;
  sourceButton['hover:enter']();
  assert(selectedOnline[1]===5,'source picker Lampac resume opens matching episode');
  assert(!!seededRoad && seededRoad.hash==='online-hash-5' && seededRoad.time===1120,
    'online resume timeline seeded for the actual selected hash');
  assert(storage.active_balanser==='kodik' && storage.online_balanser==='kodik',
    'native provider preference restored');
  assert(storage.online_choice_kodik[7000].voice_id==='88' &&
    storage.online_choice_kodik[7000].season===1,
    'voice and season choice restored');
  assert(!Object.keys(storage).some(function(key){return key.indexOf('stream_url')>=0;}),
    'no stream URL is stored');
  rec.watched_state='completed';
  onlineMode=false;
  showCard();
  button['hover:enter']();
  assert(selectedOnline[2]===6,'completed online episode advances to the next available episode');
  assert(seededRoad.hash==='online-hash-5','completed next episode does not inherit old timecode');
  rec.watched_state='in_progress';
  rec=null;
  showCard();
  assert(!resumeScope,'card without cloud resume restores the default Lampa button order');
  win.LampaSyncPro.destroy();
  return {passed:passed};
}
if(typeof module!=='undefined'&&module.exports){
  module.exports=runResumeSmoke;
  if(require.main===module){
    var fs=require('fs'),path=require('path');
    var source=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    process.stdout.write('PASS '+runResumeSmoke(source).passed+' resume assertions\n');
  }
}
