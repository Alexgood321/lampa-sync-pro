/*
 * Supabase Realtime Phoenix WebSocket tests: join, account isolation, event delivery,
 * reconnect/gap-fill, heartbeat, JWT refresh, hidden/offline cleanup.
 * Execute: node tests/realtime_smoke.js
 */
function runRealtimeSmoke(source) {
  'use strict';
  var passed=0, now=1700000000000;
  function ok(x,label){if(!x)throw new Error('FAIL '+label);passed++;}
  function emitter(){
    var listeners={};
    return {follow:function(key,fn){(listeners[key]||(listeners[key]=[])).push(fn);},
      remove:function(key,fn){listeners[key]=(listeners[key]||[]).filter(function(item){return item!==fn;});},
      emit:function(key,value){(listeners[key]||[]).slice().forEach(function(fn){fn(value);});},
      size:function(key){return (listeners[key]||[]).length;}};
  }
  var sockets=[],timers=[],intervals=[],requests=[],settings={},notes=[];
  var docEvents=emitter(),winEvents=emitter(),appEvents=emitter(),playerEvents=emitter();
  var local={},prompts=['test@example.org','password123'],seq=0,cloudRevision=0,pushes=[];
  var account='11111111-1111-4111-8111-111111111111';
  var other='22222222-2222-4222-8222-222222222222';
  var hash='0123456789ABCDEF0123456789ABCDEF01234567';
  var doc={visibilityState:'visible',
    addEventListener:docEvents.follow,removeEventListener:docEvents.remove};
  function FakeDate(){}
  FakeDate.now=function(){return now;};
  function later(fn,ms){var timer={fn:fn,ms:ms,active:true};timers.push(timer);return timer;}
  function cancelLater(timer){if(timer)timer.active=false;}
  function fireLater(ms){
    var timer=timers.find(function(t){return t.active && t.ms===ms;});
    if(!timer)throw new Error('Missing active timer '+ms);
    timer.active=false;timer.fn();
  }
  function every(fn,ms){var handle={fn:fn,ms:ms,active:true};intervals.push(handle);return handle;}
  function cancelEvery(handle){if(handle)handle.active=false;}
  function MockSocket(url){
    this.url=url;this.readyState=0;this.sent=[];
    sockets.push(this);
  }
  MockSocket.prototype.send=function(msg){this.sent.push(JSON.parse(msg));};
  MockSocket.prototype.close=function(){this.readyState=3;};
  MockSocket.prototype.open=function(){this.readyState=1;if(this.onopen)this.onopen();};
  MockSocket.prototype.receive=function(message){
    if(this.onmessage)this.onmessage({data:JSON.stringify(message)});
  };
  MockSocket.prototype.breakConnection=function(){
    this.readyState=3;if(this.onclose)this.onclose();
  };
  function latestJoin(socket){
    return socket.sent.find(function(msg){return msg.event==='phx_join';});
  }
  function ackJoin(socket,valid){
    var join=latestJoin(socket);
    socket.receive({topic:join.topic,event:'phx_reply',ref:join.ref,
      join_ref:join.join_ref,payload:{status:valid===false?'error':'ok',
        response:{postgres_changes:valid===false?[]:[{
          id:921,event:'*',schema:'public',table:'lsp_sync_heads'
        }]}}});
  }
  function notify(socket,user,revision,table,ids){
    var join=latestJoin(socket);
    socket.receive({topic:join.topic,event:'postgres_changes',ref:null,join_ref:join.ref,
      payload:{ids:ids||[921],data:{schema:'public',table:table||'lsp_sync_heads',
        type:'UPDATE',record:{user_id:user,revision:revision}}}});
  }
  function FakeXHR(){}
  FakeXHR.prototype.open=function(method,url){this.method=method;this.url=url;};
  FakeXHR.prototype.setRequestHeader=function(){};
  FakeXHR.prototype.send=function(raw){
    requests.push(this.url);
    var response={},data=raw?JSON.parse(raw):{};
    if(this.url.indexOf('grant_type=password')>=0 ||
      this.url.indexOf('grant_type=refresh_token')>=0){
      response={user:{id:account,email:'test@example.org'},
        access_token:requests.filter(function(x){return x.indexOf('grant_type=refresh_token')!==-1;}).length ?
          'refreshed-jwt':'initial-jwt',
        refresh_token:'valid-refresh',expires_in:3600};
    } else if(this.url.indexOf('lsp_sync_snapshot')>=0){
      response={status:'ok',revision:cloudRevision,source_progress:[],watch_state:[],resume_pointers:[]};
    } else if(this.url.indexOf('lsp_sync_push')>=0){
      if(data.p_expected_revision!==cloudRevision)
        response={status:'conflict',revision:cloudRevision};
      else {
        data.p_events.forEach(function(e){pushes.push(e);cloudRevision++;});
        response={status:'ok',revision:cloudRevision,accepted:data.p_events.length,ignored:0};
      }
    }
    this.status=200;this.responseText=JSON.stringify(response);this.onload();
  };
  var win={
    appready:true,document:doc,navigator:{onLine:true},WebSocket:MockSocket,
    crypto:{getRandomValues:function(bytes){seq++;for(var i=0;i<bytes.length;i++)bytes[i]=(i*17+seq*11)&255;return bytes;}},
    localStorage:{getItem:function(key){return local[key]||null;},
      setItem:function(key,value){local[key]=value;}},
    addEventListener:winEvents.follow,removeEventListener:winEvents.remove,
    Lampa:{
      Listener:appEvents,Player:{listener:playerEvents},
      PlayerVideo:{listener:emitter()},Timeline:{listener:emitter()},
      Torserver:{},Plugins:{get:function(){return [];},save:function(){}},
      Storage:{get:function(key,defaultValue){return defaultValue;},set:function(){}},
      Input:{edit:function(o,cb){cb(prompts.shift());}},
      SettingsApi:{addComponent:function(){},addParam:function(p){settings[p.param.name]=p;}},
      Noty:{show:function(s){notes.push(s);}}
    }
  };
  new Function('window','XMLHttpRequest','setTimeout','clearTimeout',
    'setInterval','clearInterval','Date',source)(
      win,FakeXHR,later,cancelLater,every,cancelEvery,FakeDate
    );
  ok(intervals.length===0,'no periodic SQL polling on boot');
  ok(winEvents.size('offline')===1,'offline listener installed');
  settings.lsp_login.onChange();
  ok(sockets.length===1,'sign-in creates one WebSocket');
  ok(win.LampaSyncPro.status().authenticated,'auth works');
  var ws=sockets[0];
  ok(ws.url.indexOf('/realtime/v1/websocket?apikey=')>0,'official realtime websocket endpoint');
  ok(ws.url.indexOf('initial-jwt')===-1,'JWT never placed in websocket URL');
  ws.open();
  var join=latestJoin(ws);
  ok(!!join && join.join_ref===join.ref,'correct Phoenix v1 join and join_ref');
  ok(join.payload.access_token==='initial-jwt','signed JWT passed only in join payload');
  ok(join.payload.config.postgres_changes[0].filter==='user_id=eq.'+account,
    'subscription filtered to authenticated user');
  ok(join.payload.config.postgres_changes[0].table==='lsp_sync_heads',
    'only revision head subscribed');
  ok(join.payload.config.private===false,'public channel with postgres RLS');
  var snapCount=function(){return requests.filter(function(v){return v.indexOf('lsp_sync_snapshot')>=0;}).length;};
  var beforeJoin=snapCount();
  ackJoin(ws);
  ok(win.LampaSyncPro.status().realtime==='connected','join acknowledged');
  ok(snapCount()===beforeJoin+2,'join gap filled by snapshot');
  ok(intervals.filter(function(i){return i.active&&i.ms===30000;}).length===0,
    '30-second HTTP interval removed');
  var heartbeat=intervals.find(function(i){return i.active&&i.ms===20000;});
  ok(!!heartbeat,'Phoenix heartbeat scheduled every 20 seconds');
  heartbeat.fn();
  var ping=ws.sent[ws.sent.length-1];
  ok(ping.topic==='phoenix'&&ping.event==='heartbeat'&&ping.join_ref===null,
    'heartbeat uses phoenix special topic');
  ws.receive({topic:'phoenix',event:'phx_reply',ref:ping.ref,payload:{status:'ok',response:{}}});
  var before=snapCount();
  notify(ws,other,1);
  notify(ws,account,1,'another_table');
  notify(ws,account,1,'lsp_sync_heads',[777]);
  ok(snapCount()===before,'wrong account/table/subscription ignored');
  cloudRevision=1;
  notify(ws,account,1);
  notify(ws,account,1);
  ok(snapCount()===before,'notification coalesces until debounce');
  fireLater(300);
  ok(snapCount()===before+2,'revision event triggers immediate cloud snapshot');
  ok(win.LampaSyncPro.status().revision===1,'cloud revision applied');
  var afterOne=snapCount();
  notify(ws,account,1);
  ok(snapCount()===afterOne,'duplicate revision ignored');
  // Actions are still written through authenticated RPC, without a polling interval.
  var movie={name:'Testing',media_type:'tv',id:288673,source:'tmdb',first_air_date:'2026-01-01'};
  var file={card:movie,torrent_hash:hash,id:3,path:'S01E02.mkv',
    season:1,episode:2,url:'https://torrserver.example/stream/'+hash,
    timeline:{hash:'path-s1e2',time:0,duration:0}};
  appEvents.emit('torrent_file',{type:'onenter',element:file,params:{movie:movie}});
  playerEvents.emit('create',{data:file});
  playerEvents.emit('external',file);
  ok(win.LampaSyncPro.status().queued===1,'play action queues event');
  fireLater(1800);
  ok(pushes.length===1 && pushes[0].kind==='started','play action immediately flushes via RPC');
  ok(win.LampaSyncPro.status().queued===0,'action queue flushed');
  ok(win.LampaSyncPro.status().revision===2,'own revision committed');

  ok(win.LampaSyncPro.markEpisode('tmdb:tv:288673','s1:e2',true),
    'NUM queues an authenticated completion');
  ok(win.LampaSyncPro.getEpisodeState('tmdb:tv:288673','s1:e2').state==='completed',
    'NUM sees pending completion instantly');
  fireLater(1800);
  ok(pushes.length===2 && pushes[1].kind==='marked_complete',
    'manual completion sent through protected RPC queue');
  ok(win.LampaSyncPro.status().revision===3,'manual completion increments revision');
  ok(win.LampaSyncPro.markEpisode('tmdb:tv:288673','s1:e2',false),
    'NUM queues a manual reset');
  ok(win.LampaSyncPro.getEpisodeState('tmdb:tv:288673','s1:e2').state==='reset',
    'pending reset has precedence');
  fireLater(1800);
  ok(pushes.length===3 && pushes[2].kind==='marked_unwatched',
    'manual reset sent through protected RPC queue');
  ok(!win.LampaSyncPro.markEpisode('tmdb:tv:invalid','s1:e2',true) &&
    !win.LampaSyncPro.markEpisode('tmdb:tv:288673','s1:e0',true),
    'invalid media and episode identities rejected');

  notify(ws,account,4);
  ok(win.LampaSyncPro.status().revision===4,'self event does not fetch again');
  // Unexpected close re-establishes the socket with exponential backoff.
  ws.breakConnection();
  ok(win.LampaSyncPro.status().realtime==='reconnecting','close schedules reconnect');
  fireLater(1000);
  ok(sockets.length===2,'new socket made after retry');
  var second=sockets[1];
  second.open();
  var join2=latestJoin(second);
  ok(join2.payload.config.postgres_changes.length===1,'subscription restored');
  cloudRevision=5;
  var beforeRejoin=snapCount();
  ackJoin(second);
  ok(snapCount()===beforeRejoin+2,'reconnect fills missed revision');
  ok(win.LampaSyncPro.status().revision===5,'lost offline changes restored');
  // Renew JWT while socket remains connected.
  var refreshTimer=timers.filter(function(x){return x.active&&x.ms>1000000;})[0];
  ok(!!refreshTimer,'JWT refresh timer scheduled');
  now+=3550000;
  refreshTimer.active=false;
  refreshTimer.fn();
  ok(requests.some(function(v){return v.indexOf('grant_type=refresh_token')>=0;}),
    'refresh token requested without manual sign-in');
  ok(second.sent.some(function(v){return v.event==='access_token' &&
      v.payload.access_token==='refreshed-jwt';}),'new JWT sent via Phoenix access_token');
  // When backgrounded, socket is closed. On visibility return, no periodic polling.
  doc.visibilityState='hidden';
  docEvents.emit('visibilitychange');
  ok(second.readyState===3 && win.LampaSyncPro.status().realtime==='paused',
    'socket closed when hidden');
  var backgroundSocketCount=sockets.length;
  now+=100000;
  ok(sockets.length===backgroundSocketCount,'no background reconnection');
  doc.visibilityState='visible';
  docEvents.emit('visibilitychange');
  ok(sockets.length===backgroundSocketCount+1,'visibility restore creates websocket');
  var third=sockets[sockets.length-1];
  third.open();ackJoin(third);
  ok(win.LampaSyncPro.status().realtime==='connected','foreground resubscribed');
  winEvents.emit('offline');
  ok(win.LampaSyncPro.status().realtime==='offline','offline event stops socket');
  ok(third.readyState===3,'socket closed on network loss');
  win.navigator.onLine=true;
  winEvents.emit('online');
  ok(sockets.length===backgroundSocketCount+2,'online event reconnects');
  win.LampaSyncPro.destroy();
  ok(winEvents.size('online')===0&&winEvents.size('offline')===0,
    'connection listeners removed on destroy');
  ok(docEvents.size('visibilitychange')===0,'visibility listener removed on destroy');
  ok(intervals.filter(function(v){return v.active;}).length===0,'heartbeat timers cleared');
  ok(sockets[sockets.length-1].readyState===3,'socket destroyed');
  return {passed:passed,requests:requests.length,events:pushes.length};
}
if(typeof module!=='undefined'&&module.exports) {
  module.exports=runRealtimeSmoke;
  if(require.main===module) {
    var fs=require('fs'),path=require('path');
    var src=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    process.stdout.write('PASS '+runRealtimeSmoke(src).passed+' realtime assertions\n');
  }
}