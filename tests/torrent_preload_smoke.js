/* Run: node tests/torrent_preload_smoke.js */
'use strict';
function runTorrentPreloadSmoke(source) {
  var passed=0;
  function assert(x,message){if(!x)throw Error('FAIL '+message);passed++;}
  var begin=source.indexOf('  var fastTorrentPreloadJob=null;');
  var end=source.indexOf('  function openFastTorrentFiles(',begin);
  assert(begin>0 && end>begin,'actual preload helper is present');
  var helper=source.slice(begin,end);
  function fixture(preload) {
    var calls=[],timers=[],progress=[],loading=0,stops=0,ready=0,errors=[];
    var host='http://test-torr:8090',cancelCallback=null;
    var L={
      Storage:{field:function(key){return key==='torrserver_preload'&&preload;}},
      Torserver:{url:function(){return host;}},
      Utils:{bytesToSize:function(n){return n+' b';}},
      Loading:{
        start:function(cancel,text,options){cancelCallback=cancel;loading++;
          assert(!!options.media,'native media loading overlay');},
        stop:function(){stops++;},
        setProgress:function(n,data){progress.push({n:n,data:data});}
      },
      Reguest:function(){
        this.timeout=function(){};
        this.silent=function(url,yes,no){calls.push({url:url,yes:yes,no:no});};
        this.clear=function(){};
      }
    };
    var setT=function(fn,ms){var t={fn:fn,ms:ms,active:true};timers.push(t);return t;};
    var clearT=function(t){if(t)t.active=false;};
    var api=new Function('L','win','STOPPED','str','note',
      'setTimeout','clearTimeout',helper+
      ';return {preload:preloadFastTorrentStream,cancel:cancelFastTorrentPreload};')(
      L,{},false,function(x){return x==null?'':String(x).trim();},
      function(){},setT,clearT);
    var hash='0123456789ABCDEF0123456789ABCDEF01234567';
    var file={id:4,torrent_hash:hash,
      url:host+'/stream/S02E05.mkv?link='+hash+'&index=4&preload'};
    function start(){api.preload(file,function(){ready++;},function(code){errors.push(code);});}
    function tick(){
      var t=timers.filter(function(x){return x.active;})[0];
      assert(!!t,'poll timer scheduled');
      t.active=false;t.fn();
    }
    return {start:start,api:api,file:file,calls:calls,timers:timers,
      progress:progress,tick:tick,cancel:function(){cancelCallback();},
      setHost:function(x){host=x;},get:function(){return{
        ready:ready,errors:errors.slice(),loading:loading,stops:stops
      };}};
  }
  var a=fixture(true);
  a.start();
  assert(a.calls.length===1&&/&preload$/.test(a.calls[0].url),
    'preload request goes first; VLC does not launch');
  assert(a.get().ready===0 && a.get().loading===1,'loading before playback');
  a.calls[0].yes({preloaded_bytes:10,preload_size:100,
    active_peers:2,total_peers:5,download_speed:125000});
  assert(a.progress[0].n===10&&a.progress[0].data.active_peers===2,
    'progress and torrent peers displayed');
  a.tick();
  assert(/&stat$/.test(a.calls[1].url),'subsequent request uses stat');
  a.calls[1].yes({preloaded_bytes:96,preload_size:100});
  a.calls[1].yes({preloaded_bytes:99,preload_size:100});
  assert(a.get().ready===1&&a.get().stops===1,'one readiness signal, cleanup');
  var b=fixture(true);
  b.start();b.calls[0].yes({preloaded_bytes:0,preload_size:0});
  assert(b.get().ready===0,'missing preload_size does not open VLC');
  b.cancel();
  b.calls[0].yes({preloaded_bytes:999,preload_size:1000});
  assert(b.get().ready===0&&b.get().errors[0]==='cancelled',
    'back/cancel blocks late VLC launch');
  var c=fixture(true);
  c.start();c.setHost('http://other-torr:8090');
  c.calls[0].yes({preloaded_bytes:100,preload_size:100});
  assert(c.get().ready===0&&
    c.get().errors[0]==='server_or_file_changed','server switch aborts');
  var d=fixture(true);
  d.start();
  d.calls[0].no();d.tick();d.calls[1].no();d.tick();d.calls[2].no();
  assert(d.get().ready===0&&d.get().errors[0]==='request_failed',
    'network errors never open player');
  var e=fixture(false);
  e.start();
  assert(e.get().ready===1&&e.calls.length===0&&e.get().loading===0,
    'disabled preload preserves immediate native launch');
  var f=fixture(true);f.file.url=f.file.url.replace('&index=4','&index=9');
  f.start();
  assert(f.calls.length===0&&f.get().errors[0]==='server_or_file_changed',
    'invalid file index blocked');
  assert(source.indexOf('if(activeLaunch && activeLaunch.file===el)return;')>0,
    'double-click guard on the real file row');
  assert(source.indexOf('cancelFastTorrentPreload();activeLaunch=null;')>0,
    'modal close aborts a pending preload');
  assert(source.indexOf("L.Player.play(el);")>source.indexOf('preloadFastTorrentStream(el,function(){'),
    'actual player launch is behind the preload callback');
  assert(source.indexOf("L.Listener.send('torrent_file',{type:'onenter'")>
    source.indexOf('preloadFastTorrentStream(el,function(){'),
    'NUM onenter event only after player launch');
  return {passed:passed};
}
if(typeof module!=='undefined'&&module.exports){
  module.exports=runTorrentPreloadSmoke;
  if(require.main===module){
    var fs=require('fs'),path=require('path');
    var src=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    console.log('PASS '+runTorrentPreloadSmoke(src).passed+' torrent preload assertions');
  }
}
