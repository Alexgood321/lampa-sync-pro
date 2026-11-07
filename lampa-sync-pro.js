/* Lampa Sync Pro 0.1.4-alpha | https://github.com/Alexgood321/lampa-sync-pro
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
  var VERSION = '0.1.4';
  var CHANNEL = 'alpha';
  var BASE = 'https://kkrmivgrnfqauvplccqm.supabase.co';
  var KEY = 'sb_publishable_mpmJzdr8DZM4kukXPAdKmw_6YDWl2VH';
  var STORE_KEY = 'lampa_sync_pro_local_v1';
  var STOPPED = false;
  var loaded = false, db = null, storageMode = 'indexeddb';
  var subscriptions = [], interval = null, sendTimer = null;
  var networkBusy = false, refreshing = false, refreshWaiters = [];
  var lastSuccessfulSync = 0;
  var retryAfter = 0, active = null, staged = null, currentFull = null;
  var lastTorrent = null, torrPoll = null, torrStatus = 'not_checked';
  var resumeOverrides = {};
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
    if (staged && staged.card && Date.now() - staged.at < 100000) return staged.card;
    return null;
  }
  function makeContext(data) {
    var d = data || {};
    var fallback = staged && Date.now() - staged.at < 100000 ? staged.file : null;
    var card = getCard(d) || (fallback && fallback.card);
    var src = sourceFrom(d, fallback);
    var media = mediaKey(card);
    if (!src || !media) return null;
    var episode = /^tmdb:movie:/.test(media) || (!!card && card.release_date && !card.first_air_date &&
      !card.number_of_seasons) ? 'movie' : (parseEpisode(d) || parseEpisode(fallback));
    if (!episode) return null;
    return { card: card, media_key: media, episode_key: episode, recipe: src,
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
      playback_session_id: ctx.session_id, source_kind: 'torrent',
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
    if (d.url && staged && staged.file && staged.file.url &&
        d.url !== staged.file.url &&
        str(d.url).toUpperCase().indexOf(active.recipe.infohash) < 0 &&
        Date.now()-staged.at<100000) {
      active = null;
      return;
    }
    active.confirmed = true;
    active.external = external;
    active.owner = state.userId;
    lastTorrent=active;
    rememberLastTorrent(active);
    if (d.timeline && number(d.timeline.time) >= 0) active.position = Math.round(number(d.timeline.time));
    if (d.timeline && number(d.timeline.duration) > 0) active.duration = Math.round(number(d.timeline.duration));
    newEvent(active,'started');
    startTorrPoll(active);
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
        if (ctx.external && !ctx.position) {
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
    }
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
  function updateFull(e) {
    if (!state.auth || !e || e.type!=='complite') return;
    var card = e.data && e.data.movie;
    var key=mediaKey(card);
    var root=fullRoot(e);
    if (!key || !root || typeof win.$!=='function') return;
    root.find('.view--lsp-resume').remove();
    var rec=findCachedResume(key);
    if (!rec || rec.source_kind!=='torrent') return;
    var button=win.$('<div class="full-start__button selector view--lsp-resume"></div>');
    button.text(labelResume(rec));
    button.on('hover:enter',function() { resumeTorrent(card,rec); });
    var where=root.find('.view--torrent').last();
    if (!where.length) where=root.find('.view--online').last();
    if (where.length) where.after(button);
    else {
      where=root.find('.full-start__buttons').last();
      if (where.length) where.append(button);
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
  function normalPath(v) { return str(v).replace(/\\/g,'/').replace(/^\/+/,'').toLowerCase(); }
  function torFiles(hash,cb) {
    if (!L.Torserver || typeof L.Torserver.files!=='function') return cb(new Error('torrserver_unavailable'));
    var fired=false, timer=setTimeout(function(){ if(!fired){fired=true;cb(new Error('timeout'));}},8500);
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
  function resumeTorrent(card,rec) {
    if (!rec || rec.source_kind!=='torrent') return note('Источник пока не поддерживается');
    var recipe=rec.source_recipe || {}, hash=str(recipe.infohash).toUpperCase();
    if (!/^([0-9A-F]{40}|[A-Z2-7]{32})$/.test(hash) ||
      !L.Torserver || !L.Torserver.stream || !L.Torserver.parse ||
      !L.Timeline || !L.Timeline.view || !L.Player || !L.Player.play || !L.Player.playlist) {
      return note('Плеер или TorrServer не поддерживает восстановление');
    }
    torFiles(hash,function(err,response) {
      if (!err) return launch(response);
      torHash(hash,recipe,function(addError) {
        if (addError) return note('Торрент недоступен. Выберите его вручную');
        torFiles(hash,function(retryError,r) {
          if (retryError) return note('Не удалось загрузить файлы торрента');
          launch(r);
        });
      });
    });
    function launch(response) {
      var files=(response.file_stats || response.files || []).slice();
      var formats=/\.(mkv|mp4|avi|mov|m4v|ts|m2ts|wmv|mpg|mpeg|vob)$/i;
      files=files.filter(function(f){return formats.test(str(f.path));});
      if (!files.length) return note('В раздаче нет видеофайлов');
      files.sort(function(a,b){return normalPath(a.path).localeCompare(normalPath(b.path));});
      var playlist=[],target=null;
      files.forEach(function(file) {
        try {
          var parsed=L.Torserver.parse({movie:card,files:files,filename:file.path_human||file.path,path:file.path});
          if (!parsed || !parsed.hash) return;
          var road=L.Timeline.view(parsed.hash, {card:card,season:parsed.season,episode:parsed.episode}) || {};
          if (typeof road.handler!=='function') return;
          var item={card:card,id:file.id,path:file.path,torrent_hash:hash,
            season:parsed.season,episode:parsed.episode,
            url:L.Torserver.stream(file.path,hash,file.id),timeline:{
              hash:parsed.hash,handler:road.handler,time:number(road.time),
              duration:number(road.duration),percent:number(road.percent)
            }};
          playlist.push(item);
          if (Number(file.id)===Number(recipe.file_index) &&
             normalPath(file.path)===normalPath(recipe.file_path)) target=item;
        } catch (ignore) {}
      });
      if (!target) {
        for(var i=0;i<playlist.length;i++) {
          if (normalPath(playlist[i].path)===normalPath(recipe.file_path)) { target=playlist[i];break; }
        }
      }
      if (!target) return note('Сохранённый файл не найден. Выберите серию вручную');
      var sec=number(rec.position_seconds),dur=number(rec.duration_seconds);
      if (rec.watched_state==='completed' || (dur>0 && sec>=dur*0.9)) {
        var next=null;
        for(var j=0;j<playlist.length;j++) {
          if (number(playlist[j].season)>number(target.season) ||
             (number(playlist[j].season)===number(target.season) && number(playlist[j].episode)>number(target.episode))) {
            next=playlist[j];break;
          }
        }
        if (next) {target=next;sec=0;dur=0;}
      }
      target.timeline.time=Math.max(0,Math.round(sec));
      target.timeline.duration=Math.max(0,Math.round(dur)) || target.timeline.duration;
      target.timeline.percent=target.timeline.duration ?
        Math.min(100,100*target.timeline.time/target.timeline.duration) : 0;
      staged={file:target,card:card,at:Date.now()};
      try {
        var options={};
        Object.keys(target).forEach(function(k){options[k]=target[k];});
        options.playlist=playlist;
        options.return_result=true;
        L.Player.play(options);
        L.Player.playlist(playlist);
      } catch(e) { note('Не удалось открыть плеер'); }
    }
  }
  function status() {
    return {version:VERSION,ready:loaded,authenticated:!!state.auth,
      email:state.auth && state.auth.email || '',revision:state.revision,
      queued:state.outbox.length,device:state.deviceId,storage:storageMode,
      capture:option('capture',true),busy:networkBusy,torrserver:torrStatus,
      lastSyncAt:lastSuccessfulSync};
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
        ', ревизия: ' + s.revision) : 'Аккаунт не подключён');
    });
    button('lsp_login','Войти','Email и пароль Supabase Auth',function(){login(false);});
    button('lsp_register','Зарегистрироваться','При включённой проверке email придёт письмо',function(){login(true);});
    button('lsp_sync_now','Синхронизировать сейчас','Загрузить изменения и отправить очередь',function(){sync(true);});
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
      if (state.auth) sync(false);
      interval=setInterval(function(){
        if (win.document && win.document.visibilityState==='hidden') return;
        sync(false);
      },30000);
      if (win.addEventListener) {
        win.addEventListener('online',onOnline);
        win.addEventListener('focus',onForeground);
        win.addEventListener('pageshow',onForeground);
      }
      if (win.document && typeof win.document.addEventListener==='function')
        win.document.addEventListener('visibilitychange',onForeground);
    });
  }
  function onOnline(){retryAfter=0;sync(false);}
  function onForeground(){
    if (STOPPED || !loaded || !state.auth) return;
    if (win.document && win.document.visibilityState==='hidden') return;
    if (Date.now()-lastSuccessfulSync<20000) return;
    sync(false);
  }
  function destroy() {
    STOPPED=true;
    clearTorrPoll();
    if (interval) clearInterval(interval);
    if (sendTimer) clearTimeout(sendTimer);
    subscriptions.forEach(function(s) {
      if (s.listener && typeof s.listener.remove==='function')
        s.listener.remove(s.kind,s.handler);
    });
    subscriptions=[];
    if (win.removeEventListener) {
      win.removeEventListener('online',onOnline);
      win.removeEventListener('focus',onForeground);
      win.removeEventListener('pageshow',onForeground);
    }
    if (win.document && typeof win.document.removeEventListener==='function')
      win.document.removeEventListener('visibilitychange',onForeground);
    if (db) {try{db.close();}catch(ignore){}}
    if (win.__AlexgoodPluginRuntime &&
        win.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js']) {
      win.__AlexgoodPluginRuntime['alexgood321/lampa-sync-pro/lampa-sync-pro.js'].ready=false;
    }
    win.plugin_lampa_sync_pro_ready=false;
    win.plugin_lampa_sync_pro_destroy=null;
  }
  win.plugin_lampa_sync_pro_destroy=destroy;
  win.LampaSyncPro={status:status,sync:function(){sync(true);},destroy:destroy};
  if (win.appready) boot();
  else subscribe(L.Listener,'app',function(e){if(e && e.type==='ready')boot();});
})(typeof window==='undefined' ? null : window);
