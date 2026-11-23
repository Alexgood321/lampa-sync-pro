/*
 * Lampa Sync Pro: device_sequence_conflict repair and replay safety.
 * Execute: node tests/device_sequence_recovery_smoke.js
 */
function runDeviceSequenceRecoverySmoke(source) {
  'use strict';
  var passed=0;
  function ok(value,description){
    if(!value)throw new Error('FAIL '+description);
    passed++;
  }
  function fixture(opts){
    opts=opts||{};
    var account='11111111-1111-4111-8111-111111111111';
    var device='73faee98-1111-4111-8111-111111111111';
    var ids=[
      'aaaaaaaa-1111-4111-8111-111111111111',
      'bbbbbbbb-2222-4222-8222-222222222222',
      'cccccccc-3333-4333-8333-333333333333'
    ];
    var initial=opts.queued===undefined?3:opts.queued;
    var queue=ids.slice(0,initial).map(function(id,i){
      return {schema:1,event_id:id,device_id:device,
        device_seq:16+i,base_revision:170,
        kind:'marked_complete',completion_basis:'manual',
        media_key:'tmdb:tv:1396',episode_key:'s1:e'+(i+1)};
    });
    var original=JSON.parse(JSON.stringify(queue));
    var saved={schema:1,userId:account,
      auth:{access_token:'test-jwt',refresh_token:'test-refresh',
        expires_at:Date.now()+86400000,email:'test@example.org'},
      deviceId:device,seq:opts.localSeq===undefined?18:opts.localSeq,
      revision:170,snapshot:null,outbox:queue,lastTorrent:null,lastPlayback:null};
    var local={lampa_sync_pro_local_v1:JSON.stringify(saved)};
    var serverSeq=opts.serverSeq===undefined?18:opts.serverSeq;
    var serverRevision=186,accepted={};
    if(opts.acceptedFirst)accepted[ids[0]]=true;
    var requests=[],pushes=[],notes=[],settings={},writes=0,rand=0;
    var failPersistence=!!opts.failPersistence;
    var failDeviceGET=!!opts.failDeviceGET;
    var invalidServerRow=!!opts.invalidServerRow;
    var invalidEventRow=!!opts.invalidEventRow;
    var race=!!opts.race;
    var changedAtSecondPush=false;
    var networkErrorMessage=opts.networkErrorMessage||'';
    function storageSet(key,value){
      writes++;
      // On normal boot and snapshot saves preserve state; fail only
      // when recovery tries to persist the repaired queue.
      if(failPersistence && writes>=3)
        throw new Error('full_storage');
      local[key]=String(value);
    }
    var win={
      appready:true,navigator:{userAgent:'Macintosh'},
      crypto:{getRandomValues:function(bytes){rand++;
        for(var i=0;i<bytes.length;i++)bytes[i]=(i*19+rand*11)&255;
      }},
      localStorage:{getItem:function(key){return local[key]||null;},setItem:storageSet},
      addEventListener:function(){},removeEventListener:function(){},
      Lampa:{
        Listener:{follow:function(){},remove:function(){}},
        Player:{listener:{follow:function(){},remove:function(){}}},
        PlayerVideo:{listener:{follow:function(){},remove:function(){}}},
        Timeline:{listener:{follow:function(){},remove:function(){}}},
        Plugins:{get:function(){return [];},save:function(){}},
        Storage:{get:function(k,def){return def;},set:function(){}},
        Noty:{show:function(t){notes.push(String(t));}},
        SettingsApi:{addComponent:function(){},addParam:function(c){settings[c.param.name]=c;}}
      }
    };
    function FakeXHR(){}
    FakeXHR.prototype.open=function(method,url){this.method=method;this.url=url;};
    FakeXHR.prototype.setRequestHeader=function(){};
    FakeXHR.prototype.send=function(raw){
      var body=raw?JSON.parse(raw):null;
      requests.push({url:this.url,method:this.method,body:body});
      var json=null,status=200;
      if(this.url.indexOf('lsp_register_device')>=0){
        json={status:'ok'};
      }else if(this.url.indexOf('lsp_sync_snapshot')>=0){
        json={status:'ok',revision:serverRevision,watch_state:[],
          source_progress:[],resume_pointers:[]};
      }else if(this.url.indexOf('lsp_sync_push')>=0){
        pushes.push(body.p_events.map(function(e){return JSON.parse(JSON.stringify(e));}));
        if(race && pushes.length===2 && !changedAtSecondPush){
          serverSeq=20;changedAtSecondPush=true;
        }
        if(body.p_expected_revision!==serverRevision){
          json={status:'conflict',revision:serverRevision};
        }else if(networkErrorMessage){
          status=400;json={code:'P0001',message:networkErrorMessage};
        }else{
          var conflict=false;
          var nextSeq=serverSeq;
          for(var i=0;i<body.p_events.length;i++){
            var event=body.p_events[i];
            if(accepted[event.event_id])continue;
            if(event.device_seq<=nextSeq){conflict=true;break;}
            nextSeq=event.device_seq;
          }
          if(conflict){
            status=400;json={code:'P0001',message:'device_sequence_conflict'};
          }else{
            var added=0,duplicates=0;
            body.p_events.forEach(function(e){
              if(accepted[e.event_id])duplicates++;
              else{accepted[e.event_id]=true;added++;}
            });
            serverSeq=nextSeq;serverRevision+=added;
            json={status:'ok',revision:serverRevision,
              accepted:added,duplicates:duplicates,ignored:0};
          }
        }
      }else if(this.url.indexOf('/lsp_devices?select=device_id,last_seq')>=0){
        if(failDeviceGET){status=500;json={code:'unavailable'};}
        else json=[{device_id:device,last_seq:invalidServerRow?null:serverSeq}];
      }else if(this.url.indexOf('/lsp_sync_events?select=event_id')>=0){
        if(invalidEventRow)json=[{event_id:'dddddddd-4444-4444-8444-444444444444'}];
        else{
          var m=/event_id=in\.\(([^)]*)\)/.exec(this.url);
          var chunk=m?m[1].split(','):[];
          json=chunk.filter(function(id){return accepted[id];})
            .map(function(id){return {event_id:id};});
        }
      }else{
        status=404;json={code:'unexpected_request'};
      }
      this.status=status;this.responseText=JSON.stringify(json);
      if(this.onload)this.onload();
    };
    new Function('window','XMLHttpRequest','setTimeout','clearTimeout',
      'setInterval','clearInterval',source)(
      win,FakeXHR,function(){return 1;},function(){},
      function(){return 1;},function(){}
    );
    function persisted(){
      return JSON.parse(local.lampa_sync_pro_local_v1);
    }
    return {win:win,device:device,ids:ids,original:original,
      requests:requests,pushes:pushes,notes:notes,settings:settings,
      persisted:persisted,serverAccepted:accepted,
      currentServerSeq:function(){return serverSeq;},
      currentServerRevision:function(){return serverRevision;}};
  }
  var repaired=fixture();
  ok(repaired.pushes.length===2,'initial P0001 and a single repaired replay');
  ok(repaired.pushes[0].map(function(e){return e.device_seq;}).join(',')==='16,17,18',
    'initial Mac queue is stale against server last_seq=18');
  ok(repaired.pushes[1].map(function(e){return e.device_seq;}).join(',')==='19,20,21',
    'unaccepted items resequenced from server last_seq');
  ok(repaired.pushes[1].every(function(e,i){
    return e.event_id===repaired.original[i].event_id &&
      e.media_key===repaired.original[i].media_key &&
      e.episode_key===repaired.original[i].episode_key &&
      e.base_revision===170;
  }),'event identity, history, and OCC base_revision untouched');
  ok(repaired.win.LampaSyncPro.status().queued===0 &&
    repaired.currentServerSeq()===21,'all three Mac events reach server');
  ok(repaired.persisted().seq===21 && repaired.persisted().outbox.length===0,
    'successful recovery and ACK persisted without changing device');
  ok(repaired.persisted().deviceId===repaired.device,
    'device ID remains stable throughout replay');
  ok(repaired.requests.some(function(r){return r.url.indexOf('lsp_devices?select=device_id,last_seq')>=0;}) &&
    repaired.requests.some(function(r){return r.url.indexOf('lsp_sync_events?select=event_id')>=0;}),
    'recover reads RLS-protected last_seq and accepted event IDs');
  var partial=fixture({acceptedFirst:true});
  ok(partial.pushes.length===2&&partial.pushes[1].length===2,
    'server-accepted first event is not resent');
  ok(partial.pushes[1][0].event_id===partial.ids[1] &&
    partial.pushes[1][0].device_seq===19 &&
    partial.pushes[1][1].event_id===partial.ids[2] &&
    partial.pushes[1][1].device_seq===20,
    'two unaccepted event IDs retained in their original order');
  ok(partial.win.LampaSyncPro.status().queued===0 &&
    partial.currentServerSeq()===20 &&
    partial.currentServerRevision()===188,'partial server ACK recovered without duplicate');
  var race=fixture({race:true});
  ok(race.pushes.length===3 &&
    race.pushes[2].map(function(e){return e.device_seq;}).join(',')==='21,22,23',
    'server sequence moving mid-repair causes a bounded second replay');
  ok(race.win.LampaSyncPro.status().queued===0,
    'second conflict resolves without losing pending queue');
  var failGET=fixture({failDeviceGET:true});
  ok(failGET.pushes.length===1 &&
    failGET.win.LampaSyncPro.status().queued===3,
    'HTTP failure reading server last_seq retains all pending events');
  ok(failGET.persisted().outbox.length===3,
    'read failure keeps original persisted queue');
  var failStorage=fixture({failPersistence:true});
  ok(failStorage.pushes.length===1 &&
    failStorage.win.LampaSyncPro.status().queued===3,
    'failed recovery persistence prohibits replay');
  ok(failStorage.persisted().outbox.length===3,
    'failed disk write preserves original stored outbox');
  var invalidRow=fixture({invalidServerRow:true});
  ok(invalidRow.pushes.length===1&&invalidRow.win.LampaSyncPro.status().queued===3,
    'malformed server last_seq is fail-closed');
  var invalidEvents=fixture({invalidEventRow:true});
  ok(invalidEvents.pushes.length===1 &&
    invalidEvents.win.LampaSyncPro.status().queued===3,
    'unexpected event IDs never cause queue pruning');
  var unrelated=fixture({networkErrorMessage:'invalid_event_identity'});
  ok(unrelated.pushes.length===1&&unrelated.win.LampaSyncPro.status().queued===3,
    'unrelated P0001 errors do not trigger sequence repair');
  unrelated.settings.lsp_sync_now.onChange();
  ok(unrelated.notes.some(function(s){return s.indexOf('invalid_event_identity')>=0;}),
    'manual sync shows exact safe validation error, not network-unavailable');
  var noQueue=fixture({queued:0,localSeq:4});
  ok(noQueue.pushes.length===0&&noQueue.win.LampaSyncPro.status().queued===0,
    'empty queue never generates synthetic playback events');
  var acceptedAll=fixture({acceptedFirst:true,queued:1});
  ok(acceptedAll.pushes.length===1&&acceptedAll.win.LampaSyncPro.status().queued===0,
    'server-confirmed single event resolves through idempotent RPC');
  return {passed:passed};
}
if(typeof module!=='undefined'&&module.exports) {
  module.exports=runDeviceSequenceRecoverySmoke;
  if(require.main===module){
    var fs=require('fs'),path=require('path');
    var src=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    console.log('PASS '+runDeviceSequenceRecoverySmoke(src).passed+
      ' device sequence recovery assertions');
  }
}
