/* Lampa Sync Pro 0.1.12-alpha | https://github.com/Alexgood321/lampa-sync-pro
 * Supabase Auth + transactional RPC. Torrent-only capture and guarded resume.
 * Does not modify CUB, Trakt, HDRezka/Netlify or native history during bootstrap.
 */
(function (win) {
  'use strict';
  if (!win || !win.Lampa) return;
  if (typeof win.plugin_lampa_sync_pro_destroy === 'function') {
    try { win.plugin_lampa_sync_pro_destroy(); } catch (ignored) {}
  } else if (win.plugin_lampa_sync_pro_ready) return;
  win.plugin_lampa_sync_pro_ready = true;

  var Lampa = win.Lampa;
  var L = Lampa;
  var VERSION = '0.1.12';
  var CHANNEL = 'alpha';
  var BASE = 'https://kkrmivgrnfqauvplccqm.supabase.co';
  var KEY = 'sb_publishable_mpmJzdr8DZM4kukXPAdKmw_6YDWl2VH';
  var STORE_KEY = 'lampa_sync_pro_local_v1';
  var STOPPED = false;
  var loaded = false, db = null, storageMode = 'indexeddb';
  var subscriptions = [], sendTimer = null;
  var networkBusy = false, refreshing = false, refreshWaiters = [];
  var lastSuccessfulSync = 0;
  var retryAfter = 0, active = null, staged = null, currentFull = null;
  var lastTorrent = null, torrPoll = null, torrStatus = 'not_checked';
  var torrentResumeJob = null, torrentFocusJob = null;
  var resumeOverrides = {}, stateListeners = [], onlineResumeTimer=null;
  // Supabase Realtime Phoenix 1.0.0; only the per-user revision head is replicated.
  var rtSocket=null, rtAccount='', rtTopic='', rtJoinRef='', rtRef=0;
  var rtJoined=false, rtStarting=false, rtState='disconnected', rtAttempt=0;
  var rtSubscriptions=[], rtHeartbeat=null, rtPingRef='', rtPingAt=0;
  var rtJoinTimeout=null, rtReconnect=null, rtAuthTimer=null, rtPullTimer=null;
  var rtPendingRevision=0, rtLastEventAt=0, rtJoinCatchup=false;
  var state = { schema: 1, userId: '', auth: null, deviceId: '', seq: 0,
    revision: 0, snapshot: null, outbox: [], lastTorrent: null };

  function number(value) {
    var x = Number(value);
    return isFinite(x) ? x : 0;
  }
  function str(x) { return x === null || x === undefined ? '' : String(x).trim(); }
  function validUUID(x) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(x)); }
  function uuid() {
    var c = win.crypto || win.msCrypto;
    if (!c || typeof c.getRandomValues !== 'function') return '';
    var bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var h = [], i;
    for (i = 0; i < 16; i++) h.push(('0' + bytes[i].toString(16)).slice(-2));
    return h.slice(0,4).join('') + '-' + h.slice(4,6).join('') + '-' +
      h.slice(6,8).join('') + '-' + h.slice(8,10).join('') + '-' + h.slice(10).join('');
  }
  function note(message) {
    if (!STOPPED && L.Noty && L.Noty.show) L.Noty.show('Lampa Sync: ' + message);
  }
  function option(name, def) {
    try {
      var v = L.Storage.get('lsp_' + name, def);
      return v === true || v === 'true';
    } catch (e) { return def; }
  }
  function snapshotState() {
    return { schema: 1, userId: state.userId, auth: state.auth, deviceId: state.deviceId,
      seq: state.seq, revision: state.revision, snapshot: state.snapshot,
      outbox: state.outbox.slice(), lastTorrent: state.lastTorrent };
  }
  function fallbackLoad(cb) {
    storageMode = 'localstorage';
    try { cb(JSON.parse(win.localStorage.getItem(STORE_KEY) || 'null')); }
    catch (e) { cb(null); }
  }
  function loadState(cb) {
    if (!win.indexedDB) return fallbackLoad(cb);
    try {
      var request = win.indexedDB.open('lampa_sync_pro_v1', 1);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv');
      };
      request.onerror = function () { fallbackLoad(cb); };
      request.onsuccess = function () {
        db = request.result;
        try {
          var transaction = db.transaction(['kv'], 'readonly');
          var read = transaction.objectStore('kv').get('state');
          read.onsuccess = function () { cb(read.result || null); };
          read.onerror = function () { db = null; fallbackLoad(cb); };
        } catch (e) { db = null; fallbackLoad(cb); }
      };
    } catch (e) { fallbackLoad(cb); }
  }
  function save() {
    if (!loaded || STOPPED) return;
    var value = snapshotState();
    if (db) {
      try { db.transaction(['kv'], 'readwrite').objectStore('kv').put(value, 'state'); return; }
      catch (e) { storageMode = 'localstorage'; db = null; }
    }
    try { win.localStorage.setItem(STORE_KEY, JSON.stringify(value)); }
    catch (e) { note('Не удалось сохранить локальный кэш'); }
  }
  function sanitizeSaved(s) {
    if (!s || s.schema !== 1) return;
    state.userId = validUUID(s.userId) ? s.userId : '';
    state.auth = s.auth && s.auth.refresh_token && s.auth.access_token ? s.auth : null;
    state.deviceId = validUUID(s.deviceId) ? s.deviceId : '';
    state.seq = Math.max(0, Math.floor(number(s.seq)));
    state.revision = Math.max(0, Math.floor(number(s.revision)));
    state.snapshot = s.snapshot && s.snapshot.status === 'ok' ? s.snapshot : null;
    var record = s.lastTorrent;
    if (record && validUUID(record.session_id) &&
        /^tmdb:(tv|movie):\d{1,12}$|^imdb:tt\d{1,12}$|^kinopoisk:\d{1,12}$/.test(str(record.media_key)) &&
        /^(movie|s\d{1,3}:e\d{1,4})$/.test(str(record.episode_key)) &&
        record.recipe && /^[A-F0-9]{40}$|^[A-Z2-7]{32}$/.test(str(record.recipe.infohash)) &&
        number(record.updated_at)>Date.now()-6*60*60*1000) {
      state.lastTorrent = record;
    }
    state.outbox = Array.isArray(s.outbox) ? s.outbox.filter(function (e) {
      return e && e.schema === 1 && validUUID(e.event_id) && validUUID(e.device_id);
    }).slice(-750) : [];
    if (!state.auth || !state.userId) { state.auth = null; state.userId = ''; state.outbox = []; state.snapshot = null; state.revision = 0; state.lastTorrent=null; }
  }
  function request(method, path, payload, token, done) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(err, data) {
      if (finished || STOPPED) return;
      finished = true;
      done(err, data);
    }
    try {
      xhr.open(method, BASE + path, true);
      xhr.timeout = 14000;
      xhr.setRequestHeader('apikey', KEY);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'application/json');
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.onload = function () {
        var parsed = null;
        try { parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null; }
        catch (ignore) {}
        if (xhr.status >= 200 && xhr.status < 300) return finish(null, parsed);
        var err = new Error('HTTP ' + xhr.status);
        err.status = xhr.status;
        err.code = parsed && (parsed.code || parsed.error_code || parsed.error) || 'request_failed';
        finish(err);
      };
      xhr.onerror = function () { finish(new Error('network_error')); };
      xhr.ontimeout = function () { finish(new Error('timeout')); };
      xhr.send(payload === undefined ? null : JSON.stringify(payload));
    } catch (e) { finish(new Error('request_unavailable')); }
  }
  function storeAuth(data) {
    if (!data || !data.access_token || !data.refresh_token || !data.user || !validUUID(data.user.id)) return false;
    var user = str(data.user.id);
    if (state.userId && state.userId !== user) {
      realtimeStop();
      state.revision = 0;
      state.outbox = [];
      state.snapshot = null;
      state.seq = 0;
      state.deviceId = uuid();
      state.lastTorrent=null;
      lastTorrent=null;
      clearTorrPoll();
    }
    state.userId = user;
    state.auth = { access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: Date.now() + Math.max(1,number(data.expires_in))*1000,
      email: str(data.user.email) };
    save();
    if (rtJoined && rtAccount===user) realtimeAuthSchedule();
    return true;
  }
  function token(done) {
    if (!state.auth) return done(new Error('not_signed_in'));
    if (Date.now() + 90000 < number(state.auth.expires_at)) return done(null, state.auth.access_token);
    refreshWaiters.push(done);
    if (refreshing) return;
    refreshing = true;
    request('POST','/auth/v1/token?grant_type=refresh_token',
      { refresh_token: state.auth.refresh_token }, null, function(err,data) {
      refreshing = false;
      if (!err && !storeAuth(data)) err = new Error('invalid_auth_response');
      var callbacks = refreshWaiters.slice();
      refreshWaiters = [];
      callbacks.forEach(function(cb) { cb(err, err ? null : state.auth.access_token); });
    });
  }
  function rpc(name, params, done, retried) {
    token(function (err, jwt) {
      if (err) return done(err);
      request('POST', '/rest/v1/rpc/' + name, params || {}, jwt, function (error, result) {
        if (error && error.status === 401 && !retried && state.auth) {
          state.auth.expires_at = 0;
          return rpc(name, params, done, true);
        }
        done(error, result);
      });
    });
  }
  function selectAccount(data) {
    if (!storeAuth(data)) { note('Ошибка данных авторизации'); return; }
    retryAfter = 0;
    realtimeStart();
    sync(true);
  }
  function prompt(title, next) {
    if (!L.Input || !L.Input.edit) return note('Не поддерживается ввод на этом устройстве');
    L.Input.edit({ value: '', title: title, free: true, nosave: true }, function (value) {
      var v = str(value);
      if (v) next(v);
    });
  }
  function login(register) {
    prompt('Email Lampa Sync Pro',function(email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return note('Некорректный email');
      }
      prompt('Пароль Lampa Sync Pro',function(password) {
        if (password.length < 6) return note('Пароль слишком короткий');
        var path = register ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
        request('POST',path,{email:email,password:password},null,function(err,data) {
          password = ''; // Password is never written to storage.
          if (err) return note('Авторизация не выполнена (' + str(err.code).slice(0,55) + ')');
          if (!data || !data.access_token) return note('Проверьте почту и подтвердите регистрацию');
          selectAccount(data);
          note('Аккаунт подключён');
        });
      });
    });
  }
  function logout() {
    realtimeStop();
    stopOnlineResume();
    cancelTorrentResume();
    cancelTorrentFocus();
    clearTorrPoll();
    lastTorrent=null;
    var oldJwt = state.auth && state.auth.access_token;
    state.auth = null;
    state.userId = '';
    state.outbox = [];
    state.snapshot = null;
    state.lastTorrent=null;
    state.revision = 0;
    state.seq = 0;
    state.deviceId = uuid();
    save();
    currentFull = null;
    if (oldJwt) request('POST','/auth/v1/logout',{},oldJwt,function () {});
    note('Выход выполнен, локальный кэш очищен');
  }
  function mediaKey(card) {
    if (!card || typeof card !== 'object') return '';
    var kind = str(card.media_type || card.type).toLowerCase();
    var tv = kind === 'tv' || kind === 'series' || !!card.number_of_seasons || !!card.first_air_date ||
      (!!card.name && !card.title && !card.release_date);
    var id = str(card.tmdb_id || card.id);
    var source = str(card.source).toLowerCase();
    if (/^\d{1,12}$/.test(id) && (!source || source === 'tmdb' || source === 'themoviedb'))
      return 'tmdb:' + (tv ? 'tv' : 'movie') + ':' + id;
    var imdb = str(card.imdb_id);
    if (/^tt\d{1,12}$/.test(imdb)) return 'imdb:' + imdb;
    var kp = str(card.kinopoisk_id);
    if (/^\d{1,12}$/.test(kp)) return 'kinopoisk:' + kp;
    return '';
  }
  function parseEpisode(data) {
    var s = Math.floor(number(data && (data.season || data.__num_season)));
    var e = Math.floor(number(data && (data.episode || data.__num_episode)));
    if (s >= 0 && e > 0) return 's' + s + ':e' + e;
    var path = str(data && (data.path || data.path_human || data.file_path));
    var match = path.match(/\b[Ss](\d{1,3})[ ._\-]*[Ee](\d{1,4})\b/) ||
      path.match(/\b(\d{1,3})x(\d{1,4})\b/i);
    return match ? 's' + Number(match[1]) + ':e' + Number(match[2]) : '';
  }
  function sourceFrom(data, fallback) {
    var a = data || {}, b = fallback || {};
    var ownHash = str(a.torrent_hash || a.infohash).toUpperCase();
    var fallbackHash = str(b.torrent_hash || b.infohash).toUpperCase();
    if (ownHash && fallbackHash && ownHash!==fallbackHash) return null;
    var hash = ownHash || fallbackHash;
    var index = a.file_index != null ? a.file_index : (a.id != null ? a.id :
      (b.file_index != null ? b.file_index : b.id));
    var path = str(a.file_path || a.path || b.file_path || b.path);
    var title = str(a.torrent_title || a.path_human || b.torrent_title || b.path_human);
    var idx = Number(index);
    if (!/^([A-F0-9]{40}|[A-Z2-7]{32})$/.test(hash) || !isFinite(idx) ||
      idx < 0 || idx > 100000 || Math.floor(idx) !== idx ||
      path.length < 1 || path.length > 600 ||
      /^(?:https?:|magnet:)/i.test(path)) return null;
    return { infohash: hash, file_index: idx, file_path: path,
      torrent_title: title.slice(0,300) };
  }
  function getCard(data) {
    var d = data || {};
    if (d.card) return d.card;
    if (d.movie) return d.movie;
    if (d.isonline!==true && staged && staged.card && Date.now()-staged.at<100000) return staged.card;
    if (L.Activity && typeof L.Activity.active==='function') {
      var current=L.Activity.active() || {};
      if (current.movie || current.card) return current.movie || current.card;
    }
    if (staged && staged.card && Date.now()-staged.at<100000) return staged.card;
    return null;
  }
  function nativeOnlineRecipe(data,card) {
    if(!data || !card || !L.Storage)return null;
    var meta=data.lampac_resume || {};
    var inherited=meta.recipe || meta;
    var supplied=inherited.mode==='online' && inherited.online ? inherited.online : null;
    if(!supplied && data.isonline!==true)return null;
    supplied=supplied || {};
    var balancer=str(supplied.balanser);
    if(!balancer) {
      try{balancer=str(typeof L.Storage.field==='function' ?
        L.Storage.field('active_balanser'):L.Storage.get('active_balanser',''));}
      catch(ignore){return null;}
    }
    if(!/^[A-Za-z0-9_.-]{1,64}$/.test(balancer))return null;
    var choices={};
    try{choices=L.Storage.get('online_choice_'+balancer,{}) || {};}catch(ignore){}
    if(typeof choices==='string'){try{choices=JSON.parse(choices);}catch(ignore){choices={};}}
    var choice=choices[card.id] || {}, id=str(supplied.voice_id || data.voice_id || choice.voice_id);
    if(!/^[A-Za-z0-9_.:-]{0,100}$/.test(id))id='';
    var season=supplied.season_index!=null?supplied.season_index:choice.season;
    var voice=supplied.voice_index!=null?supplied.voice_index:choice.voice;
    return {balanser:balancer,voice_id:id,
      voice_name:str(supplied.voice_name || data.voice_name || choice.voice_name).slice(0,100),
      season_index:Math.max(0,Math.min(1000,Math.floor(number(season)))),
      voice_index:Math.max(0,Math.min(1000,Math.floor(number(voice))))};
  }
  function makeContext(data) {
    var d = data || {};
    var fallback = staged && Date.now() - staged.at < 100000 ? staged.file : null;
    var card = getCard(d) || (fallback && fallback.card);
    var torrent=d.isonline===true ? null : sourceFrom(d,fallback);
    var online=torrent ? null : nativeOnlineRecipe(d,card);
    var src=torrent || online;
    var media = mediaKey(card);
    if (!src || !media) return null;
    var episode = /^tmdb:movie:/.test(media) || (!!card && card.release_date && !card.first_air_date &&
      !card.number_of_seasons) ? 'movie' : (parseEpisode(d) || parseEpisode(fallback));
    if (!episode) return null;
    return {card:card,media_key:media,episode_key:episode,recipe:src,
      source_kind:torrent?'torrent':'lampac',
      timeline_hash: str(d.timeline_hash || d.timeline && d.timeline.hash ||
        fallback && (fallback.timeline_hash || fallback.timeline && fallback.timeline.hash)),
      session_id: uuid(), position: 0, duration: 0, lastSent: 0, confirmed: false,
      completed: false, external: false };
  }
  function newEvent(ctx, kind) {
    if (!state.auth || !ctx || !ctx.session_id || !state.deviceId) return;
    var evt = { schema: 1, event_id: uuid(), device_id: state.deviceId,
      device_seq: ++state.seq, base_revision: state.revision, kind: kind,
      media_key: ctx.media_key, episode_key: ctx.episode_key,
      playback_session_id: ctx.session_id, source_kind: ctx.source_kind || 'torrent',
      source_recipe: ctx.recipe, position_seconds: Math.round(ctx.position),
      duration_seconds: Math.round(ctx.duration) };
    if (!evt.event_id) return;
    state.outbox.push(evt);
    if (state.outbox.length > 700) {
      for (var i=0;i<state.outbox.length-600;i++) {
        if (state.outbox[i].kind==='progress') { state.outbox.splice(i,1); break; }
      }
    }
    save();
    scheduleSync();
  }
  function checkpoint(ctx, kind, force) {
    if (!ctx || !ctx.confirmed || !state.auth) return;
    var now = Date.now();
    if (!force && now - ctx.lastSent < 20000) return;
    if (ctx.completed && kind !== 'completed') return;
    ctx.lastSent = now;
    if (!ctx.completed && ctx.duration >= 60 && ctx.position / ctx.duration >= 0.9) {
      ctx.completed = true;
      kind = 'completed';
    }
    newEvent(ctx,kind);
  }
  function updateProgress(e) {
    if (!active || !active.confirmed || active.external || !e ||
        (e.current==null && e.time==null)) return;
    var p = number(e.current != null ? e.current : e.time);
    var dur = number(e.duration);
    if (p < 0 || p > 86400 || dur < 0 || dur > 86400) return;
    if (dur) active.duration = Math.round(dur);
    active.position = Math.max(0,Math.round(p));
    if (active.position>0) active.hasPlayerProgress=true;
    checkpoint(active,'progress',false);
  }
  function subscribe(listener,kind,handler) {
    if (listener && typeof listener.follow==='function') {
      listener.follow(kind,handler);
      subscriptions.push({listener:listener,kind:kind,handler:handler});
    }
  }
  function startCapture(data, external) {
    if (!state.auth || !option('capture',true)) return;
    if (!active || !active.session_id) active = makeContext(data);
    if (!active || !active.session_id || active.confirmed) return;
    var d = data || {};
    if (active.source_kind==='torrent' && d.url && staged && staged.file && staged.file.url &&
        d.url !== staged.file.url &&
        str(d.url).toUpperCase().indexOf(active.recipe.infohash) < 0 &&
        Date.now()-staged.at<100000) {
      active = null;
      return;
    }
    active.confirmed = true;
    active.external = external;
    active.owner = state.userId;
    if(active.source_kind==='torrent') {
      lastTorrent=active;
      rememberLastTorrent(active);
    }
    if (d.timeline && number(d.timeline.time) >= 0) active.position = Math.round(number(d.timeline.time));
    if (d.timeline && number(d.timeline.duration) > 0) active.duration = Math.round(number(d.timeline.duration));
    newEvent(active,'started');
    if(active.source_kind==='torrent')startTorrPoll(active);
  }

  function clearTorrPoll() {
    if (torrPoll) { clearInterval(torrPoll); torrPoll=null; }
  }
  function rememberLastTorrent(ctx) {
    if (!ctx || !ctx.session_id || !ctx.recipe) return;
    state.lastTorrent = {
      media_key:ctx.media_key,episode_key:ctx.episode_key,recipe:ctx.recipe,
      session_id:ctx.session_id,updated_at:Date.now(),
      position:Math.round(ctx.position||0),duration:Math.round(ctx.duration||0)
    };
    save();
  }
  function restoreLastTorrent() {
    var data=state.lastTorrent;
    if (!data || !state.auth || !state.userId) return;
    if (!data.recipe || !data.recipe.infohash) return;
    lastTorrent={media_key:data.media_key,episode_key:data.episode_key,
      recipe:data.recipe,session_id:data.session_id,
      confirmed:true,external:true,owner:state.userId,
      position:Math.max(0,number(data.position)),
      duration:Math.max(0,number(data.duration)),lastSent:0,completed:false};
  }
  function trackTimecodeEnabled() {
    if (!L.Storage) return false;
    try {
      var val=typeof L.Storage.field==='function' ?
        L.Storage.field('torrserver_tracktimecode') :
        L.Storage.get('torrserver_tracktimecode',false);
      return val===true || val==='true';
    } catch(e){ return false; }
  }
  function viewedRequest(hash,callback) {
    if (!trackTimecodeEnabled())
      return callback(new Error('Включите TrackTimecode в Lampa'));
    if (!L.Torserver) return callback(new Error('TorrServer недоступен'));
    var responded=false,timeout=setTimeout(function(){
      deliver(new Error('Нет ответа /viewed'));
    },6500);
    function deliver(error,response) {
      if (responded || STOPPED) return;
      responded=true;
      clearTimeout(timeout);
      if (error) return callback(error);
      var list=response;
      if (typeof list==='string') {
        try { list=JSON.parse(list); } catch (e) { list=null; }
      }
      if (!Array.isArray(list)) return callback(new Error('Неверный ответ /viewed'));
      callback(null,list);
    }
    try {
      if (typeof L.Torserver.viewed==='function') {
        L.Torserver.viewed(hash,function(items){deliver(null,items);},function(){deliver(new Error('Ошибка /viewed'));});
      } else if (typeof L.Reguest==='function' && typeof L.Torserver.url==='function') {
        var request=new L.Reguest();
        if (typeof request.timeout==='function') request.timeout(6000);
        request.silent(L.Torserver.url()+'/viewed',function(items){deliver(null,items);},
          function(){deliver(new Error('Ошибка /viewed'));},
          JSON.stringify({action:'list',hash:hash}));
      } else {
        deliver(new Error('Нет API /viewed'));
      }
    } catch(e) { deliver(new Error('Не удалось запросить /viewed')); }
  }
  function knownCloudPosition(ctx) {
    var records=state.snapshot && state.snapshot.source_progress || [];
    var key='torrent:'+str(ctx.recipe.infohash).toUpperCase()+':'+String(ctx.recipe.file_index);
    var pos=0;
    for (var i=0;i<records.length;i++){
      var row=records[i];
      if (row.media_key===ctx.media_key && row.episode_key===ctx.episode_key &&
        row.source_key===key && !row.deleted) {
        pos=Math.max(0,number(row.position_seconds));
        if (!ctx.duration && number(row.duration_seconds)>0)
          ctx.duration=Math.round(number(row.duration_seconds));
        break;
      }
    }
    return pos;
  }
  function captureTorrViewed(ctx,kind,manual,done) {
    done=typeof done==='function' ? done : function() {};
    if (!ctx || !ctx.confirmed || !state.auth || !option('capture',true))
      return done(new Error('Просмотр не активен'));
    if (ctx.owner!==state.userId || (active && active!==ctx))
      return done(new Error('Изменился сеанс просмотра'));
    if (!ctx.recipe || !/^([0-9A-F]{40}|[A-Z2-7]{32})$/.test(str(ctx.recipe.infohash).toUpperCase()) ||
        !isFinite(Number(ctx.recipe.file_index)) ||
        Number(ctx.recipe.file_index)<1) return done(new Error('Неизвестен файл торрента'));
    if (ctx.viewedPending) return done(new Error('Проверка уже выполняется'));
    ctx.viewedPending=true;
    var owner=state.userId, session=ctx.session_id;
    viewedRequest(ctx.recipe.infohash,function(err,list) {
      ctx.viewedPending=false;
      if (owner!==state.userId || session!==ctx.session_id || (active && active!==ctx))
        return done(new Error('Сеанс завершён'));
      if (err) { torrStatus=err.message;return done(err); }
      var row=null, fileId=Number(ctx.recipe.file_index);
      for (var i=0;i<list.length;i++) {
        var item=list[i];
        if (item && Number(item.file_index)===fileId &&
           str(item.hash).toUpperCase()===str(ctx.recipe.infohash).toUpperCase()) {
          row=item;break;
        }
      }
      var seconds=row && Number(row.timecode);
      if (!isFinite(seconds) || seconds<=0 || seconds>86400) {
        torrStatus='empty';
        return done(null,0);
      }
      seconds=Math.round(seconds);
      var previous=ctx.viewedLastSeen;
      ctx.viewedLastSeen=seconds;
      torrStatus='timecode:'+seconds;
      if (ctx.hasPlayerProgress) return done(null,seconds);
      // Do not interpret an unchanged old TorrServer checkpoint as a newer seek.
      var cloud=knownCloudPosition(ctx);
      var changed=previous!==undefined && previous!==seconds;
      var newlyAvailable=previous===undefined && seconds>cloud &&
        (!ctx.position || seconds>ctx.position);
      if ((changed || newlyAvailable) && seconds!==ctx.viewedLastEmitted) {
        ctx.position=seconds;
        ctx.viewedLastEmitted=seconds;
        checkpoint(ctx,kind==='stopped'?'stopped':'progress',true);
        rememberLastTorrent(ctx);
      }
      done(null,seconds);
    });
  }
  function startTorrPoll(ctx) {
    clearTorrPoll();
    if (!trackTimecodeEnabled() || !ctx || !ctx.confirmed) return;
    setTimeout(function(){
      if (!STOPPED && ctx===active) captureTorrViewed(ctx,'progress',false,function(){});
    },1500);
    torrPoll=setInterval(function(){
      if (!STOPPED && ctx===active) captureTorrViewed(ctx,'progress',false,function(){});
    },15000);
  }
  function installCapture() {
    if (!L.Player || !L.Player.listener) return;
    subscribe(L.Listener,'torrent_file',function(e) {
      if (!e || e.type!=='onenter' || !e.element) return;
      var file = e.element;
      staged = { file: file, card: file.card || e.params && e.params.movie, at: Date.now() };
    });
    subscribe(L.Player.listener,'create',function(e) {
      clearTorrPoll();
      active = makeContext(e && e.data || e);
    });
    subscribe(L.Player.listener,'start',function(e) {
      startCapture(e && e.data || e,false);
    });
    subscribe(L.Player.listener,'external',function(e) {
      startCapture(e && e.data || e,true);
    });
    subscribe(L.Player.listener,'destroy',function() {
      var ctx=active;
      clearTorrPoll();
      active=null;
      staged=null;
      if (ctx && ctx.confirmed) {
        if (ctx.source_kind!=='lampac' && ctx.external && !ctx.position) {
          captureTorrViewed(ctx,'stopped',false,function() {});
          // External players may persist their timecode after the stream closes.
          setTimeout(function() {
            if (!STOPPED && state.userId===ctx.owner && !active && lastTorrent===ctx)
              captureTorrViewed(ctx,'stopped',false,function() {});
          },2500);
        } else if (ctx.position>0) checkpoint(ctx,'stopped',true);
      }
    });
    if (L.PlayerVideo && L.PlayerVideo.listener) {
      subscribe(L.PlayerVideo.listener,'timeupdate',updateProgress);
      subscribe(L.PlayerVideo.listener,'pause',function() { checkpoint(active,'paused',true); });
      subscribe(L.PlayerVideo.listener,'ended',function() {
        if (!active || active.external) return;
        if (active.duration) active.position = active.duration;
        checkpoint(active,'completed',true);
      });
    }
    if (L.Timeline && L.Timeline.listener) {
      subscribe(L.Timeline.listener,'update',function(e) {
        if (!active || !active.confirmed || !e || !e.data) return;
        if (!active.timeline_hash || str(e.data.hash)!==active.timeline_hash) return;
        var road = e.data.road || {};
        if (road.time==null) return;
        var p = number(road.time), dur = number(road.duration);
        if (p<0 || p>86400 || dur<0 || dur>86400) return;
        active.position = Math.round(p);
        if (dur>0) active.duration = Math.round(dur);
        if (active.position>0) active.hasPlayerProgress=true;
        checkpoint(active,'progress',false);
      });
    }
  }
  function scheduleSync() {
    if (sendTimer || STOPPED || !state.auth) return;
    sendTimer = setTimeout(function() { sendTimer=null; sync(false); },1800);
  }
  function applyRemote(snapshot) {
    if (!snapshot || snapshot.status!=='ok') return;
    state.snapshot = snapshot;
    resumeOverrides = {};
    state.revision = Math.max(0,Math.floor(number(snapshot.revision)));
    save();
    if (currentFull) updateFull(currentFull);
    notifyState();
  }
  function rebaseRemainder(startAt,revision,acknowledged,ignored) {
    // Do NOT rebase events from a different media/session or after a stale write:
    // otherwise an offline queue could overwrite newer progress from another device.
    if (ignored) return;
    var sessions = {};
    acknowledged.forEach(function(e) {
      if (e.playback_session_id) {
        sessions[e.media_key + '|' + e.episode_key + '|' + e.playback_session_id] = true;
      }
    });
    state.outbox.forEach(function(e) {
      var key = e.media_key + '|' + e.episode_key + '|' + e.playback_session_id;
      if (e.base_revision === startAt && sessions[key]) e.base_revision = revision;
    });
  }
  function readSnapshot(done,owner) {
    rpc('lsp_sync_snapshot',{},function(err,data) {
      if (owner !== state.userId) return done(new Error('account_changed'));
      if (!err && data && data.status==='ok') applyRemote(data);
      done(err,data);
    });
  }
  function flushQueue(done,owner) {
    if (owner !== state.userId) return done(new Error('account_changed'));
    if (!state.outbox.length) return done(null);
    var batch = state.outbox.slice(0,50);
    var base = state.revision;
    rpc('lsp_sync_push',{p_events:batch,p_expected_revision:base},function(err,data) {
      if (owner !== state.userId) return done(new Error('account_changed'));
      if (err) return done(err);
      if (!data) return done(new Error('empty_push_response'));
      if (data.status==='conflict') {
        state.revision = Math.max(0,Math.floor(number(data.revision)));
        save();
        return flushQueue(done,owner); // A stale base_revision is intentionally NOT rebased here.
      }
      if (data.status!=='ok') return done(new Error('unexpected_push_response'));
      if (number(data.ignored)>0) note('Часть устаревших изменений пропущена: ' + data.ignored);
      state.outbox.splice(0,batch.length);
      state.revision = Math.max(0,Math.floor(number(data.revision)));
      rebaseRemainder(base,state.revision,batch,number(data.ignored));
      save();
      flushQueue(done,owner);
    });
  }
  function sync(userInitiated, skipTorrRead) {
    if (STOPPED || !loaded || !state.auth) {
      if (userInitiated) note('Сначала войдите в аккаунт');
      return;
    }
    if (networkBusy) {
      if (userInitiated) note('Синхронизация уже выполняется');
      return;
    }
    if (!userInitiated && Date.now()<retryAfter) return;
    if (userInitiated && !skipTorrRead && lastTorrent &&
        state.userId===lastTorrent.owner) {
      return captureTorrViewed(lastTorrent,'progress',true,function() {
        sync(true,true);
      });
    }
    networkBusy = true;
    var owner = state.userId;
    readSnapshot(function(error) {
      if (error) return finish(error);
      flushQueue(function(err) {
        if (err) return finish(err);
        readSnapshot(function(last) { finish(last); },owner);
      },owner);
    },owner);
    function finish(err) {
      networkBusy = false;
      if (err) {
        retryAfter = Date.now()+45000;
        if (userInitiated) note('Сеть или API недоступны (' + str(err.code || err.message).slice(0,40) + ')');
      } else {
        retryAfter = 0;
        lastSuccessfulSync = Date.now();
        if (userInitiated) note('Синхронизировано. Ревизия ' + state.revision);
      }
      if (rtJoinCatchup && rtJoined && !STOPPED && !err) {
        rtJoinCatchup=false;
        return sync(false);
      }
      rtJoinCatchup=false;
      realtimeDrain();
      if (!err && state.outbox.length && !STOPPED) scheduleSync();
    }
  }
  function realtimeAllowed() {
    return !STOPPED && loaded && !!state.auth && validUUID(state.userId) &&
      !(win.document && win.document.visibilityState==='hidden') &&
      (!win.navigator || win.navigator.onLine!==false);
  }
  function realtimeClearTimers() {
    if (rtHeartbeat) clearInterval(rtHeartbeat);
    if (rtJoinTimeout) clearTimeout(rtJoinTimeout);
    if (rtReconnect) clearTimeout(rtReconnect);
    if (rtAuthTimer) clearTimeout(rtAuthTimer);
    if (rtPullTimer) clearTimeout(rtPullTimer);
    rtHeartbeat=rtJoinTimeout=rtReconnect=rtAuthTimer=rtPullTimer=null;
  }
  function realtimeStop() {
    realtimeClearTimers();
    var socket=rtSocket;
    rtSocket=null;
    rtAccount='';
    rtTopic='';
    rtJoined=false;
    rtStarting=false;
    rtJoinRef='';
    rtSubscriptions=[];
    rtPingRef='';
    rtPingAt=0;
    rtPendingRevision=0;
    rtJoinCatchup=false;
    rtAttempt=0;
    rtState='disconnected';
    if (socket) {
      try {
        socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;
        socket.close();
      } catch(ignore){}
    }
  }
  function realtimeRetry() {
    if (!realtimeAllowed() || rtReconnect) return;
    rtAttempt=Math.min(rtAttempt+1,6);
    var wait=Math.min(30000,1000*Math.pow(2,rtAttempt-1));
    rtState='reconnecting';
    rtReconnect=setTimeout(function(){
      rtReconnect=null;
      realtimeStart();
    },wait);
  }
  function realtimeDrop(socket) {
    if (socket && rtSocket!==socket) return;
    if (rtHeartbeat) clearInterval(rtHeartbeat);
    if (rtJoinTimeout) clearTimeout(rtJoinTimeout);
    if (rtAuthTimer) clearTimeout(rtAuthTimer);
    rtHeartbeat=rtJoinTimeout=rtAuthTimer=null;
    rtJoined=false;
    rtStarting=false;
    rtSubscriptions=[];
    rtPingRef='';
    rtPingAt=0;
    var previous=rtSocket;
    rtSocket=null;
    try{
      if(previous){
        previous.onopen=previous.onmessage=previous.onerror=previous.onclose=null;
        previous.close();
      }
    }catch(ignore){}
    if (realtimeAllowed()) realtimeRetry();
    else rtState='paused';
  }
  function realtimeSend(topic,event,payload,joinRef) {
    if (!rtSocket || rtSocket.readyState!==1) return '';
    var ref=String(++rtRef);
    try {
      rtSocket.send(JSON.stringify({
        topic:topic,event:event,payload:payload||{},ref:ref,
        join_ref:event==='phx_join' ? ref : (joinRef===undefined?rtJoinRef:joinRef)
      }));
      return ref;
    }catch(e){return '';}
  }
  function realtimeAuthSchedule() {
    if (rtAuthTimer) clearTimeout(rtAuthTimer);
    rtAuthTimer=null;
    if (!rtJoined || !state.auth || rtAccount!==state.userId) return;
    var delay=Math.max(1000,number(state.auth.expires_at)-Date.now()-65000);
    rtAuthTimer=setTimeout(function(){
      rtAuthTimer=null;
      var account=rtAccount, socket=rtSocket;
      token(function(err,jwt){
        if (!rtJoined || rtSocket!==socket || rtAccount!==account) return;
        if (err || !jwt || !realtimeSend(rtTopic,'access_token',{access_token:jwt}))
          return realtimeDrop(socket);
        realtimeAuthSchedule();
      });
    },delay);
  }
  function realtimeHeartbeatStart(socket) {
    if (rtHeartbeat) clearInterval(rtHeartbeat);
    rtHeartbeat=setInterval(function(){
      if (rtSocket!==socket || !rtJoined) return;
      if (rtPingRef && Date.now()-rtPingAt>45000)
        return realtimeDrop(socket);
      if (!rtPingRef) {
        rtPingRef=realtimeSend('phoenix','heartbeat',{},null);
        rtPingAt=Date.now();
        if (!rtPingRef) realtimeDrop(socket);
      }
    },20000);
  }
  function realtimeDrain() {
    if (!rtPendingRevision || rtPendingRevision<=state.revision) {
      rtPendingRevision=0;
      return;
    }
    if (networkBusy || rtPullTimer || STOPPED || !state.auth) return;
    var wait=Math.max(300,retryAfter-Date.now());
    rtPullTimer=setTimeout(function(){
      rtPullTimer=null;
      if (!rtPendingRevision || rtPendingRevision<=state.revision) {
        rtPendingRevision=0;return;
      }
      if (networkBusy) return;
      rtPendingRevision=0;
      sync(false);
    },wait);
  }
  function realtimeMessage(socket,event) {
    if (!event || rtSocket!==socket || rtAccount!==state.userId) return;
    var msg;
    try {msg=JSON.parse(event.data);}catch(ignore){return;}
    if (!msg || typeof msg!=='object' || Array.isArray(msg)) return;
    if (msg.event==='phx_reply' && msg.topic==='phoenix' && msg.ref===rtPingRef) {
      rtPingRef='';rtPingAt=0;return;
    }
    if (msg.topic!==rtTopic) return;
    if (msg.event==='phx_reply' && msg.ref===rtJoinRef) {
      if (!msg.payload || msg.payload.status!=='ok' ||
          !msg.payload.response || !Array.isArray(msg.payload.response.postgres_changes) ||
          !msg.payload.response.postgres_changes.length) return realtimeDrop(socket);
      rtSubscriptions=msg.payload.response.postgres_changes.map(function(item){return String(item.id);});
      rtJoined=true;
      rtState='connected';
      rtAttempt=0;
      if (rtJoinTimeout) clearTimeout(rtJoinTimeout);
      rtJoinTimeout=null;
      realtimeHeartbeatStart(socket);
      realtimeAuthSchedule();
      // Always fill the HTTP -> subscription gap, even if an older sync is in flight.
      rtJoinCatchup=true;
      if (!networkBusy) {
        rtJoinCatchup=false;
        sync(false);
      }
      return;
    }
    if (msg.event==='phx_error' || msg.event==='phx_close') return realtimeDrop(socket);
    if (msg.event==='system' && msg.payload && msg.payload.extension==='postgres_changes' &&
        msg.payload.status && msg.payload.status!=='ok') return realtimeDrop(socket);
    if (!rtJoined || msg.event!=='postgres_changes') return;
    var payload=msg.payload || {};
    var ids=payload.ids || [];
    if (!Array.isArray(ids) || !ids.some(function(id){
      return rtSubscriptions.indexOf(String(id))>=0;
    })) return;
    var data=payload.data||{},row=data.record||{};
    if (data.schema!=='public' || data.table!=='lsp_sync_heads' ||
        (data.type!=='INSERT' && data.type!=='UPDATE') ||
        str(row.user_id).toLowerCase()!==state.userId.toLowerCase()) return;
    var rev=Number(row.revision);
    if (!isFinite(rev) || rev<0 || Math.floor(rev)!==rev || rev<=state.revision) return;
    rtLastEventAt=Date.now();
    rtPendingRevision=Math.max(rtPendingRevision,rev);
    realtimeDrain();
  }
  function realtimeStart() {
    if (!realtimeAllowed()) {
      if (!win.WebSocket) rtState='unsupported';
      return;
    }
    if (typeof win.WebSocket!=='function') {
      rtState='unsupported';
      return; // Manual sync and foreground REST remain available.
    }
    if (rtSocket || rtStarting || rtReconnect) return;
    rtStarting=true;
    rtState='connecting';
    var account=state.userId;
    token(function(err,jwt){
      if (STOPPED || !realtimeAllowed() || state.userId!==account) {
        rtStarting=false;return;
      }
      if (err || !jwt) {
        rtStarting=false;
        return realtimeRetry();
      }
      var socket;
      try {
        socket=new win.WebSocket(BASE.replace(/^http/,'ws')+
          '/realtime/v1/websocket?apikey='+encodeURIComponent(KEY)+'&vsn=1.0.0');
      } catch(e) {
        rtStarting=false;
        return realtimeRetry();
      }
      rtSocket=socket;
      rtAccount=account;
      rtTopic='realtime:lsp-sync-'+account;
      socket.onopen=function(){
        if (socket!==rtSocket || account!==state.userId) return;
        rtStarting=false;
        rtJoinRef=realtimeSend(rtTopic,'phx_join',{
          config:{private:false,postgres_changes:[{
            event:'*',schema:'public',table:'lsp_sync_heads',
            filter:'user_id=eq.'+account
          }]},
          access_token:jwt
        },null);
        if (!rtJoinRef) return realtimeDrop(socket);
        rtJoinTimeout=setTimeout(function(){
          rtJoinTimeout=null;
          if (rtSocket===socket && !rtJoined) realtimeDrop(socket);
        },12000);
      };
      socket.onmessage=function(event){realtimeMessage(socket,event);};
      socket.onerror=function(){realtimeDrop(socket);};
      socket.onclose=function(){realtimeDrop(socket);};
    });
  }
  function notifyState() {
    stateListeners.slice().forEach(function(listener) {
      try{listener(state.revision);}catch(ignore){}
    });
  }
  function onStateChange(listener) {
    if(typeof listener!=='function')return function(){};
    stateListeners.push(listener);
    return function(){stateListeners=stateListeners.filter(function(x){return x!==listener;});};
  }
  function getEpisodeState(card,episode) {
    var key=typeof card==='string'?card:mediaKey(card);
    var ep=str(episode);
    if(!key || !/^(movie|s\d{1,3}:e\d{1,4})$/.test(ep))return null;
    for(var i=state.outbox.length-1;i>=0;i--){
      var e=state.outbox[i];
      if(e.media_key!==key || e.episode_key!==ep)continue;
      if(e.kind==='marked_complete'||e.kind==='completed')return {state:'completed',pending:true};
      if(e.kind==='marked_unwatched'||e.kind==='deleted')return {state:'reset',pending:true};
      if(e.kind==='started'||e.kind==='progress')return {state:'in_progress',pending:true};
    }
    var rows=state.snapshot && state.snapshot.watch_state || [];
    for(var j=0;j<rows.length;j++){
      var row=rows[j];
      if(row.media_key===key && row.episode_key===ep)
        return {state:row.deleted?'reset':row.state,revision:row.updated_revision};
    }
    return null;
  }
  function markEpisode(card,episode,watched) {
    if(!loaded || !state.auth || !state.deviceId)return false;
    var key=typeof card==='string'?card:mediaKey(card),ep=str(episode);
    if(!/^(tmdb:(tv|movie):\d{1,12}|imdb:tt\d{1,12}|kinopoisk:\d{1,12})$/.test(key) ||
      !/^(movie|s\d{1,3}:e\d{1,4})$/.test(ep) ||
      (ep!=='movie' && Number((ep.match(/:e(\d+)$/)||[])[1])<1))return false;
    var event={schema:1,event_id:uuid(),device_id:state.deviceId,
      device_seq:++state.seq,base_revision:state.revision,
      kind:watched?'marked_complete':'marked_unwatched',
      media_key:key,episode_key:ep};
    if(!event.event_id)return false;
    state.outbox.push(event);save();notifyState();scheduleSync();
    return true;
  }
  function importLegacyHistory() {
    if(!loaded || !state.auth)return note('Сначала войдите в Lampa Sync Pro');
    if(!L.Storage || typeof L.Storage.get!=='function')
      return note('Хранилище Lampa недоступно');
    var history;
    try{history=L.Storage.get('lampac_resume_history_v1',null);}
    catch(ignore){history=null;}
    if(typeof history==='string'){
      try{history=JSON.parse(history);}catch(ignore){history=null;}
    }
    if(!history || Number(history.schema)!==1 || !history.cards ||
      typeof history.cards!=='object' || Array.isArray(history.cards))
      return note('История «Продолжить просмотр» не найдена');
    var count=0, existing={};
    var snap=state.snapshot || {};
    (snap.resume_pointers||[]).forEach(function(x){existing[x.media_key]=true;});
    (snap.watch_state||[]).forEach(function(x){existing[x.media_key]=true;});
    state.outbox.forEach(function(x){existing[x.media_key]=true;});
    Object.keys(history.cards).slice(0,1000).forEach(function(k){
      if(count>=50)return;
      var entry=history.cards[k] || {}, aliases=entry.aliases || [];
      if(!Array.isArray(aliases))return;
      var media='';
      aliases.some(function(a){if(/^tmdb:\d{1,12}$/.test(a)){media='tmdb:tv:'+a.slice(5);return true;}return false;});
      if(!media)aliases.some(function(a){if(/^imdb:tt\d{1,12}$/.test(a)){media=a;return true;}return false;});
      if(!media)aliases.some(function(a){if(/^kinopoisk:\d{1,12}$/.test(a)){media=a;return true;}return false;});
      if(!media || existing[media])return;
      var modes=entry.modes || {}, candidates=[];
      ['torrent','online'].forEach(function(mode){
        var x=modes[mode];
        if(!x || !x.episode || Number(x.episode.episode)<1 || Number(x.episode.season)<0)return;
        candidates.push(x);
      });
      if(!candidates.length)return;
      candidates.sort(function(a,b){return number(b.updated_at)-number(a.updated_at);});
      var item=candidates[0], ep='s'+Math.floor(number(item.episode.season))+':e'+
        Math.floor(number(item.episode.episode));
      if(!/^s\d{1,3}:e\d{1,4}$/.test(ep))return;
      var recipe=null, kind='';
      if(item.mode==='torrent'){
        recipe=sourceFrom(item.torrent || {},{});
        kind='torrent';
      } else if(item.mode==='online'){
        var alias=aliases.filter(function(x){return /^tmdb:\d/.test(x);})[0] || '';
        recipe=nativeOnlineRecipe({lampac_resume:{mode:'online',online:item.online||{}}},
          {id:Number(alias.slice(5)) || 0});
        kind='lampac';
      }
      if(!recipe)return;
      var progress=item.progress || {},seconds=Math.floor(number(progress.time)),
        duration=Math.floor(number(progress.duration));
      if(seconds<0 || seconds>86400 || duration<0 || duration>86400)return;
      if(duration>0 && seconds>duration+30)seconds=duration;
      var ctx={media_key:media,episode_key:ep,source_kind:kind,recipe:recipe,
        session_id:uuid(),position:seconds,duration:duration};
      if(!ctx.session_id)return;
      newEvent(ctx,'started');
      if(number(progress.percent)>=90 && duration>=60 && seconds>0)
        newEvent(ctx,'completed');
      existing[media]=true;
      count++;
    });
    if(!count)return note('Новых записей для импорта нет');
    note('Добавлено в очередь '+count+' записей. История ARST сохранена');
  }
  function findCachedResume(key) {
    if (Object.prototype.hasOwnProperty.call(resumeOverrides,key)) return resumeOverrides[key];
    var snapshot = state.snapshot || {};
    var pointers = snapshot.resume_pointers || [], sources = snapshot.source_progress || [];
    var states = snapshot.watch_state || [];
    for (var i=0;i<pointers.length;i++) {
      var p = pointers[i];
      if (p.media_key!==key) continue;
      for (var j=0;j<sources.length;j++) {
        var s = sources[j];
        if (s.media_key===key && s.episode_key===p.episode_key && s.source_key===p.source_key && !s.deleted) {
          var kind='in_progress';
          for (var k=0;k<states.length;k++) {
            if (states[k].media_key===key && states[k].episode_key===p.episode_key) {
              kind=states[k].state; break;
            }
          }
          return {media_key:key, episode_key:p.episode_key, source_key:s.source_key,
            source_kind:s.source_kind, source_recipe:s.source_recipe,
            position_seconds:s.position_seconds, duration_seconds:s.duration_seconds,
            watched_state:kind, revision:p.updated_revision};
        }
      }
    }
    return null;
  }
  function resumeEpisodeShort(rec) {
    var m=str(rec && rec.episode_key).match(/^s(\d{1,3}):e(\d{1,4})$/);
    if(!m)return 'Фильм';
    return 'S'+('0'+Number(m[1])).slice(-2)+'E'+('0'+Number(m[2])).slice(-2);
  }
  function labelResume(rec) {
    var ep = rec.episode_key === 'movie' ? 'фильм' : str(rec.episode_key).replace(/^s(\d+):e(\d+)$/,'С$1E$2');
    var sec = Math.floor(number(rec.position_seconds));
    var time = Math.floor(sec/60) + ':' + ('0'+(sec%60)).slice(-2);
    return '☁ Продолжить · ' + ep + ' · ' + (sec > 0 ? time : 'с начала');
  }
  function fullRoot(e) {
    if (e && e.body && typeof e.body.find==='function') return e.body;
    var activity = e && e.object && e.object.activity;
    if (activity && typeof activity.render==='function') {
      var value=activity.render();
      if (value && typeof value.find==='function') return value;
      return typeof win.$==='function' ? win.$(value) : null;
    }
    return null;
  }
  // Lampa's Start.Buttons.onGroupButtons() asynchronously calls
  // onPriorityButton(), which PREPENDS a cloned source button every time
  // the screen is toggled. DOM prepend alone cannot keep Continue first.
  // Flex order survives later priority clones, and preserves other plugins.
  function enforceCardActionOrder(toolbar,action) {
    var css=
      '.full-start-new__buttons > .view--lsp-resume,'+
      '.full-start__buttons > .view--lsp-resume{order:-3 !important;}'+
      '.full-start-new__buttons > .button--play,'+
      '.full-start__buttons > .button--play{order:-2 !important;}'+
      '.full-start-new__buttons > .button--priority,'+
      '.full-start__buttons > .button--priority{order:-1 !important;}';
    var doc=win.document, el=null;
    if (doc && typeof doc.createElement==='function') {
      try {
        el=typeof doc.getElementById==='function' ?
          doc.getElementById('lsp-card-action-order') : null;
        if (!el) {
          el=doc.createElement('style');
          el.id='lsp-card-action-order';
          var holder=doc.head || doc.documentElement || doc.body;
          if (holder && typeof holder.appendChild==='function')holder.appendChild(el);
        }
        if(el && el.textContent!==css)el.textContent=css;
      }catch(ignore){}
    }
    // Inline order also supports nonstandard full-screen themes.
    function order(elements,value) {
      if(elements && elements.length && typeof elements.css==='function')
        elements.css('order',String(value));
    }
    order(action,-3);
    order(toolbar.find('.button--play'),-2);
    order(toolbar.find('.button--priority'),-1);
  }
  function updateFull(e) {
    if (!state.auth || !e || e.type!=='complite') return;
    var card = e.data && e.data.movie;
    var key=mediaKey(card);
    var root=fullRoot(e);
    if (!key || !root || typeof win.$!=='function') return;
    // Both surfaces reuse the same cloud record, but live in distinct DOM
    // containers: the card toolbar and the native Play > Source picker.
    // Remove both before every update so Realtime refresh never duplicates them.
    root.find('.view--lsp-resume').remove();
    root.find('.view--lsp-resume-source').remove();
    var rec=findCachedResume(key);
    if (!rec || (rec.source_kind!=='torrent' && rec.source_kind!=='lampac')) return;
    var caption=labelResume(rec);
    function resumeAction() {
      if (rec.source_kind==='torrent') resumeTorrent(card,rec);
      else resumeOnline(card,rec,e);
    }
    function createResumeButton(className) {
      var showEpisode=className==='view--lsp-resume';
      var button=win.$('<div class="full-start__button selector '+className+'" role="button">'+
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '+
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
        '<path d="M4.6 9A8 8 0 1 1 4 12"/>'+
        '<path d="M4 4v5h5"/>'+
        '<path d="m10 8.5 5.5 3.5L10 15.5z" fill="currentColor" stroke="none"/>'+
        '</svg>'+(showEpisode ?
        '<strong class="lsp-resume-episode" '+
        'style="font-size:.8em;font-weight:600;white-space:nowrap;margin-left:.4em"></strong>' : '')+
        '<span></span></div>');
      if(showEpisode)button.find('.lsp-resume-episode').text(resumeEpisodeShort(rec));
      button.find('span').text(caption);
      button.attr('title',caption).attr('aria-label',caption);
      button.on('hover:enter',resumeAction);
      return button;
    }
    // Keep Continue first even after Lampa re-prepends a pinned source.
    // Other extensions retain their own handlers and relative order.
    var toolbar=root.find('.full-start-new__buttons').last();
    if (!toolbar.length) toolbar=root.find('.full-start__buttons').last();
    if (toolbar.length) {
      var action=createResumeButton('view--lsp-resume');
      toolbar.prepend(action);
      enforceCardActionOrder(toolbar,action);
    }
    // Second entry in Lampa's native source picker. The picker enumerates
    // direct children of hidden .buttons--container; this must be inserted
    // immediately after the Torrent source, not inside the visible toolbar.
    var torrent=root.find('.buttons--container > .view--torrent').last();
    if (torrent.length) torrent.after(createResumeButton('view--lsp-resume-source'));
    else {
      var sources=root.find('.buttons--container').last();
      if (sources.length) sources.prepend(createResumeButton('view--lsp-resume-source'));
    }
  }
  function visibleCard(e) {
    if (!e || e.type!=='complite') return;
    currentFull=e;
    updateFull(e);
    var card=e.data && e.data.movie;
    var key=mediaKey(card);
    if (!key || !state.auth || networkBusy) return;
    var owner=state.userId;
    rpc('lsp_get_resume',{p_media_key:key},function(err,rec) {
      if (err || STOPPED || owner!==state.userId || currentFull!==e) return;
      resumeOverrides[key]=rec || null;
      updateFull(e);
    });
  }
  function stopOnlineResume() {
    if(onlineResumeTimer){clearInterval(onlineResumeTimer);onlineResumeTimer=null;}
  }
  function onlinePrefs(card,recipe) {
    if(!L.Storage || typeof L.Storage.get!=='function' ||
      typeof L.Storage.set!=='function')return false;
    var b=str(recipe && recipe.balanser);
    if(!/^[A-Za-z0-9_.-]{1,64}$/.test(b) || !card || card.id==null)return false;
    function object(key) {
      var item=L.Storage.get(key,{}) || {};
      if(typeof item==='string'){try{item=JSON.parse(item);}catch(ignore){item={};}}
      return item && typeof item==='object' && !Array.isArray(item) ? item : {};
    }
    try{
      var last=object('online_last_balanser');
      last[card.id]=b;
      L.Storage.set('online_last_balanser',last);
      L.Storage.set('online_balanser',b);
      L.Storage.set('active_balanser',b);
      var key='online_choice_'+b, choices=object(key), prev=choices[card.id] || {};
      choices[card.id]={
        season:Math.max(0,Math.floor(number(recipe.season_index))),
        voice:Math.max(0,Math.floor(number(recipe.voice_index))),
        voice_id:str(recipe.voice_id),voice_name:str(recipe.voice_name),
        episodes_view:prev.episodes_view || {},movie_view:prev.movie_view || ''
      };
      L.Storage.set(key,choices);
      return true;
    }catch(ignore){return false;}
  }
  function resumeOnline(card,rec,fullEvent) {
    if(!rec || rec.source_kind!=='lampac' || !onlinePrefs(card,rec.source_recipe))
      return note('Онлайн-источник недоступен для восстановления');
    var root=fullRoot(fullEvent);
    if(!root)return note('Не удалось открыть онлайн-раздел');
    var action=root.find('.view--online').last();
    if(!action || !action.length || typeof action.trigger!=='function')
      return note('Онлайн-раздел недоступен');
    stopOnlineResume();
    var match=str(rec.episode_key).match(/^s(\d+):e(\d+)$/);
    if(!match) {action.trigger('hover:enter');return;}
    var desired=Number(match[2]),season=Number(match[1]),completed=rec.watched_state==='completed';
    var launched=false,startedAt=Date.now();
    function scan() {
      if(STOPPED || launched || Date.now()-startedAt>18000){
        stopOnlineResume();
        if(!launched && !STOPPED)note('Не удалось найти серию. Выберите её вручную');
        return;
      }
      if(!L.Activity || typeof L.Activity.active!=='function' || typeof win.$!=='function')return;
      var current=L.Activity.active() || {};
      if(current.component!=='lampac' || !current.activity ||
        typeof current.activity.render!=='function')return;
      var shown=current.movie || current.card ||
        current.activity.movie || current.activity.card;
      if(shown && mediaKey(shown) && mediaKey(card) && mediaKey(shown)!==mediaKey(card))
        return; // Never resume an unrelated show's episode from a stale online view.
      var panel=current.activity.render();
      if(!panel || typeof panel.find!=='function')panel=win.$(panel);
      if(!panel || typeof panel.find!=='function')return;
      var episodes=panel.find('.online-prestige--full');
      if(!episodes || !episodes.length || typeof episodes.each!=='function')return;
      var selected=null,next=null;
      episodes.each(function(i,node){
        var item=win.$(node);
        var text=str(item.find('.online-prestige__episode-number').text());
        var parsed=Number(text);
        if(parsed!==desired && (!completed || parsed!==desired+1))return;
        if(parsed===desired)selected=item;
        if(parsed===desired+1)next=item;
      });
      if(completed && next)selected=next;
      if(!selected || typeof selected.trigger!=='function')return;
      var hash=selected.find('.time-line').attr('data-hash');
      var seconds=completed && next ? 0 : Math.floor(number(rec.position_seconds));
      var duration=Math.floor(number(rec.duration_seconds));
      // Only seed a verified playlist hash; never overwrite an unrelated Timeline.
      if(hash && seconds>0 && L.Timeline && typeof L.Timeline.update==='function'){
        try{L.Timeline.update({hash:hash,time:seconds,duration:duration,
          percent:duration>0?Math.min(100,seconds/duration*100):0});}catch(ignore){}
      }
      launched=true;stopOnlineResume();
      try{selected.trigger('hover:enter');}catch(ignore){note('Не удалось открыть серию');}
    }
    // This short-lived scan watches the provider UI after a user click.
    // It is not a network poll or a cloud synchronization interval.
    onlineResumeTimer=setInterval(scan,180);
    try{action.trigger('hover:enter');scan();}
    catch(ignore){stopOnlineResume();note('Онлайн-раздел не открылся');}
  }
  function normalPath(v) { return str(v).replace(/\\/g,'/').replace(/^\/+/,'').toLowerCase(); }
  function torFiles(hash,cb) {
    if (!L.Torserver || typeof L.Torserver.files!=='function') return cb(new Error('torrserver_unavailable'));
    var fired=false, timer=setTimeout(function(){ if(!fired){fired=true;cb(new Error('timeout'));}},5000);
    function done(err,res){if(fired)return;fired=true;clearTimeout(timer);cb(err,res);}
    try {
      L.Torserver.files(hash,function(res) {
        if (!res || !(Array.isArray(res.file_stats) || Array.isArray(res.files))) return done(new Error('torrent_missing'));
        done(null,res);
      },function(){done(new Error('torrent_missing'));});
    } catch(e){done(e);}
  }
  function torHash(hash,recipe,cb) {
    if (!L.Torserver || typeof L.Torserver.hash!=='function') return cb(new Error('torrent_missing'));
    var fired=false, timer=setTimeout(function(){if(!fired){fired=true;cb(new Error('timeout'));}},15000);
    function done(err){if(fired)return;fired=true;clearTimeout(timer);cb(err);}
    try {
      L.Torserver.hash({title:str(recipe.torrent_title),link:'magnet:?xt=urn:btih:'+hash,
        poster:'',data:{lampa:true}},function(){done(null);},function(){done(new Error('torrent_unavailable'));});
    } catch(e){done(e);}
  }
  function cancelTorrentResume() {
    if (!torrentResumeJob) return;
    torrentResumeJob.cancelled = true;
    if (torrentResumeJob.timer) clearTimeout(torrentResumeJob.timer);
    torrentResumeJob = null;
  }
  function cancelTorrentFocus() {
    var job=torrentFocusJob;
    if(!job)return;
    torrentFocusJob=null;
    if(job.timer)clearTimeout(job.timer);
    if(job.deadline)clearTimeout(job.deadline);
    if(L.Listener && typeof L.Listener.remove==='function')
      L.Listener.remove('torrent_file',job.handler);
  }
  function openNativeTorrentFiles(card,rec,hash) {
    if(!L.Torrent || typeof L.Torrent.open!=='function' ||
      !L.Listener || typeof L.Listener.follow!=='function')return false;
    cancelTorrentFocus();
    var recipe=rec.source_recipe || {},key=mediaKey(card);
    var job={account:state.userId,timer:null,deadline:null,handler:null,item:null,
      attempts:0};
    torrentFocusJob=job;
    function valid() {
      return !STOPPED && torrentFocusJob===job && state.userId===job.account;
    }
    function focus() {
      if(!valid() || !job.item)return;
      var sc=L.Modal && L.Modal.scroll && L.Modal.scroll();
      var viewport=sc && sc.render && sc.render();
      var node=job.item[0];
      var el=viewport && viewport[0];
      var controller=L.Controller && L.Controller.enabled &&
        L.Controller.enabled();
      // The native torrent list emits "render" before Modal.update. Retry
      // just the UI focus, not file downloads, until the row is attached.
      if(!node || !el || (typeof el.contains==='function' && !el.contains(node)) ||
        (controller && controller.name!=='modal')) {
        if(job.attempts++<8)
          job.timer=setTimeout(focus,90);
        else cancelTorrentFocus();
        return;
      }
      try {
        L.Controller.collectionFocus(job.item,viewport);
        if(sc && typeof sc.update==='function')sc.update(job.item,true);
      }catch(ignore){}
      cancelTorrentFocus();
    }
    job.handler=function(e) {
      if(!valid()||!e)return;
      if(e.type==='list_close' || e.type==='onenter') {
        cancelTorrentFocus();return;
      }
      if(e.type!=='render' || !e.element || !e.item)return;
      var element=e.element;
      if(str(element.torrent_hash).toUpperCase()!==hash)return;
      if(e.params && e.params.movie && key &&
        mediaKey(e.params.movie) && mediaKey(e.params.movie)!==key)return;
      var samePath=normalPath(element.path)===normalPath(recipe.file_path);
      var sameIndex=Number(element.id)===Number(recipe.file_index);
      var match=(samePath && sameIndex) || samePath;
      if(!match) {
        var matchEpisode=str(rec.episode_key).match(/^s(\d+):e(\d+)$/);
        match=!!matchEpisode &&
          Number(element.season)===Number(matchEpisode[1]) &&
          Number(element.episode)===Number(matchEpisode[2]);
      }
      if(!match || job.item)return;
      // The native picker builds a fresh player item from local Timeline.
      // Transfer a verified cloud checkpoint to that item only, without
      // overwriting global Lampa Timeline, NUM, CUB or Trakt.
      if(element.timeline) {
        var second=Math.max(0,Math.floor(number(rec.position_seconds)));
        var duration=Math.max(0,Math.floor(number(rec.duration_seconds)));
        var complete=rec.watched_state==='completed' ||
          (duration>0 && second>=duration*0.9);
        if(complete) {
          // Replaying the already watched row should start from the beginning.
          element.timeline.time=0;
        } else if(second>0) {
          element.timeline.time=Math.max(number(element.timeline.time),second);
          element.timeline.duration=Math.max(number(element.timeline.duration),duration);
          element.timeline.percent=element.timeline.duration>0 ?
            Math.min(100,100*element.timeline.time/element.timeline.duration):0;
        }
      }
      job.item=e.item;
      job.timer=setTimeout(focus,80);
    };
    L.Listener.follow('torrent_file',job.handler);
    job.deadline=setTimeout(cancelTorrentFocus,45000);
    try{
      L.Torrent.open(hash,card);
      return true;
    }catch(ignore){cancelTorrentFocus();return false;}
  }
  function nativeTorrentSelectorAllowed() {
    // Native Torrent.open() on Android with external torrent-client mode
    // calls Android.playHash(), bypassing the file picker entirely.
    if(L.Platform && typeof L.Platform.is==='function' &&
      L.Platform.is('android')) {
      try{
        if(!L.Storage || !L.Storage.field ||
          !L.Storage.field('internal_torrclient'))return false;
      }catch(ignore){return false;}
    }
    return !!(L.Torrent && typeof L.Torrent.open==='function' &&
      L.Modal && L.Controller && typeof L.Controller.collectionFocus==='function');
  }
  function resumeTorrent(card,rec) {
    if (!rec || rec.source_kind!=='torrent') return note('Источник пока не поддерживается');
    var recipe=rec.source_recipe || {}, hash=str(recipe.infohash).toUpperCase();
    if (!/^([0-9A-F]{40}|[A-Z2-7]{32})$/.test(hash) ||
      !L.Torserver || !L.Torserver.files || !L.Torserver.stream || !L.Torserver.parse ||
      !L.Timeline || !L.Timeline.view || !L.Player || !L.Player.play || !L.Player.playlist) {
      return note('Плеер или TorrServer не поддерживает восстановление');
    }
    // TorrServer /torrents may accept a magnet before its file_stats are ready.
    // A second user click used to work because it allowed time for metadata.
    // Keep exactly one in-flight recovery; delays are bounded and cancellable.
    if (torrentResumeJob) {
      if (Date.now()-torrentResumeJob.startedAt<12000) return;
      cancelTorrentResume();
    }
    var job={startedAt:Date.now(),account:state.userId,cancelled:false,timer:null};
    torrentResumeJob=job;
    function alive(){return !STOPPED && !job.cancelled && torrentResumeJob===job &&
      job.account===state.userId;}
    function finishJob(){
      if (!alive()) return false;
      if (job.timer) {clearTimeout(job.timer);job.timer=null;}
      torrentResumeJob=null;
      job.cancelled=true;
      return true;
    }
    function delay(ms,fn) {
      if (!alive()) return;
      if (job.timer) clearTimeout(job.timer);
      job.timer=setTimeout(function(){
        job.timer=null;
        if (alive()) fn();
      },ms);
    }
    // Two reads of an already cached torrent before attempting hash-only add.
    function readFiles(afterAdd,attempt) {
      if (!alive()) return;
      torFiles(hash,function(err,response){
        if (!alive()) return; // Ignore late callbacks after a new request/logout.
        var items=response && (response.file_stats || response.files);
        if (!err && Array.isArray(items) && items.length) {
          if (finishJob()) launch(response);
          return;
        }
        if (!afterAdd) {
          if (attempt===0) return delay(550,function(){readFiles(false,1);});
          // Adding may fail when the hash already exists. Retry reads regardless.
          return torHash(hash,recipe,function(){
            delay(500,function(){readFiles(true,0);});
          });
        }
        var intervals=[700,1200,2200,3400];
        if (attempt<intervals.length)
          return delay(intervals[attempt],function(){readFiles(true,attempt+1);});
        if (finishJob()) note('Не удалось загрузить файлы торрента. Проверьте TorrServer');
      });
    }
    readFiles(false,0);
    function launch(response) {
      var files=(response.file_stats || response.files || []).slice();
      var formats=/\.(mkv|mp4|avi|mov|m4v|ts|m2ts|wmv|mpg|mpeg|vob)$/i;
      files=files.filter(function(file){return formats.test(str(file.path));});
      if(!files.length)return note('В раздаче нет видеофайлов');
      // Native Lampa renders exactly the same file cards as the Torrent
      // section; a saved episode is focused when torrent_file:render arrives.
      // The one-file case uses Select because native Lampa autoplays it after
      // ten seconds, contrary to the user's explicit episode-picker intent.
      if(files.length>1 && nativeTorrentSelectorAllowed() &&
        openNativeTorrentFiles(card,rec,hash))return;

      if(!L.Select || typeof L.Select.show!=='function')
        return note('Список файлов недоступен в этой версии Lampa');
      files.sort(function(a,b){return normalPath(a.path).localeCompare(normalPath(b.path));});
      var playlist=[],selected=null;
      files.forEach(function(file){
        try{
          var parsed=L.Torserver.parse({movie:card,files:files,
            filename:file.path_human||file.path,path:file.path});
          if(!parsed || !parsed.hash)return;
          var road=L.Timeline.view(parsed.hash,{card:card,
            season:parsed.season,episode:parsed.episode})||{};
          if(typeof road.handler!=='function')return;
          var item={card:card,id:file.id,path:file.path,torrent_hash:hash,
            season:parsed.season,episode:parsed.episode,
            url:L.Torserver.stream(file.path,hash,file.id),
            timeline:{hash:parsed.hash,handler:road.handler,
              time:number(road.time),duration:number(road.duration),
              percent:number(road.percent)}};
          playlist.push(item);
          var pathMatches=normalPath(file.path)===normalPath(recipe.file_path);
          if(pathMatches && (Number(file.id)===Number(recipe.file_index)||!selected))
            selected=item;
        }catch(ignore){}
      });
      if(!playlist.length)return note('Не удалось разобрать список файлов');
      if(!selected) {
        var match=str(rec.episode_key).match(/^s(\d+):e(\d+)$/);
        for(var i=0;match && i<playlist.length;i++){
          if(number(playlist[i].season)===Number(match[1]) &&
            number(playlist[i].episode)===Number(match[2])) {
            selected=playlist[i];break;
          }
        }
      }
      var options=playlist.map(function(file){
        var label=number(file.episode)>0 ?
          'С'+number(file.season)+' · Е'+number(file.episode) : str(file.path).split('/').pop();
        return {
          title:label,
          subtitle:str(file.path).split('/').pop(),
          selected:file===selected,
          onSelect:function(){
            var sec=0,dur=0;
            if(file===selected) {
              sec=number(rec.position_seconds);
              dur=number(rec.duration_seconds);
              if(rec.watched_state==='completed' ||
                (dur>0 && sec>=dur*0.9))sec=0;
            }
            file.timeline.time=Math.max(0,Math.round(sec));
            file.timeline.duration=Math.max(0,Math.round(dur))||file.timeline.duration;
            file.timeline.percent=file.timeline.duration ?
              Math.min(100,100*file.timeline.time/file.timeline.duration):0;
            staged={file:file,card:card,at:Date.now()};
            try {
              var opts={};Object.keys(file).forEach(function(k){opts[k]=file[k];});
              opts.playlist=playlist;opts.return_result=true;
              L.Player.play(opts);L.Player.playlist(playlist);
            }catch(ignore){note('Не удалось открыть плеер');}
          }
        };
      });
      L.Select.show({title:'Файлы торрента',items:options});
    }
  }
  function status() {
    return {version:VERSION,ready:loaded,authenticated:!!state.auth,
      email:state.auth && state.auth.email || '',revision:state.revision,
      queued:state.outbox.length,device:state.deviceId,storage:storageMode,
      capture:option('capture',true),busy:networkBusy,torrserver:torrStatus,
      realtime:rtState,lastRealtimeAt:rtLastEventAt,lastSyncAt:lastSuccessfulSync};
  }
  // Native Lampa and My Store recognize plugin source by the real Lampa. API usage.
  // Only update metadata of this own installation; never change other plugins.
  function registerIdentity() {
    if (!Lampa.Plugins || typeof Lampa.Plugins.get !== 'function') return;
    try {
      var installed = Lampa.Plugins.get() || [];
      var changed = false;
      for (var i = 0; i < installed.length; i++) {
        var item = installed[i];
        if (!item || !item.url) continue;
        var url = String(item.url);
        var githubRaw = /^https:\/\/raw\.githubusercontent\.com\/Alexgood321\/lampa-sync-pro\/[^/]+\/lampa-sync-pro\.js(?:[?#].*)?$/i.test(url);
        var jsdelivr = /^https:\/\/cdn\.jsdelivr\.net\/gh\/Alexgood321\/lampa-sync-pro@[^/]+\/lampa-sync-pro\.js(?:[?#].*)?$/i.test(url);
        var pages = /^https:\/\/Alexgood321\.github\.io\/lampa-sync-pro\/lampa-sync-pro\.js(?:[?#].*)?$/i.test(url);
        if (!githubRaw && !jsdelivr && !pages) continue;
        if (item.name !== 'Lampa Sync Pro') {
          item.name = 'Lampa Sync Pro'; changed = true;
        }
        if (item.author !== 'Alexgood321') {
          item.author = 'Alexgood321'; changed = true;
        }
        if (item.descr !== 'Синхронизация просмотра между устройствами (тестовая версия)') {
          item.descr = 'Синхронизация просмотра между устройствами (тестовая версия)';
          changed = true;
        }
      }
      if (changed && typeof Lampa.Plugins.save === 'function') Lampa.Plugins.save();
    } catch (e) {
      // Plugin metadata is optional; sync functionality must remain available.
    }
  }
  function registerSettings() {
    if (!L.SettingsApi || !L.SettingsApi.addComponent) return;
    L.SettingsApi.addComponent({component:'lampa_sync_pro',name:'Lampa Sync Pro',
      icon:'<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 0 1 14-5"/><path d="M18 3v4h-4"/><path d="M20 12a8 8 0 0 1-14 5"/><path d="M6 21v-4h4"/></svg>'});
    function button(name,label,description,action) {
      L.SettingsApi.addParam({component:'lampa_sync_pro',
        param:{name:name,type:'button'},field:{name:label,description:description},onChange:action});
    }
    button('lsp_account_status','Аккаунт / состояние','Показать подключение и очередь',function(){
      var s=status();
      note(s.authenticated ? ('Подключён: ' + s.email + ', очередь: ' + s.queued +
        ', ревизия: ' + s.revision + ', Realtime: ' + s.realtime) : 'Аккаунт не подключён');
    });
    button('lsp_login','Войти','Email и пароль Supabase Auth',function(){login(false);});
    button('lsp_register','Зарегистрироваться','При включённой проверке email придёт письмо',function(){login(true);});
    button('lsp_sync_now','Синхронизировать сейчас','Загрузить изменения и отправить очередь',function(){sync(true);});
    button('lsp_import_legacy','Импортировать историю «Продолжить»',
      'Перенести только отсутствующие в облаке записи ARST без удаления исходных данных',
      importLegacyHistory);
    button('lsp_torrserver_check','Проверить таймкод TorrServer',
      'Считать /viewed последнего воспроизведённого торрента',function() {
        if (!lastTorrent || state.userId!==lastTorrent.owner)
          return note('Нет последней серии для проверки');
        captureTorrViewed(lastTorrent,'progress',true,function(err,value) {
          if (err) return note('TorrServer: '+str(err.message).slice(0,45));
          if (!value) return note('TorrServer вернул 0: позиция не записана');
          note('TorrServer: '+Math.floor(value/60)+':'+('0'+Math.floor(value%60)).slice(-2));
        });
      });
    L.SettingsApi.addParam({component:'lampa_sync_pro',
      param:{name:'lsp_capture',type:'trigger',default:true},
      field:{name:'Сохранять просмотр торрентов',
        description:'Только подтверждённое воспроизведение; HDRezka пока не затрагивается'},
      onChange:function(v){L.Storage.set('lsp_capture',v===true||v==='true');}});
    button('lsp_logout','Выйти и очистить кэш','Удаляет локальную очередь и сессию',
      logout);
  }
  function boot() {
    if (loaded || STOPPED) return;
    loadState(function(saved) {
      if (STOPPED) return;
      sanitizeSaved(saved);
      if (!state.deviceId) state.deviceId=uuid();
      loaded=true;
      restoreLastTorrent();
      save();
      registerIdentity();
      if (!state.deviceId) {
        note('Случайный идентификатор недоступен в этом WebView');
        return;
      }
      registerSettings();
      installCapture();
      win.__AlexgoodPluginRuntime = win.__AlexgoodPluginRuntime || {};
      win.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js'] = {
        ready: true, version: VERSION, channel: CHANNEL, started_at: Date.now()
      };
      subscribe(L.Listener,'full',visibleCard);
      if (state.auth) { sync(false); realtimeStart(); }
      if (win.addEventListener) {
        win.addEventListener('online',onOnline);
        win.addEventListener('offline',onOffline);
        win.addEventListener('focus',onForeground);
        win.addEventListener('pageshow',onForeground);
      }
      if (win.document && typeof win.document.addEventListener==='function')
        win.document.addEventListener('visibilitychange',onVisibility);
    });
  }
  function onOnline(){retryAfter=0;realtimeStart();sync(false);}
  function onOffline(){realtimeStop();rtState='offline';}
  function onVisibility(){
    if (win.document && win.document.visibilityState==='hidden') {
      realtimeStop();
      rtState='paused';
    } else onForeground();
  }
  function onForeground(){
    if (STOPPED || !loaded || !state.auth) return;
    if (win.document && win.document.visibilityState==='hidden') return;
    realtimeStart();
    if (Date.now()-lastSuccessfulSync<20000) return;
    sync(false);
  }
  function destroy() {
    STOPPED=true;
    realtimeStop();
    stopOnlineResume();
    cancelTorrentResume();
    cancelTorrentFocus();
    clearTorrPoll();
    if (sendTimer) clearTimeout(sendTimer);
    subscriptions.forEach(function(s) {
      if (s.listener && typeof s.listener.remove==='function')
        s.listener.remove(s.kind,s.handler);
    });
    subscriptions=[];
    stateListeners=[];
    if (win.removeEventListener) {
      win.removeEventListener('online',onOnline);
      win.removeEventListener('offline',onOffline);
      win.removeEventListener('focus',onForeground);
      win.removeEventListener('pageshow',onForeground);
    }
    if (win.document && typeof win.document.removeEventListener==='function')
      win.document.removeEventListener('visibilitychange',onVisibility);
    if (db) {try{db.close();}catch(ignore){}}
    if (win.__AlexgoodPluginRuntime &&
        win.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js']) {
      win.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js'].ready=false;
    }
    win.plugin_lampa_sync_pro_ready=false;
    win.plugin_lampa_sync_pro_destroy=null;
  }
  win.plugin_lampa_sync_pro_destroy=destroy;
  win.LampaSyncPro={status:status,sync:function(){sync(true);},destroy:destroy,
    getResume:function(card){return findCachedResume(typeof card==='string'?card:mediaKey(card));},
    getEpisodeState:getEpisodeState,markEpisode:markEpisode,onChange:onStateChange,
    importLegacy:importLegacyHistory};
  if (win.appready) boot();
  else subscribe(L.Listener,'app',function(e){if(e && e.type==='ready')boot();});
})(typeof window==='undefined' ? null : window);
