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
      var obj={html:html,attrs:{},value:'',classes:{},
        addClass:function(name){this.classes[name]=true;return this;},
        removeClass:function(name){delete this.classes[name];return this;},
        hasClass:function(name){return !!this.classes[name];},
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
      Modal:{listener:emitter(),scroll:function(){return {
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
  function nativeListShown(){
    win.Lampa.Modal.listener.emit('update',{
      new_html:{hasClass:function(name){return name==='torrent-files';}}
    });
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
  assert(button.html.indexOf('<svg class="lsp-resume-glyph" viewBox="0 0 32 32"')!==-1 &&
    button.html.includes('stroke-width="2.7"') &&
    button.html.includes('m13 11 9 5-9 5z') &&
    button.attrs['aria-label'].indexOf('Продолжить')!==-1,
    'Continue has a full-size play-and-resume SVG with an accessible label');
  assert(sourceButton.html.includes('class="lsp-resume-glyph" viewBox="0 0 32 32"'),
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
  assert(button.html.includes('class="lsp-resume-spinner"') &&
    button.html.includes('class="lsp-resume-glyph"') &&
    styleNodes[0].textContent.includes('@keyframes lsp-resume-spin'),
    'spinner replaces SVG while keeping the episode label and icon dimensions');
  button['hover:enter']();
  assert(button.hasClass('lsp-resume-loading') &&
    sourceButton.hasClass('lsp-resume-loading') &&
    button.attrs['aria-busy']==='true' &&
    button.episode==='S02E05',
    'loading immediately appears on both button surfaces without hiding episode');
  button['hover:enter']();
  assert(openedTorrents.length===1,
    'Continue opens torrent cards once; repeated clicks while pending are ignored');
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
  assert(!button.hasClass('lsp-resume-loading') &&
    button.attrs['aria-busy']==='false',
    'native picker readiness stops spinner on the actual successful focus');
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
  assert(sourceButton.hasClass('lsp-resume-loading'),
    'native picker loading stays visible until file list is actually drawn');
  nativeListShown();
  assert(!sourceButton.hasClass('lsp-resume-loading'),
    'native modal update releases pending loading state');
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
  nativeListShown();
  // Android external torrent mode uses native Lampa Select, because
  // Torrent.open would directly run Android.playHash without file selection.
  androidMode=true;internalTorrent=false;
  sourceButton['hover:enter']();
  assert(!!selectedUI && selectedUI.items.length===2,
    'Android external mode offers a file picker instead of playing a hash');
  assert(!button.hasClass('lsp-resume-loading'),
    'native Select dialog stops loading immediately after rendering');
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
  win.Lampa.Utils={bytesToSize:function(n){return String(n)+' B';},
    parseTime:function(x){return {full:'Дата '+x};}};
  win.Lampa.Timeline.render=function(){return '<timeline/>';};
  win.Lampa.Timeline.link=function(card,s,e){return {card:card,season:s,episode:e};};
  win.Lampa.Template={get:function(name,file) {
    fastTemplates.push(name);
    var titleNode={value:'',text:function(v){this.value=v;return this;}};
    var dateNode={value:'',text:function(v){this.value=v;return this;}};
    var imgNode={length:1,attrs:{},0:{},addClass:function(){return this;},
      attr:function(k,v){if(arguments.length===1)return this.attrs[k];this.attrs[k]=v;return this;}};
    var obj={length:1,0:{},file:file,titleNode:titleNode,dateNode:dateNode,
      imgNode:imgNode,listeners:{},attr:function(){return this;},
      append:function(){return this;},on:function(type,fn){this.listeners[type]=fn;return this;},
      find:function(sel){
        if(sel==='.torrent-serial__title')return titleNode;
        if(sel==='.torrent-serial__line span')return {last:function(){return dateNode;}};
        if(sel==='img')return imgNode;
        return {append:function(){}};
      }};
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
  var seasonCall=null,seasonRequests=0,seasonNumbers=[];
  win.Lampa.Api={img:function(path){return 'https://image.tmdb.org/t/p/w500'+path;},
    seasons:function(movie,numbers,done){seasonRequests++;seasonNumbers=numbers;seasonCall=done;}};
  selectedUI=null;played=null;
  showCard();
  button['hover:enter']();
  assert(fastFilesRequests===1 && openedTorrents.length===nativeOpens,
    'fast Continue reuses first TorrServer metadata and skips slow native open');
  assert(fastOpened.length===1 && fastUpdates.length===1,
    'fast native-styled file window is visible on the first response');
  assert(!button.hasClass('lsp-resume-loading'),
    'fast picker stops loading only after Modal.update succeeded');
  assert(seasonRequests===1 && seasonNumbers.length===1 && seasonNumbers[0]===2,
    'season metadata requested asynchronously once after initial file window');
  assert(fastRows[0].titleNode.value==='' && 
    fastRows[0].imgNode.attr('data-src')===undefined,
    'initial file window does not wait for season images to download');
  fastRows[1].listeners['visible']();
  assert(fastRows[1].imgNode.attr('src')==='./img/img_broken.svg',
    'a visible row first has the native placeholder while TMDB is loading');
  seasonCall({2:{episodes:[
    {episode_number:5,name:'Сохранённая серия',still_path:'/still5.jpg',
      air_date:'2026-10-20',runtime:44},
    {episode_number:6,name:'Следующая серия',still_path:'/still6.jpg',
      air_date:'2026-10-27',runtime:42}
  ]}});
  assert(fastRows[0].titleNode.value==='Сохранённая серия' &&
    fastRows[1].titleNode.value==='Следующая серия',
    'TMDB titles hydrate in place on the already visible file rows');
  assert(fastRows[0].dateNode.value==='Выход - Дата 2026-10-20' &&
    fastRows[1].file.air_date==='Дата 2026-10-27',
    'release dates come from TMDB season details');
  assert(fastRows[0].imgNode.attr('data-src')==='https://image.tmdb.org/t/p/w500/still5.jpg' &&
    fastRows[1].file.thumbnail==='https://image.tmdb.org/t/p/w500/still6.jpg',
    'both episode preview stills and thumbnail metadata are restored');
  assert(fastRows[1].imgNode.attr('src')===
    'https://image.tmdb.org/t/p/w500/still6.jpg',
    'already visible preview is replaced without additional scrolling');
  assert(fastRows[0].imgNode.attr('src')===undefined,
    'offscreen episode still remains lazy-loaded, avoiding unnecessary downloads');
  fastRows[0].listeners['visible']();
  assert(fastRows[0].imgNode.attr('src')==='https://image.tmdb.org/t/p/w500/still5.jpg',
    'offscreen preview begins loading when its row enters the viewport');
  assert(seasonRequests===1,'season details are fetched only once per fast picker');

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
  assert(fastRows.every(function(row) {
    return Array.isArray(row.file.playlist) &&
      row.file.playlist.length===2 &&
      row.file.playlist.every(function(entry){return !entry.playlist;});
  }), 'fast player items use independent playlist entries without self-reference');
  assert(JSON.stringify(fastRows[0].file).indexOf('S02E05.mkv')>=0,
    'saved episode player item is JSON-serializable for external players');
  var originalFastPlay=win.Lampa.Player.play;
  win.Lampa.Player.play=function(item) {
    JSON.stringify(item); // External players serialize the item synchronously.
    originalFastPlay(item);
  };
  fastRows[1].listeners['hover:enter']();
  assert(played && played.id===5 && played.timeline.time===0,
    'following episode can still be started manually');
  fastRows[0].listeners['hover:enter']();
  assert(played && played.id===4 && played.timeline.time===1120 &&
    playlist.length===2,'saved episode resumes with full playlist');
  assert(JSON.stringify(played).indexOf('S02E05.mkv')>=0,
    'external player can serialize selected episode and its playlist');
  win.Lampa.Player.play=originalFastPlay;
  assert(typeof fastRows[0].listeners['hover:long']==='function' &&
    typeof fastRows[0].listeners['hover:focus']==='function',
    'native focus and NUM-compatible long-press hooks remain');
  fastRows[0].listeners['hover:long']();
  assert(selectedUI && selectedUI.items.length===2,
    'native long-press still offers timeline actions');
  fastOpened[0].onBack();
  assert(fastModalClosed && fastEvents[fastEvents.length-1]==='list_close',
    'closing the fast picker sends NUM-compatible list_close');
  seasonCall({2:{episodes:[{episode_number:5,name:'Не должна появиться',
    still_path:'/stale.jpg'}]}});
  assert(fastRows[0].titleNode.value==='Сохранённая серия',
    'late season response after closing the modal cannot modify old rows');
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
  assert(button.hasClass('lsp-resume-loading'),'native fallback retains spinner until modal becomes visible');
  nativeListShown();
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
  nativeListShown();
  win.Lampa.Modal.update=priorUpdate;
  // Prefetch metadata while the card is visible, before the first click.
  // This prevents waiting for network roundtrip on normal repeat openings.
  win.Lampa.Torserver.url=function(){return 'http://server-one:8090';};
  var requestsBeforeCache=fastFilesRequests,modalsBeforeCache=fastOpened.length;
  showCard();
  assert(fastFilesRequests===requestsBeforeCache,
    'card draw schedules rather than blocks on TorrServer prefetch');
  flushTimer(180);
  assert(fastFilesRequests===requestsBeforeCache+1,
    'one read-only TorrServer metadata prefetch completes in background');
  button['hover:enter']();
  assert(fastFilesRequests===requestsBeforeCache+1 &&
    fastOpened.length===modalsBeforeCache+1,
    'cached file list opens instantly without another HTTP request');
  fastOpened[fastOpened.length-1].onBack();
  showCard();button['hover:enter']();
  assert(fastFilesRequests===requestsBeforeCache+1,
    'cache is reused for same user/hash/server within 90 seconds');
  fastOpened[fastOpened.length-1].onBack();
  win.Lampa.Torserver.url=function(){return 'http://server-two:8090';};
  showCard();flushTimer(180);
  assert(fastFilesRequests===requestsBeforeCache+2,
    'switching TorrServer invalidates the old in-memory cache');
  button['hover:enter']();
  assert(fastFilesRequests===requestsBeforeCache+2,
    'new TorrServer cached response is reused without a second request');
  fastOpened[fastOpened.length-1].onBack();
  // A hung TorrServer response must release the UI and allow a new click.
  win.Lampa.Torserver.url=function(){return 'http://hung-server:8090';};
  var normalFiles=win.Lampa.Torserver.files;
  win.Lampa.Torserver.files=function(){};
  showCard();
  var stalledButton=button;
  stalledButton['hover:enter']();
  assert(stalledButton.hasClass('lsp-resume-loading'),
    'hung torrent metadata request keeps the busy button visible');
  flushTimer(25000);
  assert(!stalledButton.hasClass('lsp-resume-loading') &&
    stalledButton.attrs['aria-busy']==='false',
    '25-second timeout restores button and cancels active resume job');
  win.Lampa.Torserver.files=normalFiles;
  win.Lampa.Torserver.url=function(){return 'http://server-two:8090';};
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
  assert(!button.hasClass('lsp-resume-loading'),
    'Lampac spinner stops when the selected episode launches');
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
