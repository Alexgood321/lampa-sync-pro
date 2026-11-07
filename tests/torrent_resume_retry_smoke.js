/*
 * TorrServer can acknowledge add before file_stats become available.
 * Run: node tests/torrent_resume_retry_smoke.js
 */
function runTorrentResumeRetrySmoke(source) {
  'use strict';
  var count=0;
  function ok(v,msg){if(!v)throw new Error('FAIL '+msg);count++;}
  function eventBus(){var handlers={};return{
    follow:function(k,fn){(handlers[k]||(handlers[k]=[])).push(fn);},
    remove:function(k,fn){handlers[k]=(handlers[k]||[]).filter(function(f){return f!==fn;});},
    emit:function(k,x){(handlers[k]||[]).slice().forEach(function(f){f(x);});}
  };}
  function scenario(sequence,addError) {
    var now=100000,clock=[],id=0,reads=0,adds=0,plays=0,menus=0,notes=[],button=null;
    var bus=eventBus(),settings={},inputs=['test@example.org','password123'],storage={},random=0;
    function later(fn,ms){var v={id:++id,at:now+Number(ms||0),active:true,fn:fn};clock.push(v);return v;}
    function clear(t){if(t)t.active=false;}
    function advance(ms) {
      var finish=now+ms,n=0;
      while(n++<100) {
        var next=clock.filter(function(x){return x.active&&x.at<=finish;})
          .sort(function(a,b){return a.at-b.at||a.id-b.id;})[0];
        if(!next)break;
        now=next.at;next.active=false;next.fn();
      }
      if(n>=100)throw Error('Runaway retry timer');
      now=finish;
    }
    function DateMock(){}
    DateMock.now=function(){return now;};
    var empty={length:0,last:function(){return this;},remove:function(){}};
    var anchor={length:1,first:function(){return this;},after:function(x){button=x;}};
    var toolbar={length:1,last:function(){return this;},
      find:function(key){return key==='.button--play'?anchor:empty;}};
    var root={find:function(key){return key==='.full-start-new__buttons'?toolbar:empty;}};
    function dom(html){
      if(String(html).indexOf('view--lsp-resume')<0)return empty;
      var b={find:function(){return{text:function(){return this;}};},
        attr:function(){return b;},on:function(k,fn){b[k]=fn;return b;}};
      return b;
    }
    var movie={id:985,source:'tmdb',media_type:'tv',name:'TV',first_air_date:'2026-01-01'};
    var resume={episode_key:'s1:e2',source_kind:'torrent',
      source_recipe:{infohash:'0123456789ABCDEF0123456789ABCDEF01234567',
        file_index:2,file_path:'S01E02.mkv'},position_seconds:0,
      duration_seconds:0,watched_state:'in_progress',revision:1};
    var win={appready:true,$:dom,
      crypto:{getRandomValues:function(x){random++;for(var i=0;i<x.length;i++)x[i]=(i*17+random*11)&255;return x;}},
      localStorage:{getItem:function(k){return storage[k]||null;},setItem:function(k,v){storage[k]=v;}},
      addEventListener:function(){},removeEventListener:function(){},
      Lampa:{
        Listener:bus,Player:{listener:eventBus(),play:function(){plays++;},playlist:function(){}},
        PlayerVideo:{listener:eventBus()},Timeline:{listener:eventBus(),view:function(){
          return{handler:function(){},percent:0,time:0,duration:0};}},
        Storage:{get:function(k,d){return d;},set:function(){}},
        SettingsApi:{addComponent:function(){},addParam:function(v){settings[v.param.name]=v;}},
        Input:{edit:function(o,cb){cb(inputs.shift());}},
        Noty:{show:function(msg){notes.push(msg);}},
        Select:{show:function(opts){menus++;}},
        Torserver:{
          files:function(h,success,fail) {
            var state=sequence[Math.min(reads++,sequence.length-1)];
            if(state==='error')return fail({status:503});
            if(state==='empty')return success({file_stats:[]});
            if(state==='silent')return;
            return success({file_stats:[{id:2,path:'S01E02.mkv'}]});
          },
          hash:function(o,success,fail){adds++;if(addError)fail('Already exists');else success({});},
          parse:function(f){return{hash:'timeline-hash',season:1,episode:2};},
          stream:function(){return'/local/stream';}
        }
      }
    };
    function FakeXHR(){}
    FakeXHR.prototype.open=function(m,url){this.url=url;};
    FakeXHR.prototype.setRequestHeader=function(){};
    FakeXHR.prototype.send=function(){
      var value={};
      if(this.url.indexOf('grant_type=password')>=0)value={
        user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.org'},
        access_token:'jwt',refresh_token:'refresh',expires_in:3600};
      if(this.url.indexOf('lsp_sync_snapshot')>=0)value={
        status:'ok',revision:1,source_progress:[],watch_state:[],resume_pointers:[]};
      if(this.url.indexOf('lsp_get_resume')>=0)value=resume;
      this.status=200;this.responseText=JSON.stringify(value);this.onload();
    };
    new Function('window','XMLHttpRequest','setTimeout','clearTimeout',
      'setInterval','clearInterval','Date',source)(
      win,FakeXHR,later,clear,function(){return{};},function(){},DateMock);
    settings.lsp_login.onChange();
    bus.emit('full',{type:'complite',data:{movie:movie},body:root});
    return {click:function(){if(!button)throw Error('Button absent');button['hover:enter']();},
      advance:advance,destroy:function(){win.LampaSyncPro.destroy();},
      reads:function(){return reads;},adds:function(){return adds;},
      plays:function(){return plays;},menus:function(){return menus;},notes:function(){return notes;}};
  }
  var cold=scenario(['error','error','empty','ok'],false);
  cold.click();
  ok(cold.reads()===1,'first click starts TorrServer read');
  cold.advance(549);ok(cold.reads()===1,'read is not retried prematurely');
  cold.advance(1);ok(cold.reads()===2&&cold.adds()===1,'retry then single hash add');
  cold.advance(1200);ok(cold.reads()===4&&cold.menus()===1 && cold.plays()===0,
    'first click recovers to file selection once metadata become ready, without autoplay');
  ok(!cold.notes().some(function(n){return n.indexOf('Не удалось загрузить файлы')>=0;}),
    'no premature failed-files warning');
  cold.destroy();

  var duplicate=scenario(['error','error','ok'],false);
  duplicate.click();duplicate.click();
  ok(duplicate.reads()===1,'double tap starts only one resume flow');
  duplicate.advance(2000);
  ok(duplicate.menus()===1 && duplicate.plays()===0,
    'only one file selector opens after repeated tapping');
  duplicate.destroy();

  var hashError=scenario(['error','error','ok'],true);
  hashError.click();hashError.advance(2000);
  ok(hashError.adds()===1&&hashError.menus()===1&&hashError.plays()===0,
    'hash add failure is not fatal if metadata becomes available');
  hashError.destroy();

  var missing=scenario(['error'],true);
  missing.click();missing.advance(20000);
  ok(missing.reads()===7&&missing.adds()===1,
    'bounded total file reads and at most one hash add');
  ok(missing.plays()===0&&missing.menus()===0&&missing.notes().filter(function(n){
    return n.indexOf('Не удалось загрузить файлы')>=0;}).length===1,
    'final error appears only after retries are exhausted');
  missing.destroy();

  var canceled=scenario(['error','ok'],false);
  canceled.click();canceled.destroy();canceled.advance(20000);
  ok(canceled.reads()===1&&canceled.menus()===0&&canceled.plays()===0,
    'destroy cancels retry before opening a chooser or starting a video');
  return {passed:count};
}
if(typeof module!=='undefined'&&module.exports){
  module.exports=runTorrentResumeRetrySmoke;
  if(require.main===module){
    var fs=require('fs'),path=require('path');
    var source=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    process.stdout.write('PASS '+runTorrentResumeRetrySmoke(source).passed+
      ' TorrServer retry assertions\n');
  }
}
