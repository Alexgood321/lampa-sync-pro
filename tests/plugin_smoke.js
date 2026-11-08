/*
 * Lampa Sync Pro: deterministic plugin smoke tests, no network or dependencies.
 * Run: node tests/plugin_smoke.js (after cloning repository).
 */
function runPluginTests(source) {
  'use strict';
  var passed=0;
  function check(ok,message) {if(!ok)throw new Error('FAIL: '+message);passed++;}
  function emitter() {
    var registered={};
    return {
      follow:function(type,fn){(registered[type] || (registered[type]=[])).push(fn);},
      remove:function(type,fn){registered[type]=(registered[type]||[]).filter(function(v){return v!==fn;});},
      emit:function(type,data){(registered[type]||[]).slice().forEach(function(fn){fn(data);});}
    };
  }
  var listener=emitter(),playerListener=emitter(),videoListener=emitter(),timelineListener=emitter();
  var settings={}, stored={}, notices=[], requests=[], serverEvents=[], serverRevision=0;
  var registeredDevices=[], renameRequests=[], deviceMenu=null;
  var randomSeq=0, isOnline=true, prompts=['test@example.org','test-secret-password'];
  var local={};
  var installed=[{url:'https://raw.githubusercontent.com/Alexgood321/lampa-sync-pro/main/lampa-sync-pro.js',
    status:1}];
  var savedPluginMetadata=0;
  var fakeWindow={
    appready:true,
    navigator:{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',maxTouchPoints:0},
    crypto:{getRandomValues:function(a){randomSeq++;for(var i=0;i<a.length;i++)a[i]=(i*31+randomSeq*17)&255;return a;}},
    localStorage:{
      getItem:function(k){return Object.prototype.hasOwnProperty.call(local,k)?local[k]:null;},
      setItem:function(k,v){local[k]=String(v);}
    },
    addEventListener:function(){},removeEventListener:function(){},
    Lampa:{
      Listener:listener,
      Plugins:{
        get:function(){return installed;},
        save:function(){savedPluginMetadata++;}
      },
      Player:{listener:playerListener},
      PlayerVideo:{listener:videoListener},
      Timeline:{listener:timelineListener},
      Storage:{
        get:function(k,def){return Object.prototype.hasOwnProperty.call(stored,k)?stored[k]:def;},
        set:function(k,v){stored[k]=v;}
      },
      Noty:{show:function(t){notices.push(String(t));}},
      Select:{show:function(menu){deviceMenu=menu;}},
      SettingsApi:{
        addComponent:function(){},
        addParam:function(p){settings[p.param.name]=p;}
      },
      Input:{edit:function(config,fn){fn(prompts.shift() || '');}}
    }
  };
  function FakeXHR(){this.headers={};this.status=0;this.responseText='';}
  FakeXHR.prototype.open=function(method,url){this.method=method;this.url=url;};
  FakeXHR.prototype.setRequestHeader=function(k,v){this.headers[k.toLowerCase()]=v;};
  FakeXHR.prototype.send=function(body){
    requests.push({method:this.method,url:this.url,body:body,headers:this.headers});
    if(!isOnline){this.onerror();return;}
    var content=body?JSON.parse(body):null, response={};
    if(this.url.indexOf('/auth/v1/token?grant_type=password')!==-1){
      response={user:{id:'11111111-1111-4111-8111-111111111111',email:'test@example.org'},
        access_token:'dummy_access',refresh_token:'dummy_refresh',expires_in:3600};
    }else if(this.url.indexOf('/auth/v1/logout')!==-1) {
      response={};
    }else if(this.url.indexOf('/rest/v1/rpc/lsp_sync_snapshot')!==-1){
      response={status:'ok',revision:serverRevision,watch_state:[],
        source_progress:[],resume_pointers:[]};
    }else if(this.url.indexOf('/rest/v1/rpc/lsp_sync_push')!==-1){
      if(content.p_expected_revision!==serverRevision){
        response={status:'conflict',revision:serverRevision};
      }else{
        var accepted=0,duplicates=0;
        content.p_events.forEach(function(e){
          if(serverEvents.some(function(p){return p.event_id===e.event_id;}))duplicates++;
          else{serverEvents.push(e);accepted++;serverRevision++;}
        });
        response={status:'ok',revision:serverRevision,accepted:accepted,
          ignored:0,duplicates:duplicates};
      }
    }else if(this.url.indexOf('/rest/v1/rpc/lsp_register_device')!==-1){
      registeredDevices.push(content);response={status:'ok',platform:content.p_platform};
    }else if(this.url.indexOf('/rest/v1/rpc/lsp_rename_device')!==-1){
      renameRequests.push(content);response={status:'ok'};
    }else if(this.url.indexOf('/rest/v1/lsp_devices?')!==-1){
      response=[{device_id:fakeWindow.LampaSyncPro.status().device,platform:'mac',
        device_name:'',player:'unknown',last_seen:'2026-11-08T14:00:00Z'},
        {device_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'unknown',
          device_name:'',player:'unknown',last_seen:'2026-11-07T12:00:00Z'}];
    }else if(this.url.indexOf('/rest/v1/rpc/lsp_get_resume')!==-1){
      response=null;
    }else{
      this.status=404;this.responseText='{"code":"not_found"}';this.onload();return;
    }
    this.status=200;
    this.responseText=JSON.stringify(response);
    this.onload();
  };
  var timeoutId=0;
  function delay(fn){timeoutId++;return timeoutId;}
  new Function('window','XMLHttpRequest','setTimeout','clearTimeout','setInterval','clearInterval',
    source)(fakeWindow,FakeXHR,delay,function(){},delay,function(){});
  check(source.indexOf('Lampa.')!==-1,'native Lampa source recognizer marker');
  check(fakeWindow.plugin_lampa_sync_pro_ready===true,'plugin initialized');
  check(installed[0].name==='Lampa Sync Pro' && installed[0].author==='Alexgood321',
    'installed entry identified by plugin itself');
  check(savedPluginMetadata===1,'metadata persisted once, without version churn');
  check(fakeWindow.__AlexgoodPluginRuntime &&
    fakeWindow.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js'].ready===true,
    'running version registered only on successful boot');
  check(fakeWindow.LampaSyncPro.status().ready===true,'storage bootstrap finished');
  check(!!fakeWindow.LampaSyncPro.status().device,'device generated with crypto RNG');
  check(settings.lsp_login && settings.lsp_sync_now && settings.lsp_logout,
    'settings registered');
  check(fakeWindow.LampaSyncPro.status().authenticated===false,'default signed-out');
  settings.lsp_login.onChange();
  check(fakeWindow.LampaSyncPro.status().authenticated===true,'auth sign in');
  check(requests.some(function(r){return r.url.indexOf('/auth/v1/token?grant_type=password')!==-1;}),
    'password-grant REST request');
  check(registeredDevices.length===1 && registeredDevices[0].p_platform==='mac' &&
    registeredDevices[0].p_device_id===fakeWindow.LampaSyncPro.status().device,
    'authenticated Mac automatically registers stable device identity');
  check(settings.lsp_devices && settings.lsp_device_name && settings.lsp_device_player,
    'device directory, self-name and player settings available');
  settings.lsp_devices.onChange();
  check(deviceMenu && deviceMenu.items.length===2 &&
    deviceMenu.items[1].title.includes('Не определено'),
    'old unmapped devices remain explicitly unknown instead of being guessed');
  settings.lsp_device_player.onChange();
  check(deviceMenu.items.some(function(item){return item.player==='vimu';}),
    'optional player labeling requires a user choice');
  check(requests.some(function(r){return r.url.indexOf('/rest/v1/rpc/lsp_sync_snapshot')!==-1;}),
    'bootstrap snapshot');
  var card={source:'tmdb',id:1000,media_type:'tv',name:'Synthetic series',first_air_date:'2000-01-01'};
  var file={card:card,torrent_hash:'0123456789abcdef0123456789abcdef01234567',id:4,
    path:'S02/S02E05.mkv',season:2,episode:5,url:'https://stream.example/stream?link=0123456789abcdef0123456789abcdef01234567',
    timeline:{hash:'hash-test',time:0,duration:2700}};
  listener.emit('torrent_file',{type:'onenter',element:file,params:{movie:card}});
  playerListener.emit('create',{data:file});
  playerListener.emit('start',file);
  videoListener.emit('timeupdate',{current:1120,duration:2700});
  playerListener.emit('destroy',{});
  check(fakeWindow.LampaSyncPro.status().queued===3,'confirmed start, progress and stop queued');
  isOnline=false;
  fakeWindow.LampaSyncPro.sync();
  check(fakeWindow.LampaSyncPro.status().queued===3,'offline queue retained');
  isOnline=true;
  fakeWindow.LampaSyncPro.sync();
  check(fakeWindow.LampaSyncPro.status().queued===0,'queue delivered');
  check(serverEvents.length===3,'server accepted all events');
  check(serverEvents.map(function(e){return e.kind;}).join(',')==='started,progress,stopped',
    'ordered event types');
  check(serverEvents[0].media_key==='tmdb:tv:1000' &&
    serverEvents[0].episode_key==='s2:e5','canonical episode identity');
  check(serverEvents[0].source_recipe.file_index===4 &&
    serverEvents[0].source_recipe.infohash==='0123456789ABCDEF0123456789ABCDEF01234567',
    'sanitized torrent recipe');
  check(!serverEvents.some(function(e){return JSON.stringify(e).indexOf('https://stream.example')!==-1;}),
    'no stream URL was sent');
  check(serverRevision===3,'server revision increments');
  check(fakeWindow.LampaSyncPro.status().revision===3,'client revision syncs');
  check(Object.keys(stored).every(function(k){return !/rezka|cub|trakt|file_view/i.test(k);}),
    'no existing plugin settings changed');
  check(JSON.stringify(local).indexOf('test-secret-password')===-1,'password not persisted');
  check(fakeWindow.LampaSyncPro.status().storage==='localstorage','expected fallback storage');
  settings.lsp_logout.onChange();
  check(fakeWindow.LampaSyncPro.status().authenticated===false,'logout clears auth');
  check(fakeWindow.LampaSyncPro.status().revision===0,'logout clears local history');
  check(!JSON.stringify(local).includes('dummy_refresh'),'logout removes refresh token');
  fakeWindow.LampaSyncPro.destroy();
  check(fakeWindow.plugin_lampa_sync_pro_ready===false,'clean destroy');
  check(fakeWindow.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js'].ready===false,
    'running version invalidated on unload');
  return {passed:passed,events:serverEvents.length,revision:serverRevision,
    networkRequests:requests.length};
}
if (typeof module!=='undefined' && module.exports) {
  module.exports=runPluginTests;
  if (require.main===module) {
    var fs=require('fs'),path=require('path');
    var source=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    var result=runPluginTests(source);
    process.stdout.write('PASS '+result.passed+' assertions ('+result.events+
      ' events, revision '+result.revision+')\n');
  }
}
