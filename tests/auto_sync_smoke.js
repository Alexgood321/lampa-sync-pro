/*
 * Cross-device foreground / periodic sync regression.
 * Execute: node tests/auto_sync_smoke.js
 */
function runAutoSyncSmoke(source) {
  'use strict';
  var passed=0,now=1700000000000;
  function check(value,description) {
    if (!value) throw new Error('FAIL '+description);
    passed++;
  }
  function callbacks() {
    var list={};
    return {
      add:function(key,fn){(list[key]||(list[key]=[])).push(fn);},
      remove:function(key,fn){list[key]=(list[key]||[]).filter(function(x){return x!==fn;});},
      fire:function(key){(list[key]||[]).slice().forEach(function(fn){fn();});},
      size:function(key){return (list[key]||[]).length;}
    };
  }
  function emitter() {
    var c=callbacks();
    return {follow:c.add,remove:c.remove};
  }
  var events=callbacks(),documentEvents=callbacks();
  var intervals=[],settings={},db={},requests=[],prompts=['test@example.org','my-password'],random=0;
  function FakeDate(){}
  FakeDate.now=function(){return now;};
  var document={visibilityState:'visible',
    addEventListener:documentEvents.add,removeEventListener:documentEvents.remove};
  var win={
    appready:true,document:document,
    crypto:{getRandomValues:function(bytes) {
      random++;
      for(var i=0;i<bytes.length;i++)bytes[i]=(i*29+random*7)&255;
      return bytes;
    }},
    localStorage:{getItem:function(key){return db[key]||null;},
      setItem:function(key,value){db[key]=value;}},
    addEventListener:events.add,removeEventListener:events.remove,
    Lampa:{
      Listener:emitter(),Player:{listener:emitter()},
      PlayerVideo:{listener:emitter()},Timeline:{listener:emitter()},
      Plugins:{get:function(){return [];},save:function(){}},
      Storage:{get:function(key,def){return def;},set:function(){}},
      SettingsApi:{addComponent:function(){},addParam:function(obj){settings[obj.param.name]=obj;}},
      Input:{edit:function(obj,cb){cb(prompts.shift());}},
      Noty:{show:function(){}}
    }
  };
  function Xhr(){}
  Xhr.prototype.open=function(method,url){this.url=url;};
  Xhr.prototype.setRequestHeader=function(){};
  Xhr.prototype.send=function(data) {
    requests.push(this.url);
    var response={};
    if(this.url.indexOf('grant_type=password')>=0) {
      response={user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.org'},
        access_token:'test-jwt',refresh_token:'test-refresh',expires_in:3600};
    } else if (this.url.indexOf('lsp_sync_snapshot')>=0) {
      response={status:'ok',revision:0,resume_pointers:[],source_progress:[],watch_state:[]};
    } else if (this.url.indexOf('lsp_sync_push')>=0){
      response={status:'ok',revision:0,accepted:0,ignored:0};
    }
    this.status=200;this.responseText=JSON.stringify(response);this.onload();
  };
  function setFakeInterval(fn,delay){intervals.push({fn:fn,delay:delay});return intervals.length;}
  new Function('window','XMLHttpRequest','setTimeout','clearTimeout',
    'setInterval','clearInterval','Date',source)(win,Xhr,function(){return 1;},function(){},
    setFakeInterval,function(){},FakeDate);
  check(intervals.length===1 && intervals[0].delay===30000,
    'cloud polling runs every 30 seconds');
  check(events.size('focus')===1 && events.size('pageshow')===1,
    'window foreground hooks registered');
  check(documentEvents.size('visibilitychange')===1,'visibility hook registered');
  function snaps(){
    return requests.filter(function(url){return url.indexOf('lsp_sync_snapshot')>=0;}).length;
  }
  events.fire('focus');
  check(snaps()===0,'never makes unauthenticated network request');
  settings.lsp_login.onChange();
  check(win.LampaSyncPro.status().authenticated===true,'logged in');
  check(snaps()===2,'first login does a complete cloud pull');
  check(win.LampaSyncPro.status().lastSyncAt===now,'last sync moment recorded');
  events.fire('focus');
  events.fire('pageshow');
  check(snaps()===2,'duplicate immediate foreground events debounced');
  now+=21000;
  events.fire('focus');
  check(snaps()===4,'foreground refreshes cloud after 20s');
  document.visibilityState='hidden';
  now+=21000;
  documentEvents.fire('visibilitychange');
  check(snaps()===4,'background hidden event does not refresh');
  document.visibilityState='visible';
  documentEvents.fire('visibilitychange');
  check(snaps()===6,'visible transition refreshes cloud');
  now+=30000;
  intervals[0].fn();
  check(snaps()===8,'automatic 30-second refresh works');
  document.visibilityState='hidden';
  now+=30000;
  intervals[0].fn();
  check(snaps()===8,'periodic cloud refresh pauses in background');
  document.visibilityState='visible';
  win.LampaSyncPro.destroy();
  check(events.size('focus')===0 && events.size('pageshow')===0,
    'window event listeners cleaned up');
  check(documentEvents.size('visibilitychange')===0,
    'document event listener cleaned up');
  now+=60000;
  events.fire('focus');
  check(snaps()===8,'destroyed instance never syncs again');
  return {passed:passed};
}
if(typeof module!=='undefined' && module.exports) {
  module.exports=runAutoSyncSmoke;
  if(require.main===module) {
    var fs=require('fs'),path=require('path');
    var source=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    process.stdout.write('PASS '+runAutoSyncSmoke(source).passed+' auto-sync assertions\n');
  }
}