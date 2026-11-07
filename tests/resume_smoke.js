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
  var settings={},queue=['test@example.org','password123'],renders=[],urls=[];
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
    openedOnline=0,selectedOnline=[],seededRoad=null,onlineMode=false;
  var anchor={length:1,last:function(){return this;},
    after:function(b){sourceButton=b;sourceEntries.push(b);sourceMenuPosition='after Torrent';}};
  var playAnchor={length:1,first:function(){return this;},after:function(b){button=b;}};
  var cardToolbar={length:1,last:function(){return this;},find:function(sel){
    return sel==='.button--play'?playAnchor:empty;},
    prepend:function(b){button=b;}};
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
    if(sel==='.full-start-new__buttons')return cardToolbar;
    if(sel==='.view--online')return onlineAnchor;
    if(sel==='.view--lsp-resume')return {remove:function(){button=null;}};
    if(sel==='.view--lsp-resume-source')return {remove:function(){sourceEntries=[];sourceButton=null;}};
    return empty;
  }};
  function dom(html){
    if(html && html.nodeMock)return html;
    if(String(html).indexOf('view--lsp-resume')!==-1){
      var obj={html:html,attrs:{},value:'',
        find:function(sel){if(sel==='span')return {text:function(t){obj.value=t;return this;}};return empty;},
        attr:function(k,v){this.attrs[k]=v;return this;},
        on:function(k,cb){this[k]=cb;return this;}};
      return obj;
    }
    return empty;
  }
  var win={
    appready:true,crypto:{getRandomValues:function(arr){
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
        set:function(k,v){storage[k]=v;}},
      Activity:{active:function(){return onlineMode?{component:'lampac',activity:{render:function(){return onlinePanel;}}}:null;}},
      Noty:{show:function(){}},
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
  new Function('window','XMLHttpRequest','setTimeout','clearTimeout','setInterval','clearInterval',
    source)(win,FakeXHR,function(){return 1;},function(){},function(){return 2;},function(){});
  settings.lsp_login.onChange();
  var movie={id:7000,source:'tmdb',media_type:'tv',name:'Mock TV',first_air_date:'2000-01-01'};
  function showCard(){
    app.emit('full',{type:'complite',data:{movie:movie},body:root});
  }
  showCard();
  assert(!!button,'cloud resume button appears directly on the card toolbar');
  assert(!!sourceButton && sourceEntries.length===1,
    'source picker contains one Continue entry');
  assert(sourceMenuPosition==='after Torrent',
    'source Continue is placed directly after Torrents');
  assert(sourceButton !== button &&
    sourceButton.html.indexOf('view--lsp-resume-source')!==-1,
    'source picker and visible card buttons are distinct DOM elements');
  assert(button.html.indexOf('<svg')!==-1 &&
    button.attrs['aria-label'].indexOf('Продолжить')!==-1,
    'visible action has an icon, description and accessible label');
  assert(button.html.indexOf('view--lsp-resume')!==-1,
    'card action uses its own class, separate from native source selection');
  assert(typeof button['hover:enter']==='function','button has action');
  assert(button.value.indexOf('С2E5')!==-1 && button.value.indexOf('18:40')!==-1,
    'button labels the episode and timecode');
  button['hover:enter']();
  assert(!!played,'native player launch called');
  played=null;
  sourceButton['hover:enter']();
  assert(!!played && played.id===4,'source picker Continue uses the same native torrent resume');
  assert(sourceEntries.length===1,'source picker has no duplicate after activation');
  assert(played.id===4,'correct torrent file selected');
  assert(played.timeline.time===1120,'resume timecode transferred into timeline');
  assert(Array.isArray(playlist)&&playlist.length===2,'playlist preserved');
  assert(!urls.some(function(u){return u.indexOf('/stream?link=')!==-1;}),
    'video traffic never goes to Supabase');
  // Completion advances only to a real following episode in this playlist.
  rec.watched_state='completed';
  showCard();
  assert(!!button && !!sourceButton,'both buttons remain after completed episode');
  assert(sourceEntries.length===1,'card refresh never duplicates the source menu entry');
  button['hover:enter']();
  assert(played.id===5,'completed episode advances to next file');
  assert(played.timeline.time===0,'next episode starts from zero');
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
