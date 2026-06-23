/* 0.2.0 (Phase 4) — legacy client UI. Flat ES5, native <video src=m3u8>,
 * server-protocol via HMProtocol (protocol.js). Hash routes:
 *   #/           browse grid (movies + series)
 *   #/series/ID  episode list
 *   #/play/REL   native-HLS player for a relPath
 *
 * Constraints (D6 + feature matrix): seek is ALWAYS server-respawn — we never
 * set video.currentTime for an out-of-window target; we POST /seek and reload
 * the returned playlist into <video>.src. Subtitles are burn-in only (server
 * side); we keep the audio-track picker. No precise scrub, no PiP, no speed.
 */
(function () {
  'use strict';

  var P = window.HMProtocol;
  var ENV = P.defaultEnv();
  var app = document.getElementById('app');
  var backBtn = document.getElementById('backBtn');

  // Player runtime state (only one player at a time).
  var player = null;

  // Home-screen state: the fetched library + the active Movies/Series tab.
  // Module-level so flipping tabs is instant (no refetch) and the choice
  // persists when you dive into an item and come back.
  var cachedLibrary = null;
  var activeTab = 'movies';
  // True when the last tab change came from the tab bar (click/number key), so
  // the home re-render keeps focus on tabs instead of jumping to the grid.
  var navWasOnTab = false;
  // The series id the current player was launched from (null for a movie), so
  // Back from the player returns to that series' episode list.
  var lastSeriesId = null;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          if (k === 'class') e.className = attrs[k];
          else e.setAttribute(k, attrs[k]);
        }
      }
    }
    if (text != null) e.appendChild(document.createTextNode(text));
    return e;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function getJson(url) {
    return ENV.fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      return r.json();
    });
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(sec);
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  function parseHash() {
    var h = (location.hash || '').replace(/^#/, '') || '/';
    if (h === '/' || h === '') return { name: 'home' };
    var sm = h.match(/^\/series\/(\d+)$/);
    if (sm) return { name: 'series', id: Number(sm[1]) };
    var pm = h.match(/^\/play\/(.+)$/);
    if (pm) {
      var rel = pm[1];
      try { rel = decodeURIComponent(rel); } catch (e) { /* leave */ }
      return { name: 'play', relPath: rel };
    }
    return { name: 'home' };
  }

  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  // Context-aware Back: step up one level deterministically rather than relying
  // on history.length (which can strand a deep-linked user). Player → the list
  // it was launched from (series if we know it, else home), series → home,
  // home → no-op (already at the top).
  function goBack() {
    var route = parseHash();
    if (route.name === 'play') {
      // Return to the series the episode belongs to when known, else home.
      // We stash the launching series id on navigation into the player.
      if (lastSeriesId != null) navigate('#/series/' + lastSeriesId);
      else navigate('#/');
      return;
    }
    if (route.name === 'series') { navigate('#/'); return; }
    // Home: nothing above this.
  }

  backBtn.onclick = goBack;

  // ── Views ──────────────────────────────────────────────────────────────────

  function showBack(show) {
    backBtn.style.display = show ? 'inline' : 'none';
  }

  function renderHome() {
    showBack(false);
    clear(app);
    app.appendChild(el('div', { class: 'msg' }, 'Loading library…'));
    getJson('/api/library').then(
      function (lib) {
        cachedLibrary = { movies: lib.movies || [], series: lib.series || [] };
        renderHomeFromCache();
      },
      function (err) {
        clear(app);
        app.appendChild(el('div', { class: 'err' }, 'Could not load library: ' + err.message));
      }
    );
  }

  // Render the Movies/Series tab bar + the active grid from the cached library,
  // so flipping tabs doesn't re-fetch. `activeTab` is module-level so it sticks
  // when you go into a movie/series and come back.
  function renderHomeFromCache() {
    if (!cachedLibrary) return;
    clear(app);

    var movies = cachedLibrary.movies;
    var series = cachedLibrary.series;

    // Tab bar. Each tab is a plain focusable button so a remote/D-pad can
    // reach it. Hide a tab entirely if that section is empty.
    var tabs = el('div', { class: 'tabs' });
    if (movies.length) tabs.appendChild(makeTab('Movies', 'movies'));
    if (series.length) tabs.appendChild(makeTab('Series', 'series'));
    app.appendChild(tabs);

    // Fall back to whichever tab actually has content.
    if (activeTab === 'movies' && !movies.length) activeTab = 'series';
    if (activeTab === 'series' && !series.length) activeTab = 'movies';

    var items = activeTab === 'series' ? series : movies;
    var isSeries = activeTab === 'series';
    if (!items.length) {
      app.appendChild(el('div', { class: 'msg' }, 'Nothing here yet.'));
      return;
    }
    var grid = el('div', { class: 'grid' });
    for (var i = 0; i < items.length; i++) {
      grid.appendChild(makeTile(items[i], isSeries));
    }
    app.appendChild(grid);
    // Content just landed (or tab flipped). The old tab button was destroyed by
    // the rebuild, so navRefresh would jump focus to the first tile. Instead,
    // if the user was navigating tabs, keep focus on the now-active tab so a
    // second arrow press continues from there; otherwise seed the first item.
    var activeTabEl = document.querySelector('[data-tab="' + activeTab + '"]');
    if (navWasOnTab && activeTabEl) {
      navCurrent = null;
      navSetFocus(activeTabEl);
    } else {
      navRefresh();
    }
    navWasOnTab = false;
  }

  function makeTab(label, key) {
    // The leading "1 "/"2 " hints the number-key shortcut; data-nav makes it
    // remote-focusable, data-tab lets the digit shortcut find it.
    var n = key === 'movies' ? '1' : key === 'series' ? '2' : '';
    var btn = el(
      'button',
      { 'class': 'tab' + (activeTab === key ? ' active' : ''), 'data-nav': '1', 'data-tab': key },
      (n ? n + ' ' : '') + label
    );
    btn.onclick = function () {
      navWasOnTab = true;
      activeTab = key;
      renderHomeFromCache();
    };
    return btn;
  }

  function makeTile(item, isSeries) {
    var tile = el('div', { 'class': 'tile', 'data-nav': '1' });
    var img;
    if (item.posterUrl) {
      img = el('img', { class: 'poster', src: item.posterUrl, alt: item.title || '' });
    } else {
      img = el('div', { class: 'poster' });
    }
    tile.appendChild(img);
    tile.appendChild(el('div', { class: 'label' }, item.title || '(untitled)'));
    tile.onclick = function () {
      if (isSeries) {
        navigate('#/series/' + item.id);
      } else {
        // A movie launched straight from the grid — Back should return home,
        // not to some previously-viewed series.
        lastSeriesId = null;
        navigate('#/play/' + encodeURIComponent(item.path));
      }
    };
    return tile;
  }

  function renderSeries(id) {
    // Remember this series so Back from the player returns to its episode list.
    lastSeriesId = id;
    showBack(true);
    clear(app);
    app.appendChild(el('div', { class: 'msg' }, 'Loading…'));
    getJson('/api/series/' + id).then(
      function (detail) {
        clear(app);
        var s = detail.series || {};
        app.appendChild(el('div', { class: 'section-title' }, s.title || 'Series'));
        var eps = detail.episodes || [];
        // Pick the "hero" episode the user most likely wants next: the first
        // in-progress one (partly watched), else the first unwatched one, else
        // the first episode. We mark it visually and park D-pad focus on it so
        // the user lands on "what to play next" without re-navigating.
        var heroIdx = pickHeroEpisode(eps);
        var heroRow = null;
        for (var i = 0; i < eps.length; i++) {
          var row = makeEpisodeRow(eps[i], i === heroIdx);
          if (i === heroIdx) heroRow = row;
          app.appendChild(row);
        }
        if (!eps.length) app.appendChild(el('div', { class: 'msg' }, 'No episodes.'));
        // Seed focus on the hero row (falls back to first focusable).
        if (heroRow) { navCurrent = null; navSetFocus(heroRow); }
        else navRefresh();
      },
      function (err) {
        clear(app);
        app.appendChild(el('div', { class: 'err' }, 'Could not load series: ' + err.message));
      }
    );
  }

  // Which episode to spotlight: first in-progress (0 < position < ~95%), else
  // first unwatched, else the first episode. Returns its index in `eps`.
  function pickHeroEpisode(eps) {
    if (!eps || !eps.length) return -1;
    for (var i = 0; i < eps.length; i++) {
      var e = eps[i];
      if (e.position > 0 && e.duration > 0 && e.position < e.duration * 0.95 && !e.watched) {
        return i; // resume an in-progress episode
      }
    }
    for (var j = 0; j < eps.length; j++) {
      if (!eps[j].watched) return j; // start the next unwatched one
    }
    return 0;
  }

  function makeEpisodeRow(ep, isHero) {
    var cls = 'row' + (isHero ? ' hero' : '');
    var row = el('div', { 'class': cls, 'data-nav': '1' });

    // Thumbnail (TMDB still). Fixed box with a placeholder when absent so rows
    // stay aligned. Native <img>, no MSE/fancy CSS — fine on old TVs.
    var thumb;
    if (ep.stillUrl) {
      thumb = el('img', { 'class': 'thumb', src: ep.stillUrl, alt: '' });
    } else {
      thumb = el('div', { 'class': 'thumb' });
    }
    row.appendChild(thumb);

    // Text column: "S1E2  Title" + optional resume %.
    var meta = el('div', { 'class': 'ep-meta' });
    var line = el('div', { 'class': 'ep-line' });
    line.appendChild(el('span', { class: 'ep-num' }, 'S' + ep.season + 'E' + ep.episode));
    line.appendChild(document.createTextNode(ep.title || ''));
    meta.appendChild(line);
    if (isHero) {
      var resuming = ep.position > 0 && ep.duration > 0 && !ep.watched;
      meta.appendChild(el('div', { 'class': 'hero-badge' }, resuming ? '▶ Resume' : '▶ Play next'));
    }
    if (ep.position > 0 && ep.duration > 0 && !ep.watched) {
      var pct = Math.round((ep.position / ep.duration) * 100);
      meta.appendChild(el('div', { class: 'resume' }, pct + '% watched'));
    } else if (ep.watched) {
      meta.appendChild(el('div', { class: 'resume' }, '✓ Watched'));
    }
    row.appendChild(meta);

    row.onclick = function () {
      navigate('#/play/' + encodeURIComponent(ep.path));
    };
    return row;
  }

  // ── Player ──────────────────────────────────────────────────────────────────

  function teardownPlayer() {
    if (!player) return;
    if (player.heartbeat) { clearInterval(player.heartbeat); player.heartbeat = null; }
    try { P.close(ENV, player.playerId, false); } catch (e) { /* best effort */ }
    player = null;
  }

  function renderPlayer(relPath) {
    showBack(true);
    teardownPlayer();
    clear(app);
    app.appendChild(el('div', { class: 'msg' }, 'Starting playback…'));

    var playerId = P.mintPlayerId(ENV);
    player = {
      playerId: playerId,
      relPath: relPath,
      encodedFrom: 0,
      duration: 0,
      bundle: null,
      heartbeat: null,
      paused: true,
      audioStreams: []
    };

    P.open(ENV, playerId, { relPath: relPath }).then(
      function (bundle) {
        player.bundle = bundle;
        player.encodedFrom = bundle.session.encodedWindow.from;
        player.duration = bundle.metadata.durationSeconds || bundle.resume.duration || 0;
        player.audioStreams = bundle.metadata.audioStreams || [];
        buildPlayerUi(bundle);
      },
      function (err) {
        clear(app);
        if (err && err.capacity) {
          app.appendChild(el('div', { class: 'err' }, 'Encoder busy — close another player and try again.'));
        } else {
          app.appendChild(el('div', { class: 'err' }, 'Could not start playback: ' + err.message));
        }
      }
    );
  }

  function buildPlayerUi(bundle) {
    clear(app);
    var wrap = el('div', { class: 'player-wrap' });
    var video = el('video', { controls: 'controls', autoplay: 'autoplay', playsinline: 'playsinline' });
    wrap.appendChild(video);
    app.appendChild(wrap);

    var controls = el('div', { class: 'controls' });

    // Seek-by-respawn scrubber (D6). The range is over ABSOLUTE source seconds;
    // releasing it issues POST /seek and reloads the respawned playlist.
    var scrubRow = el('div', { class: 'scrubrow' });
    var scrub = el('input', { type: 'range', min: '0', max: String(Math.floor(player.duration) || 0), value: '0', step: '1' });
    var timeLabel = el('span', { class: 'time' }, '0:00 / ' + fmtTime(player.duration));
    var seekingLabel = el('span', { class: 'seeking' }, '');
    scrubRow.appendChild(scrub);
    scrubRow.appendChild(timeLabel);
    scrubRow.appendChild(seekingLabel);
    controls.appendChild(scrubRow);

    // Audio-track picker (kept per the feature matrix). Burn-in subs are
    // server-side, so there is no soft <track> UI.
    if (player.audioStreams.length > 1) {
      var picker = el('div', { class: 'picker' });
      picker.appendChild(document.createTextNode('Audio: '));
      var sel = el('select');
      for (var i = 0; i < player.audioStreams.length; i++) {
        var a = player.audioStreams[i];
        var name = (a.language || 'track') + (a.title ? ' — ' + a.title : '') + ' (' + a.codec + ')';
        var opt = el('option', { value: String(a.index) }, name);
        if (bundle.metadata.activeAudioStreamIndex === a.index) opt.setAttribute('selected', 'selected');
        sel.appendChild(opt);
      }
      sel.onchange = function () {
        var idx = Number(sel.value);
        seekingLabel.firstChild ? (seekingLabel.firstChild.nodeValue = 'Switching…') : seekingLabel.appendChild(document.createTextNode('Switching…'));
        P.tracks(ENV, player.playerId, { audioStreamIndex: idx, startSeconds: absoluteTime(video) }).then(
          function (nb) {
            player.bundle = nb;
            player.encodedFrom = nb.session.encodedWindow.from;
            attachPlaylist(video, nb.session.playlistUrl);
            seekingLabel.firstChild.nodeValue = '';
          },
          function () { seekingLabel.firstChild.nodeValue = ''; }
        );
      };
      picker.appendChild(sel);
      controls.appendChild(picker);
    }

    app.appendChild(controls);

    // Resume position from the open bundle (server already spawned ffmpeg at
    // the offset, so currentTime is local-from-window; here it's 0).
    var resumeAt = bundle.resume && bundle.resume.position ? bundle.resume.position : 0;
    // The server starts the encode at startSeconds; encodedWindow.from reflects
    // it, so local time 0 == resume point. We honour resume by trusting the
    // server's spawn offset; if the bundle didn't resume server-side, seek.
    attachPlaylist(video, bundle.session.playlistUrl);

    // Keep the absolute-time display + scrubber in sync off the <video> clock.
    video.addEventListener('timeupdate', function () {
      if (player.scrubbing) return;
      var abs = absoluteTime(video);
      scrub.value = String(Math.floor(abs));
      timeLabel.firstChild.nodeValue = fmtTime(abs) + ' / ' + fmtTime(player.duration);
    });
    video.addEventListener('play', function () { player.paused = false; restartHeartbeat(); });
    video.addEventListener('pause', function () { player.paused = true; restartHeartbeat(); });

    // Scrub = respawn (D6). We never set currentTime for out-of-window targets.
    scrub.addEventListener('mousedown', function () { player.scrubbing = true; });
    scrub.addEventListener('touchstart', function () { player.scrubbing = true; });
    function commitSeek() {
      var target = Number(scrub.value);
      player.scrubbing = false;
      seekingLabel.firstChild ? (seekingLabel.firstChild.nodeValue = 'Seeking…') : seekingLabel.appendChild(document.createTextNode('Seeking…'));
      P.seek(ENV, player.playerId, target).then(
        function (r) {
          player.encodedFrom = r.encodedWindow.from;
          if (r.action && r.action.kind === 'set-current-time') {
            // In-window reuse — cheap; honour it rather than a needless respawn.
            video.currentTime = r.action.localSeconds;
          } else {
            attachPlaylist(video, r.playlistUrl);
            video.currentTime = 0; // new playlist starts at encodedWindow.from
          }
          if (seekingLabel.firstChild) seekingLabel.firstChild.nodeValue = '';
        },
        function () { if (seekingLabel.firstChild) seekingLabel.firstChild.nodeValue = ''; }
      );
    }
    scrub.addEventListener('change', commitSeek);

    if (resumeAt > 0) {
      // If the server bundle didn't already spawn at the resume offset, jump
      // there via a respawn seek. Safe either way — a respawn to the resume
      // point is idempotent.
      scrub.value = String(Math.floor(resumeAt));
    }

    restartHeartbeat();
  }

  function absoluteTime(video) {
    return player.encodedFrom + (video.currentTime || 0);
  }

  // Native HLS: set <video>.src to the m3u8 (no MSE, no hls.js).
  function attachPlaylist(video, playlistUrl) {
    video.src = playlistUrl;
    var p = video.play();
    if (p && p['catch']) p['catch'](function () { /* autoplay may be blocked */ });
  }

  // /state heartbeat — 5s playing, 30s paused — keeps the server session alive.
  function restartHeartbeat() {
    if (player.heartbeat) { clearInterval(player.heartbeat); player.heartbeat = null; }
    var interval = player.paused ? 30000 : 5000;
    player.heartbeat = setInterval(function () {
      var video = app.querySelector('video');
      if (!video) return;
      var localSeconds = Math.max(0, video.currentTime || 0);
      P.state(ENV, player.playerId, localSeconds, player.paused).then(
        function (r) {
          if (r && r.status === 'gone') {
            // Server forgot us — try one revive via seek to current absolute.
            P.seek(ENV, player.playerId, absoluteTime(video)).then(
              function (sr) {
                player.encodedFrom = sr.encodedWindow.from;
                attachPlaylist(video, sr.playlistUrl);
              },
              function () { /* give up; user can reselect */ }
            );
          }
        },
        function () { /* transient — next tick retries */ }
      );
    }, interval);
  }

  // ── Focus navigation (D-pad / remote) ──────────────────────────────────────
  //
  // Real TV/console remotes drive the legacy client, so we run a small focus
  // model: arrow keys move a highlight between focusable elements (tabs, tiles,
  // episode rows, the Back button), Enter activates. Old-TV keycodes are flaky,
  // so we match BOTH `event.key` and the numeric `event.keyCode` — never assume
  // one is present. There is no portable Back key, so Back stays an on-screen
  // button (we don't bind Escape).
  //
  // Focusable elements opt in with a `data-nav` attribute; nav.refresh()
  // re-collects them after each view render and parks focus on the first one.

  var navCurrent = null;

  // Collect visible [data-nav] elements in DOM order.
  function navCollect() {
    var list = [];
    var nodes = document.querySelectorAll('[data-nav]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) list.push(n);
    }
    return list;
  }

  function navCenter(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function navSetFocus(node) {
    if (navCurrent === node) return;
    if (navCurrent) navCurrent.className = navCurrent.className.replace(/\s*nav-focus/g, '');
    navCurrent = node;
    if (node) {
      node.className += ' nav-focus';
      if (node.scrollIntoView) node.scrollIntoView(false);
    }
  }

  // Re-seed after a render: keep focus on the same node if it survived, else
  // park on the first focusable.
  function navRefresh() {
    var list = navCollect();
    if (!list.length) { navCurrent = null; return; }
    var keep = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === navCurrent) { keep = true; break; }
    }
    if (!keep) { navCurrent = null; navSetFocus(list[0]); }
  }

  // Move to the geometrically nearest focusable in `dir` ('up'|'down'|'left'|
  // 'right'). Same nearest-neighbour scoring as the modern client: distance
  // along the pressed axis + a heavier off-axis penalty so it tracks rows/
  // columns instead of jumping diagonally.
  function navMove(dir) {
    var list = navCollect();
    if (!list.length) return;
    if (!navCurrent) { navSetFocus(list[0]); return; }
    var from = navCenter(navCurrent);
    var best = null, bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === navCurrent) continue;
      var to = navCenter(list[i]);
      var dx = to.x - from.x, dy = to.y - from.y;
      var ok =
        dir === 'right' ? (dx > 1 && Math.abs(dx) >= Math.abs(dy)) :
        dir === 'left'  ? (dx < -1 && Math.abs(dx) >= Math.abs(dy)) :
        dir === 'down'  ? (dy > 1 && Math.abs(dy) >= Math.abs(dx)) :
        dir === 'up'    ? (dy < -1 && Math.abs(dy) >= Math.abs(dx)) : false;
      if (!ok) continue;
      var primary = (dir === 'left' || dir === 'right') ? Math.abs(dx) : Math.abs(dy);
      var off     = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx);
      var score = primary + off * 2;
      if (score < bestScore) { bestScore = score; best = list[i]; }
    }
    if (best) navSetFocus(best);
  }

  function navActivate() {
    if (navCurrent && navCurrent.click) navCurrent.click();
  }

  // Jump focus to a tab by its data-tab key and activate it. Backs the number-
  // key shortcuts — digit keys are the single most reliable key on TV remotes.
  function navActivateTab(key) {
    var tab = document.querySelector('[data-tab="' + key + '"]');
    if (tab) { navSetFocus(tab); tab.click(); }
  }

  // The TV/console Back (Return) button. Its keycode is wildly inconsistent
  // across vendors, so we match the whole known set: Escape/Backspace + the
  // synthetic Browser/Go back keys + the numeric codes LG webOS (10009),
  // Tizen/older (461), backspace (8) and escape (27) emit. A stray match is
  // cheap (one extra "go back"); missing the user's Back key is the real cost.
  function isBackKey(e) {
    var k = e.key || '';
    var c = e.keyCode || e.which || 0;
    return (
      k === 'Escape' || k === 'Backspace' || k === 'GoBack' ||
      k === 'BrowserBack' || k === 'XF86Back' || k === 'Back' ||
      c === 27 || c === 8 || c === 10009 || c === 461 || c === 166
    );
  }

  // One keydown handler for the whole client. Matches event.key first, then
  // falls back to keyCode for old engines that don't set `key` (or set a
  // vendor string). Arrows: 37-40. Enter: 13. Digits: 49/50 (1/2) or '1'/'2'.
  function onNavKey(e) {
    var tag = e.target && e.target.tagName ? e.target.tagName : '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Back/Return — handled in EVERY view (including the player, where it's the
    // way out of playback back to the episode list / home). Skip while typing
    // so Backspace still edits a field. goBack() is context-aware: player →
    // list, series → home, home → top (no-op).
    if (!typing && isBackKey(e)) {
      e.preventDefault();
      goBack();
      return;
    }

    // In the player view the native <video controls> owns the directional keys
    // (arrows seek, space toggles) — don't steal them. The player has no
    // [data-nav] targets, so bail for everything except Back (handled above).
    if (player) return;
    if (typing) return;

    var k = e.key || '';
    var c = e.keyCode || e.which || 0;

    if (k === 'ArrowLeft' || c === 37) { navMove('left'); e.preventDefault(); return; }
    if (k === 'ArrowUp' || c === 38) { navMove('up'); e.preventDefault(); return; }
    if (k === 'ArrowRight' || c === 39) { navMove('right'); e.preventDefault(); return; }
    if (k === 'ArrowDown' || c === 40) { navMove('down'); e.preventDefault(); return; }
    if (k === 'Enter' || c === 13) { navActivate(); e.preventDefault(); return; }
    // Number shortcuts for tabs (home screen only; harmless elsewhere).
    if (k === '1' || c === 49) { navActivateTab('movies'); e.preventDefault(); return; }
    if (k === '2' || c === 50) { navActivateTab('series'); e.preventDefault(); return; }
  }

  document.addEventListener('keydown', onNavKey, false);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function render() {
    var route = parseHash();
    if (route.name !== 'play') teardownPlayer();
    if (route.name === 'home') renderHome();
    else if (route.name === 'series') renderSeries(route.id);
    else if (route.name === 'play') renderPlayer(route.relPath);
    // After the view renders, re-collect focusables and park the highlight.
    // (Library/series fetch async; those paths call navRefresh themselves once
    // their content lands — see renderHomeFromCache / renderSeries.)
    navRefresh();
  }

  // Close the player session when the page is hidden/unloaded (beacon alias).
  function onPageHide() {
    if (player) {
      if (player.heartbeat) { clearInterval(player.heartbeat); player.heartbeat = null; }
      P.close(ENV, player.playerId, true);
    }
  }
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);

  window.addEventListener('hashchange', render);
  render();
})();
