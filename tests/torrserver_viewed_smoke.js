/*
 * Read-only TorrServer /viewed adapter regression tests.
 * Execute: node tests/torrserver_viewed_smoke.js
 */
function runViewedSmoke(source) {
  'use strict';
  var assertions=0;
  function ok(cond,msg) {if(!cond)throw new Error('FAIL '+msg);assertions++;}
  function makeEmitter(){
    var map={};
    return {follow:function(type,cb){(map[type]||(map[type]=[])).push(cb);},
      remove:function(type,cb){map[type]=(map[type]||[]).filter(function(x){return x!==cb;});},
      emit:function(type,data){(map[type]||[]).slice().forEach(function(cb){cb(data);});}};
  }
  function scenario(opts) {
    var app=makeEmitter(),player=makeEmitter(),video=makeEmitter(),timeline=makeEmitter();
    var plugins=[{url:'https://raw.githubusercontent.com/Alexgood321/lampa-sync-pro/main/lampa-sync-pro.js'}];
    var settings={},local={},notes=[],post=[],readRequests=[];
    var serverRevision=0, serverEvents=[],seconds=opts.seconds||0, track=opts.track!==false;
    var cryptoCount=0,prompts=['user@example.com','test-password'],sourceHash='0123456789ABCDEF0123456789ABCDEF01234567';
    var movie={media_type:'tv',name:'Test series',source:'tmdb',id:288673,first_air_date:'2026-01-01'};
    var file={card:movie,torrent_hash:sourceHash,id:4,path:'S01E01.mkv',
      season:1,episode:1,url:'https://stream.example/media?link='+sourceHash,
      timeline:{hash:'test-file-hash',time:0,duration:0}};
    var torserver={
      url:function(){return 'http://127.0.0.1:8090';}
    };
    function records() {
      if(opts.wrongIndex)return [{hash:sourceHash,file_index:5,timecode:seconds}];
      if(opts.wrongHash)return [{hash:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',file_index:4,timecode:seconds}];
      return [{hash:sourceHash.toLowerCase(),file_index:4,timecode:seconds}];
    }
    if(!opts.fallback)torserver.viewed=function(hash,success){
      readRequests.push({via:'native',hash:hash});
      success(records());
    };
    function Reguest(){
      this.timeout=function(){};
      this.silent=function(url,success,fail,body){
        readRequests.push({via:'fallback',url:url,payload:JSON.parse(body)});
        success(records());
      };
    }
    var win={
      appready:true,
      crypto:{getRandomValues:function(bytes){cryptoCount++;for(var i=0;i<bytes.length;i++)bytes[i]=(i*19+cryptoCount*13)&255;return bytes;}},
      localStorage:{getItem:function(k){return local[k]||null;},setItem:function(k,v){local[k]=v;}},
      addEventListener:function(){},removeEventListener:function(){},
      Lampa:{
        Listener:app,Player:{listener:player},PlayerVideo:{listener:video},
        Timeline:{listener:timeline},Torserver:torserver,Reguest:Reguest,
        Plugins:{get:function(){return plugins;},save:function(){}},
        SettingsApi:{addComponent:function(){},addParam:function(x){settings[x.param.name]=x;}},
        Storage:{get:function(key,def){return key==='torrserver_tracktimecode' ? track : def;},
          set:function(){},field:function(key){return key==='torrserver_tracktimecode'&&track;}},
        Input:{edit:function(x,done){done(prompts.shift());}},
        Noty:{show:function(s){notes.push(s);}}
      }
    };
    function FakeXHR(){}
    FakeXHR.prototype.open=function(method,url){this.method=method;this.url=url;};
    FakeXHR.prototype.setRequestHeader=function(){};
    FakeXHR.prototype.send=function(text){
      var data=text?JSON.parse(text):{},response=null;
      if(this.url.indexOf('grant_type=password')>=0)
        response={user:{id:'11111111-1111-4111-8111-111111111111',email:'user@example.com'},
          access_token:'test-jwt',refresh_token:'test-refresh',expires_in:3600};
      else if(this.url.indexOf('lsp_sync_snapshot')>=0)
        response={status:'ok',revision:serverRevision,resume_pointers:[],
          watch_state:[],source_progress:opts.cloudPosition?[{
            media_key:'tmdb:tv:288673',episode_key:'s1:e1',
            source_key:'torrent:'+sourceHash+':4',source_kind:'torrent',
            position_seconds:opts.cloudPosition,duration_seconds:1800,deleted:false
          }]:[]};
      else if(this.url.indexOf('lsp_sync_push')>=0) {
        if(data.p_expected_revision!==serverRevision)response={status:'conflict',revision:serverRevision};
        else {
          data.p_events.forEach(function(e){post.push(e);serverEvents.push(e);serverRevision++;});
          response={status:'ok',revision:serverRevision,ignored:0,duplicates:0,accepted:data.p_events.length};
        }
      } else if(this.url.indexOf('lsp_get_resume')>=0)response=null;
      else response={};
      this.status=200;this.responseText=JSON.stringify(response);this.onload();
    };
    var timers=[];
    function timeout(cb){timers.push(cb);return timers.length;}
    function interval(){return 1;}
    new Function('window','XMLHttpRequest','setTimeout','clearTimeout','setInterval','clearInterval',
      source)(win,FakeXHR,timeout,function(){},interval,function(){});
    settings.lsp_login.onChange();
    app.emit('torrent_file',{type:'onenter',element:file,params:{movie:movie}});
    player.emit('create',{data:file});
    player.emit('external',file);
    return {win:win,settings:settings,player:player,video:video,notes:notes,
      pending:function(){return win.LampaSyncPro.status().queued;},
      events:function(){return serverEvents.slice();},
      reads:function(){return readRequests.slice();},
      time:function(next){seconds=next;},
      timer:function(){var list=timers.splice(0,timers.length);list.forEach(function(t){t();});}
    };
  }
  var test=scenario({seconds:95});
  ok(test.pending()===1,'confirmed external launch queued');
  test.settings.lsp_torrserver_check.onChange();
  ok(test.pending()===2,'TorrServer 95s imported as checkpoint');
  ok(test.win.LampaSyncPro.status().torrserver==='timecode:95','positive checkpoint in diagnostics');
  ok(test.reads()[0].hash==='0123456789ABCDEF0123456789ABCDEF01234567','requested current infohash');
  test.settings.lsp_sync_now.onChange();
  ok(test.pending()===0,'remote queue flushed');
  ok(test.events().length===2 && test.events()[1].kind==='progress','progress sent after started');
  ok(test.events()[1].position_seconds===95,'timecode exact seconds');
  ok(test.events()[1].episode_key==='s1:e1','episode identity preserved');
  ok(!JSON.stringify(test.events()).includes('https://stream.example'),'no stream URL in cloud');
  test.settings.lsp_torrserver_check.onChange();
  ok(test.events().length===2 && test.pending()===0,'unchanged timecode does not generate duplicate');
  test.time(0);
  test.settings.lsp_torrserver_check.onChange();
  ok(test.pending()===0 && test.win.LampaSyncPro.status().torrserver==='empty',
    'zero timecode ignored; no loss of checkpoint');
  test.time(110);
  test.settings.lsp_sync_now.onChange();
  ok(test.events().length===3 && test.events()[2].position_seconds===110,
    'manual sync reads changed timecode before cloud push');
  test.player.emit('destroy',{});
  ok(test.pending()===1,'external close checkpoints positive cached position');
  test.win.LampaSyncPro.destroy();

  var mismatch=scenario({seconds:800,wrongIndex:true});
  mismatch.settings.lsp_torrserver_check.onChange();
  ok(mismatch.pending()===1,'wrong file index rejected');
  mismatch.win.LampaSyncPro.destroy();

  var hashMismatch=scenario({seconds:800,wrongHash:true});
  hashMismatch.settings.lsp_torrserver_check.onChange();
  ok(hashMismatch.pending()===1,'wrong infohash rejected');
  hashMismatch.win.LampaSyncPro.destroy();

  var off=scenario({seconds:123,track:false});
  off.settings.lsp_torrserver_check.onChange();
  ok(off.pending()===1,'disabled TrackTimecode does not import');
  ok(off.notes.some(function(t){return t.indexOf('TrackTimecode')!==-1;}),
    'disabled TrackTimecode diagnostic');
  off.win.LampaSyncPro.destroy();

  var fallback=scenario({seconds:150,fallback:true});
  fallback.settings.lsp_torrserver_check.onChange();
  ok(fallback.reads().length===1 && fallback.reads()[0].via==='fallback',
    'Lampa.Reguest fallback used when viewed API unavailable');
  ok(fallback.reads()[0].payload.action==='list' &&
    fallback.reads()[0].payload.hash==='0123456789ABCDEF0123456789ABCDEF01234567',
    'fallback sends correct POST /viewed JSON');
  ok(fallback.reads()[0].url==='http://127.0.0.1:8090/viewed',
    'fallback uses configured TorrServer URL, not Supabase');
  ok(fallback.pending()===2,'fallback timecode imported');
  fallback.win.LampaSyncPro.destroy();

  var existing=scenario({seconds:80,cloudPosition:120});
  existing.settings.lsp_torrserver_check.onChange();
  ok(existing.pending()===1,'older TorrServer checkpoint not imported over cloud 120s');
  existing.time(95);
  existing.settings.lsp_torrserver_check.onChange();
  ok(existing.pending()===2,'changed TorrServer checkpoint considered confirmed seek');
  existing.win.LampaSyncPro.destroy();

  var native=scenario({seconds:130});
  native.video.emit('timeupdate',{current:150,duration:1800});
  native.settings.lsp_torrserver_check.onChange();
  ok(native.pending()===2,'player timeupdate wins over TorrServer');
  ok(native.win.LampaSyncPro.status().torrserver==='timecode:130',
    'TorrServer still readable for diagnostics');
  native.win.LampaSyncPro.destroy();

  return {passed:assertions};
}
if(typeof module!=='undefined'&&module.exports){
  module.exports=runViewedSmoke;
  if(require.main===module){
    var fs=require('fs'),path=require('path');
    var source=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    process.stdout.write('PASS '+runViewedSmoke(source).passed+' /viewed assertions\n');
  }
}