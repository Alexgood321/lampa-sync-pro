/* Regression: next actual playback can complete an untracked previous episode.
 * No fabricated timecodes and no modification to native Timeline.
 */
function runAutoEpisodeCompleteSmoke(source){
  'use strict';
  var passed=0, now=1770000000000;
  function ok(x,label){if(!x)throw Error('FAIL '+label);passed++;}
  function bus(){var h={};return{follow:function(k,f){(h[k]||(h[k]=[])).push(f);},
    remove:function(k,f){h[k]=(h[k]||[]).filter(function(x){return x!==f;});},
    emit:function(k,v){(h[k]||[]).slice().forEach(function(fn){fn(v);})}};}
  var user='11111111-1111-4111-8111-111111111111';
  var hash='0123456789ABCDEF0123456789ABCDEF01234567';
  var card={source:'tmdb',id:2244,media_type:'tv',name:'Series A',first_air_date:'2026-01-01'};
  var other={source:'tmdb',id:3355,media_type:'tv',name:'Series B',first_air_date:'2026-01-01'};
  function file(ep,c){return {card:c||card,torrent_hash:hash,id:ep,
    path:'S01E'+('0'+ep).slice(-2)+'.mkv',season:1,episode:ep,
    url:'http://torrserver.local/stream?file='+ep,timeline:{hash:'h'+ep,time:0,duration:0}};}
  function cloud(flags){
    flags=flags||{};
    var media='tmdb:tv:2244',ep='s1:e3',key='torrent:'+hash+':3';
    return{status:'ok',revision:1,
      resume_pointers:[{media_key:media,episode_key:ep,source_key:key,updated_revision:1}],
      source_progress:[{media_key:media,episode_key:ep,source_key:key,
        source_kind:'torrent',source_recipe:{infohash:hash,file_index:3,
        file_path:'S01E03.mkv'},position_seconds:flags.position||0,
        duration_seconds:flags.duration||0}],
      watch_state:[{media_key:media,episode_key:ep,state:flags.state||'in_progress'}]};
  }
  function rig(opts){
    opts=opts||{};
    var local=opts.local||{},prefs={active_balanser:'kodik'},settings={},
      app=bus(),player=bus(),video=bus(),timeline=bus(),seed=0,batches=[],
      revision=0;
    if(opts.off)prefs.lsp_auto_next_complete=false;
    function XHR(){}
    XHR.prototype.open=function(m,u){this.url=u;};
    XHR.prototype.setRequestHeader=function(){};
    XHR.prototype.send=function(raw){
      var response={},payload=raw&&JSON.parse(raw);
      if(this.url.includes('grant_type=password'))response={user:{id:user,
        email:'a@example.org'},access_token:'jwt',refresh_token:'refresh',expires_in:3600};
      else if(this.url.includes('lsp_sync_snapshot'))response=opts.remote||
        {status:'ok',revision:revision,watch_state:[],source_progress:[],resume_pointers:[]};
      else if(this.url.includes('lsp_sync_push')){batches.push(payload.p_events);
        revision+=payload.p_events.length;
        response={status:'ok',revision:revision,accepted:payload.p_events.length,
          duplicates:0,ignored:0};}
      this.status=200;this.responseText=JSON.stringify(response);this.onload();
    };
    var win={appready:true,crypto:{getRandomValues:function(a){
      seed++;for(var i=0;i<a.length;i++)a[i]=(i*27+seed*11)&255;return a;}},
      localStorage:{getItem:function(k){return local[k]||null;},
        setItem:function(k,v){local[k]=String(v);}},
      addEventListener:function(){},removeEventListener:function(){},
      Lampa:{Listener:app,Player:{listener:player},PlayerVideo:{listener:video},
        Timeline:{listener:timeline},Storage:{get:function(k,d){return k in prefs?prefs[k]:d;},
          set:function(k,v){prefs[k]=v;}},
        SettingsApi:{addComponent:function(){},addParam:function(x){settings[x.param.name]=x;}},
        Input:{edit:function(c,cb){cb(c.title.includes('Пароль')?'password123':'a@example.org');}},
        Noty:{show:function(){}}
      }};
    new Function('window','XMLHttpRequest','setTimeout','clearTimeout','setInterval',
      'clearInterval','Date',source)(win,XHR,function(){return{};},function(){},
      function(){return{};},function(){},{now:function(){return now;}});
    if(!win.LampaSyncPro.status().authenticated)settings.lsp_login.onChange();
    function state(){return JSON.parse(local.lampa_sync_pro_local_v1);}
    function events(){return state().outbox;}
    function launch(ep,which,external){
      var d=which==='online'?{card:card,isonline:true,season:1,episode:ep,
        lampac_resume:{mode:'online',online:{balanser:'kodik',voice_id:'studio',
          voice_name:'Studio',season_index:0,voice_index:1}}}:file(ep,which);
      player.emit('create',{data:d});
      player.emit(external===false?'start':'external',d);
      return d;
    }
    return {win:win,player:player,video:video,settings:settings,events:events,
      state:state,local:local,batches:batches,launch:launch,
      created:function(ep,c){player.emit('create',{data:file(ep,c)});},
      close:function(){player.emit('destroy',{});},
      marks:function(ep){return events().filter(function(x){
        return x.kind==='marked_complete'&&x.episode_key==='s1:e'+ep;});},
      dispose:function(){win.LampaSyncPro.destroy();}};
  }
  var a=rig();
  ok(a.win.LampaSyncPro.status().autoNextComplete,'auto-inference is on by default');
  a.launch(3);
  ok(a.events().length===1 && a.events()[0].kind==='started' &&
    a.win.LampaSyncPro.getEpisodeState(card,'s1:e3').state==='in_progress',
    'a single untracked start is in progress, not completed');
  a.close();a.created(4);
  ok(a.marks(3).length===0,'navigation/create alone does not mark watched');
  a.player.emit('external',file(4));
  ok(a.marks(3).length===1 && a.events().length===3,
    'next confirmed external playback marks the previous episode once');
  ok(a.events().map(function(x){return x.kind;}).join(',')===
    'started,marked_complete,started',
    'previous completion is ordered before new started event');
  ok(a.win.LampaSyncPro.getEpisodeState(card,'s1:e3').state==='completed',
    'NUM sees the cloud completion immediately');
  ok(a.events()[1].completion_basis==='inferred',
    'automatic completion explicitly records inferred provenance');
  ok(a.win.LampaSyncPro.getEpisodeState(card,'s1:e3').basis==='inferred',
    'inferred status is available to NUM for outlined green state');
  ok(a.events()[1].source_recipe===undefined &&
    a.events()[1].position_seconds===undefined,
    'manual event never invents a timecode or contains stream data');
  a.close();a.launch(4);
  ok(a.marks(3).length===1,'replaying the current episode never duplicates prior mark');
  a.win.LampaSyncPro.sync();
  ok(a.batches.some(function(batch){return batch.some(function(e){
    return e.kind==='marked_complete'&&e.episode_key==='s1:e3';});}),
    'normal cloud transactional queue carries inferred completion');
  a.dispose();

  var manual=rig();
  ok(manual.win.LampaSyncPro.markEpisode(card,'s1:e5',true),
    'manual mark is allowed without tracking');
  ok(manual.events().some(function(e){return e.kind==='marked_complete' &&
    e.episode_key==='s1:e5' && e.completion_basis==='manual';}),
    'manual completion cannot be confused with heuristic completion');
  ok(manual.win.LampaSyncPro.getEpisodeState(card,'s1:e5').basis==='manual',
    'manual status is exposed to NUM');
  manual.dispose();
  var b=rig();b.launch(3);b.close();b.launch(5);
  ok(b.marks(3).length===0,'skipping an episode does not mark it');b.dispose();
  var c=rig();c.launch(3);c.close();c.launch(4,other);
  ok(c.marks(3).length===0,'different series do not affect each other');c.dispose();
  var d=rig();d.launch(3);d.close();d.launch(2);
  ok(d.marks(3).length===0,'replaying an earlier episode cannot auto-complete');d.dispose();
  var e=rig({off:true});e.launch(3);e.close();e.launch(4);
  ok(e.marks(3).length===0,'disabled setting suppresses auto-completion');e.dispose();
  var f=rig();f.launch(3,undefined,false);f.video.emit('timeupdate',{current:120,duration:2700});
  f.close();f.launch(4);
  ok(f.marks(3).length===0,'a known native timecode disables the heuristic');f.dispose();
  var g=rig();g.launch(3,undefined,false);g.close();g.launch(4);
  ok(g.marks(3).length===0,'untracked native/internal player is not guessed external');g.dispose();
  var h=rig();h.launch(3);h.close();
  h.win.LampaSyncPro.markEpisode(card,'s1:e3',false);h.launch(4);
  ok(h.marks(3).length===0 &&
    h.win.LampaSyncPro.getEpisodeState(card,'s1:e3').state==='reset',
    'explicit NUM unwatched status wins');h.dispose();
  var i=rig();i.launch(3,'online');i.close();i.launch(4,'online');
  ok(i.marks(3).length===1,'Lampac external player follows the same rule');i.dispose();
  var j=rig({remote:cloud()});j.launch(4);
  ok(j.marks(3).length===1,'cloud pointer supports a different previous device');j.dispose();
  var k=rig({remote:cloud({position:600,duration:2700})});k.launch(4);
  ok(k.marks(3).length===0,'tracked cloud position is never auto-completed');k.dispose();
  var l=rig({remote:cloud({state:'reset'})});l.launch(4);
  ok(l.marks(3).length===0,'remote explicit reset blocks automatic marking');l.dispose();
  var m=rig({remote:cloud({state:'completed'})});m.launch(4);
  ok(m.marks(3).length===0,'already-completed cloud episode is not marked twice');m.dispose();
  var n=rig();n.launch(3);n.dispose();
  var restarted=rig({local:n.local});restarted.launch(4);
  ok(restarted.marks(3).length===1,'local untracked start persists through restart');restarted.dispose();
  var o=rig();o.launch(3);o.close();o.settings.lsp_auto_next_complete.onChange(false);
  o.launch(4);
  ok(o.marks(3).length===0 &&
    !o.win.LampaSyncPro.status().autoNextComplete,
    'settings switch disables inference in the running session');o.dispose();
  return{passed:passed};
}
if(typeof module!=='undefined'&&module.exports){
  module.exports=runAutoEpisodeCompleteSmoke;
  if(require.main===module){
    var fs=require('fs'),path=require('path');
    var source=fs.readFileSync(path.resolve(__dirname,'../lampa-sync-pro.js'),'utf8');
    process.stdout.write('PASS '+runAutoEpisodeCompleteSmoke(source).passed+
      ' auto episode completion assertions\n');
  }
}
