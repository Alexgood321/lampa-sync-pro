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
  var button=null,played=null,playlist=null,random=0,db={};
  var anchor={length:1,last:function(){return this;},after:function(b){button=b;}};
  var empty={length:0,last:function(){return this;},remove:function(){},append:function(){}};
  var root={find:function(sel){
    if(sel==='.view--torrent')return anchor;
    if(sel==='.view--lsp-resume')return empty;
    return empty;
  }};
  function dom(html){
    if(String(html).indexOf('view--lsp-resume')!==-1){
      var obj={text:function(t){this.value=t;return this;},
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
        percent:0,handler:function(){}};}},
      Storage:{get:function(k,def){return def;},set:function(){}},
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
  assert(!!button,'cloud resume button appears');
  assert(typeof button['hover:enter']==='function','button has action');
  assert(button.value.indexOf('С2E5')!==-1 && button.value.indexOf('18:40')!==-1,
    'button labels the episode and timecode');
  button['hover:enter']();
  assert(!!played,'native player launch called');
  assert(played.id===4,'correct torrent file selected');
  assert(played.timeline.time===1120,'resume timecode transferred into timeline');
  assert(Array.isArray(playlist)&&playlist.length===2,'playlist preserved');
  assert(!urls.some(function(u){return u.indexOf('/stream?link=')!==-1;}),
    'video traffic never goes to Supabase');
  // Completion advances only to a real following episode in this playlist.
  rec.watched_state='completed';
  showCard();
  assert(!!button,'button remains after completed episode');
  button['hover:enter']();
  assert(played.id===5,'completed episode advances to next file');
  assert(played.timeline.time===0,'next episode starts from zero');
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
