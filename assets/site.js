// DNO site kit script: the LIVE freshness line in the header, the table of contents, heading links, copy buttons
// and row filters. Every public page except the homepage loads it (the homepage has its own reader).
// LIVE is DNO's freshness (how old the last completed public observation is). It is not a status and not a go/no-go.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---- LIVE: /organism staleness_seconds, re-read every 30 s ----
  var live = $('#live'), liveText = $('#live-text');
  function setLive(state, text) {
    if (!live || !liveText) return;
    if (live.getAttribute('data-state') !== state) live.setAttribute('data-state', state);
    if (liveText.textContent !== text) liveText.textContent = text;
  }
  function readLive() {
    if (!live) return;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
    fetch('/organism', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (o) {
        var s = o && typeof o.staleness_seconds === 'number' && isFinite(o.staleness_seconds) ? Math.max(0, Math.round(o.staleness_seconds)) : null;
        if (s === null) setLive('pending', 'no observation yet');
        else if (s <= 300) setLive('live', 'LIVE · ' + s + ' s');
        else setLive('stale', 'STALE · ' + Math.round(s / 60) + ' min');
      })
      .catch(function () { setLive('down', 'OFFLINE'); })
      .then(function () { if (timer) clearTimeout(timer); });
  }
  readLive();
  setInterval(function () { if (!document.hidden) readLive(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) readLive(); });

  // ---- Menu: close on Escape or a click outside ----
  var menu = $('.menu');
  if (menu) {
    document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.open) { menu.open = false; var s = $('summary', menu); if (s) s.focus(); } });
  }

  // ---- Heading links ----
  $$('.prose h2[id], .prose h3[id]').forEach(function (h) {
    if ($('.h-anchor', h)) return;
    var a = document.createElement('a');
    a.className = 'h-anchor'; a.href = '#' + h.id; a.textContent = '#';
    a.setAttribute('aria-label', 'Link to “' + h.textContent.trim() + '”');
    h.appendChild(a);
  });

  // ---- Table of contents: the section in view is marked; on narrow screens the list folds ----
  var toc = $('.toc');
  if (toc) {
    var narrow = window.matchMedia('(max-width: 999px)');
    var syncOpen = function () { if (narrow.matches) toc.removeAttribute('open'); else toc.setAttribute('open', ''); };
    syncOpen();
    if (narrow.addEventListener) narrow.addEventListener('change', syncOpen);
    $('summary', toc).addEventListener('click', function (e) { if (!narrow.matches) e.preventDefault(); });
    $$('a', toc).forEach(function (a) { a.addEventListener('click', function () { if (narrow.matches) toc.removeAttribute('open'); }); });
    var links = {};
    $$('a[href^="#"]', toc).forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var targets = Object.keys(links).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (targets.length && 'IntersectionObserver' in window) {
      var visible = {};
      var mark = function () {
        var cur = null;
        for (var i = 0; i < targets.length; i++) if (visible[targets[i].id]) { cur = targets[i].id; break; }
        if (!cur) return;
        Object.keys(links).forEach(function (id) {
          if (id === cur) links[id].setAttribute('aria-current', 'true'); else links[id].removeAttribute('aria-current');
        });
      };
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
        mark();
      }, { rootMargin: '-15% 0px -70% 0px' });
      targets.forEach(function (t) { io.observe(t); });
    }
  }

  // ---- Copy buttons on <pre data-copy> ----
  $$('pre[data-copy]').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn copy-btn'; btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      var text = pre.textContent;
      var done = function (ok) { btn.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
    var bar = document.createElement('div');
    bar.className = 'copy-bar';
    bar.appendChild(btn);
    pre.parentNode.insertBefore(bar, pre);
  });

  // ---- Row filters: <div class="chips" data-filter-for="ID"> with buttons data-filter="all|tag"; rows carry data-f ----
  $$('.chips[data-filter-for]').forEach(function (group) {
    var target = document.getElementById(group.getAttribute('data-filter-for'));
    if (!target) return;
    var btns = $$('button[data-filter]', group);
    var count = $('[data-filter-count]', group);
    var apply = function (f) {
      var shown = 0;
      $$('[data-f]', target).forEach(function (row) {
        var on = f === 'all' || (' ' + row.getAttribute('data-f') + ' ').indexOf(' ' + f + ' ') !== -1;
        row.hidden = !on; if (on) shown++;
      });
      btns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-filter') === f ? 'true' : 'false'); });
      if (count) count.textContent = shown + ' shown';
    };
    btns.forEach(function (b) { b.addEventListener('click', function () { apply(b.getAttribute('data-filter')); }); });
    apply('all');
  });
})();
