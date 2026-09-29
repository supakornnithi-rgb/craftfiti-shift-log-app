// app.js — Craftfiti Shift Log PWA. Vanilla ES2019, no build step, no frameworks.
(function () {
  'use strict';

  var cfg = window.SHIFTLOG_CONFIG || { API_URL: '', APP_USERS: ["Bank", "GINK", "P'Tin", "SINGHA"] };

  // ---------- storage helpers ----------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function lsGetJSON(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSetJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  // P8: today's date in Bangkok, computed locally (device timezone independent) so the app can
  // paint instantly from the persisted bundle; the server's `today` replaces it after bootstrap.
  function bkkToday() { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }

  var state = {
    token: lsGet('sl_token') || '',
    role: lsGet('sl_role') || '',
    who: lsGet('sl_who') || '',
    users: lsGetJSON('sl_users') || cfg.APP_USERS,
    // P8 local-first: `bundle` is the whole data set (people, rates, templates, tueSlots, events,
    // periods, tempPayments, config). Every view is computed from it with Logic.js; only writes and
    // login talk to the server, and every write returns a fresh bundle.
    bundle: null,
    bundleVer: 0,       // bumped whenever a write installs a new bundle (drops stale background refreshes)
    refreshedAt: 0,
    people: [],
    appUsers: cfg.APP_USERS,
    tueAllowed: [],
    today: bkkToday(),
    ym: ''
  };
  state.ym = state.today.slice(0, 7);

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = (s === undefined || s === null) ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- date / thai helpers ----------
  var THAI_MONTH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var THAI_MONTH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  var THAI_WEEKDAY_FULL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  var WD_LABEL_SHORT = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function daysInMonth(ym) { var p = ym.split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]), 0)).getUTCDate(); }
  function weekdayOf(date) { var p = date.split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay(); }
  function datesOfMonth(ym) {
    var n = daysInMonth(ym), p = ym.split('-'), out = [];
    for (var d = 1; d <= n; d++) out.push(ym + '-' + pad2(d));
    return out;
  }
  function ymLabel(ym) { var p = ym.split('-'); return THAI_MONTH_FULL[Number(p[1]) - 1] + ' ' + p[0]; }
  // P6: pay-period helpers (event month vs. next month, short Thai label).
  function nextYm(ym) { var p = ym.split('-'); var y = Number(p[0]), m = Number(p[1]) + 1; if (m > 12) { m = 1; y++; } return y + '-' + pad2(m); }
  function monthYearShort(ym) { var p = ym.split('-'); return THAI_MONTH_SHORT[Number(p[1]) - 1] + ' ' + p[0]; }
  function fmtDT(iso) {
    if (!iso) return '';
    var datePart = iso.slice(0, 10), timePart = iso.slice(11, 16);
    var d = datePart.slice(8, 10), m = datePart.slice(5, 7);
    return d + '/' + m + ' ' + timePart;
  }
  function money2(n) { return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function numFmt(v) { return (v % 1) ? v.toFixed(1) : String(v); }

  // ---------- people helpers ----------
  function personById(id) { return state.people.find(function (p) { return p.id === id; }) || null; }
  function nickOf(id) { var p = personById(id); return p ? p.nick : id; }
  function codeOf(entry) {
    if (!entry.id) return '?';
    var p = personById(entry.id);
    if (p && p.group === 'temp') return 'นอก';
    return p ? p.code : '?';
  }
  function activeDirectorsStaff() { return state.people.filter(function (p) { return p.active && (p.group === 'director' || p.group === 'staff'); }); }
  function activeRegularTemps() { return state.people.filter(function (p) { return p.group === 'temp' && p.active && p.regular; }); }
  function workingIdsOf(roster) { return roster.filter(function (r) { return r.id; }).map(function (r) { return r.id; }); }
  function availableSubs(roster) {
    var working = workingIdsOf(roster);
    return activeDirectorsStaff().filter(function (p) { return working.indexOf(p.id) === -1; });
  }

  // ---------- toast / loading ----------
  var toastEl = null;
  // P9 4.1: copy digits to the clipboard (navigator.clipboard, fallback select + execCommand).
  function copyText(text, done) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('คัดลอกไม่สำเร็จ');
      } catch (e) { toast('คัดลอกไม่สำเร็จ'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  function ddmm(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : ''; }

  function toast(msg) {
    if (toastEl) { toastEl.remove(); toastEl = null; }
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.textContent = msg;
    document.body.appendChild(toastEl);
    setTimeout(function () { if (toastEl) { toastEl.remove(); toastEl = null; } }, 3200);
  }
  // ---------- P5 §4.3: loading bar with % label + tap-lock overlay ----------
  // Several concurrent requests share one bar/overlay via a counter. P8: the bar + tap lock now appear only for writes and login;
  // background calls (api(action, payload, {silent:true}), e.g. bootstrap refresh, syncCalendar) never show them.
  var loadingCount = 0; // visible (non-silent) requests in flight
  var loadingPct = 0;
  var loadingTimer = null;
  var loadingFadeTimer = null;

  function ensureLoadingEls() {
    var wrap = document.getElementById('loadingBarWrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'loadingBarWrap';
    wrap.className = 'loading-bar-wrap';
    wrap.innerHTML = '<div class="loading-bar-track"><div class="loading-bar-fill" id="loadingBarFill"></div></div>' +
      '<div class="loading-bar-label" id="loadingBarLabel">กำลังโหลด… 0%</div>';
    document.body.appendChild(wrap);
    var overlay = document.createElement('div');
    overlay.id = 'tapLockOverlay';
    overlay.className = 'tap-lock-overlay';
    document.body.appendChild(overlay);
    return wrap;
  }

  function setLoadingPct(pct) {
    loadingPct = pct;
    var fill = document.getElementById('loadingBarFill');
    var label = document.getElementById('loadingBarLabel');
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = 'กำลังโหลด… ' + Math.round(pct) + '%';
  }

  function startLoadingAnim() {
    if (loadingTimer) return;
    ensureLoadingEls();
    var wrap = document.getElementById('loadingBarWrap');
    if (wrap) wrap.style.opacity = '1';
    setLoadingPct(0);
    loadingTimer = setInterval(function () {
      var gap = 90 - loadingPct;
      setLoadingPct(loadingPct + gap * 0.1);
    }, 100);
  }

  function stopLoadingAnim() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    setLoadingPct(100);
    if (loadingFadeTimer) clearTimeout(loadingFadeTimer);
    loadingFadeTimer = setTimeout(function () {
      var wrap = document.getElementById('loadingBarWrap');
      if (wrap) wrap.style.opacity = '0';
      var overlay = document.getElementById('tapLockOverlay');
      if (overlay) overlay.remove();
      var w2 = document.getElementById('loadingBarWrap');
      if (w2) w2.remove();
      setLoadingPct(0);
    }, 300);
  }

  function setLoading(on) {
    loadingCount += on ? 1 : -1;
    if (loadingCount < 0) loadingCount = 0;
    if (loadingCount > 0) {
      if (loadingFadeTimer) { clearTimeout(loadingFadeTimer); loadingFadeTimer = null; }
      startLoadingAnim();
    } else {
      stopLoadingAnim();
    }
  }

  // P5 §4.3: buttons that trigger writes get disabled + "กำลังบันทึก…" while the request is in flight.
  // On success the caller normally re-renders the screen (which naturally clears the disabled state);
  // on failure we restore the button so the user can retry.
  function withSavingButton(el, fn) {
    if (!el) return fn();
    var orig = el.textContent;
    el.disabled = true;
    el.textContent = 'กำลังบันทึก…';
    var restore = function () { el.disabled = false; el.textContent = orig; };
    var p = fn();
    if (p && typeof p.catch === 'function') p.catch(restore);
    return p;
  }

  function clearSession() {
    state.token = ''; state.role = ''; state.who = '';
    state.bundle = null; state.people = []; state.tueAllowed = [];
    lsDel('sl_token'); lsDel('sl_role'); lsDel('sl_who'); lsDel('sl_bundle');
  }

  // ---------- API helper ----------
  // opts.silent = true -> background call: no loading bar, no tap-lock overlay, no error toast.
  // opts.spin   = true -> (with silent) show only the small corner spinner (background bootstrap).
  var spinCount = 0;
  function setSpin(on) {
    spinCount += on ? 1 : -1;
    if (spinCount < 0) spinCount = 0;
    var el = document.getElementById('bgSpin');
    if (spinCount > 0 && !el) {
      el = document.createElement('div');
      el.id = 'bgSpin';
      el.className = 'bg-spin';
      el.setAttribute('aria-label', 'กำลังอัปเดตข้อมูล');
      document.body.appendChild(el);
    } else if (spinCount === 0 && el) {
      el.remove();
    }
  }

  function api(action, payload, opts) {
    var silent = !!(opts && opts.silent);
    var spin = !!(opts && opts.spin);
    if (!silent) setLoading(true);
    if (spin) setSpin(true);
    function done() {
      if (!silent) setLoading(false);
      if (spin) setSpin(false);
    }
    var p;
    if (window.SHIFTLOG_MOCK) {
      p = window.SHIFTLOG_MOCK(action, state.token, payload || {});
    } else {
      p = fetch(cfg.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, token: state.token, payload: payload || {} })
      }).then(function (r) { return r.json(); });
    }
    return p.then(function (res) {
      done();
      if (!res || !res.ok) {
        var msg = (res && res.error) || 'เกิดข้อผิดพลาด';
        var code = res && res.code;
        if (code === 'AUTH') {
          clearSession();
          toast(msg);
          navigate('#login');
        } else if (!silent) {
          toast(msg);
        }
        var err = new Error(msg);
        err.code = code;
        throw err;
      }
      return res.data;
    }, function (networkErr) {
      done();
      if (!silent) toast('เชื่อมต่อไม่ได้');
      throw networkErr;
    });
  }

  // ---------- P8 local-first bundle ----------
  var BUNDLE_MAX_CHARS = 2 * 1024 * 1024; // do not persist anything bigger than ~2 MB
  function persistBundle() {
    try {
      var json = JSON.stringify(state.bundle);
      if (json.length > BUNDLE_MAX_CHARS) { lsDel('sl_bundle'); return; }
      localStorage.setItem('sl_bundle', json);
    } catch (e) { /* storage full / unavailable: keep running from memory */ }
  }

  function installBundle(b) {
    state.bundle = b;
    state.people = b.people || [];
    var cf = b.config || {};
    state.tueAllowed = cf.tue_allowed || [];
    if (cf.app_users && cf.app_users.length) {
      state.appUsers = cf.app_users;
      state.users = cf.app_users;
      lsSetJSON('sl_users', cf.app_users);
    }
  }

  // After every write the server returns a fresh bundle: replace ours and persist it.
  function applyWriteBundle(res) {
    if (res && res.bundle) {
      state.bundleVer++;
      installBundle(res.bundle);
      persistBundle();
    }
    return res;
  }

  // A write call: shows the loading bar + tap lock (non-silent) and installs the returned bundle.
  function write(action, payload) {
    return api(action, payload).then(applyWriteBundle);
  }

  // Background: fire-and-forget Calendar sync for a saved/deleted event (no bar, no lock, silent errors).
  // The result only patches cal_status in the local bundle; nothing is re-fetched.
  function syncCalendarBg(eventId) {
    api('syncCalendar', { event_id: eventId }, { silent: true }).then(function (r) {
      if (!state.bundle || !r) return;
      var ev = state.bundle.events.find(function (e) { return e.event_id === r.event_id; });
      if (ev && ev.cal_status !== r.cal_status) {
        ev.cal_status = r.cal_status;
        persistBundle();
        repaintCurrent();
      }
    }).catch(function () { /* silent: the event keeps showing its Calendar warning */ });
  }

  // ---------- local computations (same Logic.js as the server) ----------
  function localMonth(ym) { return window.monthView(ym, state.bundle); }
  function localStats(ym) { return window.monthStats(ym, state.bundle); }
  function localPayout(ym) {
    var payout = window.monthPayout(ym, state.bundle);
    payout.closed = window.isClosedYm(ym, state.bundle.periods);
    var tp = (state.bundle.tempPayments || []).filter(function (r) { return r.period === ym; })[0];
    payout.tempPaid = tp ? { paid: tp.paid, marked_by: tp.marked_by, marked_at: tp.marked_at } : null;
    return payout;
  }
  function findEvent(id) {
    return (state.bundle ? state.bundle.events : []).filter(function (e) { return e.event_id === id; })[0] || null;
  }
  // First allowed Tuesday person (planner order) is the default choice for an unassigned Tuesday.
  function defaultTueId() { return (state.tueAllowed && state.tueAllowed[0]) || ''; }

  // ---------- router ----------
  var actions = {};
  var app = document.getElementById('app');
  app.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var fn = actions[el.getAttribute('data-act')];
    if (fn) fn(el, e);
  });
  app.addEventListener('change', function (e) {
    var el = e.target.closest('[data-onchange]');
    if (!el) return;
    var fn = actions[el.getAttribute('data-onchange')];
    if (fn) fn(el, e);
  });
  app.addEventListener('input', function (e) {
    var el = e.target.closest('[data-oninput]');
    if (!el) return;
    var fn = actions[el.getAttribute('data-oninput')];
    if (fn) fn(el, e);
  });

  function navigate(hash) { location.hash = hash; }

  function currentRoute() {
    var h = location.hash || '#calendar';
    var q = '';
    var qi = h.indexOf('?');
    if (qi !== -1) { q = h.slice(qi + 1); h = h.slice(0, qi); }
    var params = {};
    q.split('&').forEach(function (kv) {
      if (!kv) return;
      var idx = kv.indexOf('=');
      var k = idx === -1 ? kv : kv.slice(0, idx);
      var v = idx === -1 ? '' : decodeURIComponent(kv.slice(idx + 1));
      params[k] = v;
    });
    return { name: h.replace('#', ''), params: params };
  }

  function shiftMonth(delta) {
    var y = Number(state.ym.slice(0, 4)), m = Number(state.ym.slice(5, 7));
    m += delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.ym = y + '-' + pad2(m);
    route();
  }

  function route() {
    var r = currentRoute();
    if (!state.token && r.name !== 'login') { navigate('#login'); return; }
    if (state.token && r.name === 'login') { navigate('#calendar'); return; }
    actions = {};
    // P8: no bundle yet (first login / cold start without a persisted copy) -> skeleton until bootstrap returns.
    if (r.name !== 'login' && !state.bundle) { app.innerHTML = shellSkeleton('กำลังโหลด…', 'calendar'); return; }
    switch (r.name) {
      case 'login': return renderLogin();
      case 'calendar': return renderCalendar(r.params);
      case 'record': return renderRecord(r.params);
      case 'stats': return renderStats(r.params);
      case 'payout': return renderPayout(r.params);
      case 'settings': return renderSettings(r.params);
      default: return renderCalendar({});
    }
  }
  window.addEventListener('hashchange', route);

  // P8: redraw the current screen after the bundle changed in the background (bootstrap refresh or a
  // Calendar-status patch) WITHOUT resetting UI state (open pop-ups, half-filled record form).
  function repaintCurrent() {
    if (!state.bundle || !state.token) return;
    var r = currentRoute();
    switch (r.name) {
      case 'calendar': paintCalendar(); break;
      case 'stats': renderStats(); break;
      case 'payout': renderPayout(); break;
      case 'record': refreshRecordFromBundle(); break;
      case 'settings': if (state.role === 'owner' && !settingsState.modal) renderSettings(); break;
      default: break;
    }
  }

  // ---------- shared chrome ----------
  var ICONS = {
    calendar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M16 3v4M8 3v4M4 11h16"/></svg>',
    record: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    stats: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16M7 16v-5M12 16V8M17 16v-8"/></svg>',
    payout: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/></svg>',
    settings: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
  };
  function navHtml(active) {
    function tab(hash, label, key) {
      return '<a href="#' + hash + '" class="tab' + (key === active ? ' tab-on' : '') + '">' + ICONS[key] + '<span>' + label + '</span></a>';
    }
    return '<nav class="bottom-nav">' +
      tab('calendar', 'ปฏิทิน', 'calendar') +
      tab('record', 'บันทึก', 'record') +
      tab('stats', 'สถิติ', 'stats') +
      tab('payout', 'สรุปเงิน', 'payout') +
      tab('settings', 'ตั้งค่า', 'settings') +
      '</nav>';
  }
  function whoBadgeHtml() {
    var initial = state.who ? esc(state.who.charAt(0).toUpperCase()) : '?';
    return '<div class="who-badge"><span class="name">' + esc(state.who) + '</span><span class="avatar">' + initial + '</span></div>';
  }
  function headerHtml(title) {
    return '<header class="app-header"><div><div class="brand">CRAFTFITI · SHIFT LOG</div><h1>' + esc(title) + '</h1></div>' + whoBadgeHtml() + '</header>';
  }
  function monthArrowsHtml() {
    return '<button type="button" aria-label="เดือนก่อน" data-act="prevMonth" style="width:32px;height:36px;display:flex;align-items:center;justify-content:center;color:#7A7064"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>' +
      '<button type="button" aria-label="เดือนถัดไป" data-act="nextMonth" style="width:32px;height:36px;display:flex;align-items:center;justify-content:center;color:#7A7064"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>';
  }
  function monthHeaderHtml(titlePrefix, ym) {
    return '<header class="app-header"><div><div class="brand">CRAFTFITI · SHIFT LOG</div>' +
      '<div style="display:flex;align-items:center;gap:4px;margin-top:2px">' + monthArrowsHtml() + '<h1 style="font-size:24px">' + esc(titlePrefix ? titlePrefix + ' ' + ymLabel(ym) : ymLabel(ym)) + '</h1></div></div>' +
      whoBadgeHtml() + '</header>';
  }
  function shellSkeleton(title, active) {
    return '<div class="shell">' + headerHtml(title) +
      '<main class="app-main"><div style="padding:40px 0;text-align:center;color:#7A7064;font-size:13px">กำลังโหลด…</div></main>' +
      navHtml(active) + '</div>';
  }
  function doLogout() {
    clearSession();
    navigate('#login');
    route();
  }

  // ================= LOGIN =================
  var loginState = { who: lsGet('sl_last_who') || '', password: '', error: '' };
  function renderLogin() {
    var usersList = (state.users && state.users.length) ? state.users : cfg.APP_USERS;
    if (!loginState.who) loginState.who = usersList[0] || '';
    var pills = usersList.map(function (u) {
      return '<button type="button" class="who' + (u === loginState.who ? ' who-on' : '') + '" data-act="pickWho" data-who="' + esc(u) + '">' + esc(u) + '</button>';
    }).join('');
    app.innerHTML =
      '<div class="shell shell-dark">' +
      '<div class="login-wrap">' +
      '<div class="login-kicker">CRAFTFITI</div>' +
      '<h1 class="login-title">Shift Log</h1>' +
      '<p class="login-sub">บันทึกขาด เข้าแทน สลับวัน และ AdHoc ของทีม</p>' +
      '<label class="field-label" for="loginPw">รหัสเข้าใช้</label>' +
      '<input id="loginPw" type="password" class="login-input" placeholder="••••••" data-oninput="setLoginPw" value="' + esc(loginState.password) + '">' +
      '<div class="hint">มี 2 รหัส: Staff (ทีม) และ Owner (ตั้งเรท · ปิดงวด)</div>' +
      '<div class="field-label" style="margin-top:32px">ฉันคือ (จำไว้ในเครื่องนี้)</div>' +
      '<div class="who-row">' + pills + '</div>' +
      '<div class="hint">ชื่อนี้จะติดเป็น "บันทึกโดย" ในทุกเหตุการณ์และใน Calendar</div>' +
      (loginState.error ? '<div class="login-error">' + esc(loginState.error) + '</div>' : '') +
      '<div style="flex-grow:1"></div>' +
      '<button type="button" class="login-btn" data-act="doLogin">เข้าใช้งาน</button>' +
      '</div></div>';
    actions.pickWho = function (el) { loginState.who = el.getAttribute('data-who'); renderLogin(); };
    actions.setLoginPw = function (el) { loginState.password = el.value; };
    actions.doLogin = function () {
      if (!loginState.who) { loginState.error = 'กรุณาเลือกผู้ใช้'; renderLogin(); return; }
      api('login', { password: loginState.password, who: loginState.who }).then(function (data) {
        state.token = data.token; state.role = data.role; state.who = data.who;
        lsSet('sl_token', state.token); lsSet('sl_role', state.role); lsSet('sl_who', state.who);
        lsSet('sl_last_who', state.who);
        loginState = { who: state.who, password: '', error: '' };
        state.bundle = null; // a different user may log in on this device: never show the previous copy
        lsDel('sl_bundle');
        boot();
      }).catch(function (err) {
        loginState.error = err.message || 'เข้าสู่ระบบไม่สำเร็จ';
        renderLogin();
      });
    };
  }

  // ================= CALENDAR =================
  var calState = { selectedByYm: {}, modalOpen: false, alertOpen: false };
  // P7 §4.3.1: monthly Tuesday planner state — `choices` holds date -> person_id (unsaved until
  // "บันทึกทั้งเดือน"), `originalUnassigned` remembers which rows started blank (for the
  // "ค่าเริ่มต้น" default-person badge).
  var tuePlanState = { open: false, ym: '', plan: null, choices: {}, originalUnassigned: {} };
  var CHANGED_STATUSES = ['abs', 'hab', 'emg', 'sub', 'tmp', 'adh', 'swo', 'swi'];
  var STATUS_LABEL = { base: 'ตามเวร', abs: 'ขาด', hab: 'ขาดครึ่งวัน', sub: 'เข้าแทน', adh: 'AdHoc', swo: 'สลับออก', swi: 'สลับเข้า', emg: 'ลาฉุกเฉิน', tmp: 'คนนอกเข้าแทน' };
  var STATUS_PILLCLS = { base: 'pill p-base', abs: 'pill p-abs', hab: 'pill p-abs', sub: 'pill p-sub', adh: 'pill p-adh', swo: 'pill p-swp', swi: 'pill p-swp', emg: 'pill p-emg', tmp: 'pill p-tmp' };
  var TYPE_TAG = { absent: 'ขาด', emergency: 'ลาฉุกเฉิน', adhoc: 'AdHoc', swap: 'สลับวัน' };
  var TYPE_PILLCLS = { absent: 'pill p-abs', emergency: 'pill p-emg', adhoc: 'pill p-adh', swap: 'pill p-swp' };

  // P5 §4.1: calendar display mode, remembered in localStorage sl_calmode. 'changed' (default) or 'all'.
  function getCalMode() { return lsGet('sl_calmode') === 'all' ? 'all' : 'changed'; }
  function setCalMode(m) { lsSet('sl_calmode', m); }

  function nickChip(r) {
    if (!r.id) return '?';
    var p = personById(r.id);
    return p ? p.nick : r.id;
  }

  // Root cause of the P8 "calendar stuck after saving" bug: saveRecord navigated to
  // '#calendar?date=YYYY-MM-DD' and the old renderCalendar treated that ?date= as the source of truth on
  // EVERY route() call. shiftMonth() (the month arrows) changes state.ym and calls route(), which re-parsed
  // the same hash and forced state.ym back to the saved date's month (arrows did nothing), while the day
  // pop-up it had auto-opened (with a scroll-lock and full-screen backdrop) swallowed the day taps. Only a
  // tab switch changed the hash and cleared it. Fix: a ?date= deep link is consumed ONCE (state set, hash
  // normalised to '#calendar') and never auto-opens a pop-up; saving now sets state directly and goes to
  // plain '#calendar'.
  function renderCalendar(params) {
    if (params && params.date) {
      var pym = params.date.slice(0, 7);
      state.ym = pym;
      calState.selectedByYm[pym] = params.date;
      try { history.replaceState(null, '', location.pathname + location.search + '#calendar'); } catch (e) { /* ignore */ }
    }
    calState.modalOpen = false;
    calState.alertOpen = false;
    tuePlanState.open = false;
    paintCalendar();
  }

  // Computes the month locally (no request) and draws it. Keeps any open pop-up / planner state.
  function paintCalendar() {
    var ym = state.ym;
    var sel = calState.selectedByYm[ym];
    if (!sel) {
      sel = (ym === state.today.slice(0, 7)) ? state.today : (ym + '-01');
      calState.selectedByYm[ym] = sel;
    }
    syncBodyScrollLock();
    drawCalendar(localMonth(ym), sel, ym);
  }

  function drawCalendar(month, sel, ym) {
    var mode = getCalMode();
    // P9 4.2: staffing alerts for the displayed month (computed locally with Logic.monthAlerts).
    var monthAlertList = window.monthAlerts(ym, state.bundle);
    var alertsByDate = {};
    var alertCount = 0;
    monthAlertList.forEach(function (m) { alertsByDate[m.date] = m.alerts; alertCount += m.alerts.length; });
    var firstWd = weekdayOf(ym + '-01');
    var leading = (firstWd + 6) % 7;
    var n = daysInMonth(ym);
    var cellsHtml = '';
    for (var i = 0; i < leading; i++) cellsHtml += '<div></div>';
    for (var d = 1; d <= n; d++) {
      var date = ym + '-' + pad2(d);
      var day = month.days[d - 1];
      var hasEv = day.events.length > 0;
      var rosterForCell = day.roster;
      if (mode === 'changed') {
        rosterForCell = day.roster.filter(function (r) {
          return CHANGED_STATUSES.indexOf(r.status) !== -1 || (r.slot === 'tue' && r.unassigned);
        });
      }
      function chipHtml(r) {
        var ccls = 'chip st-' + r.status + (r.slot === 'tue' ? ' slot' : '');
        return '<span class="' + ccls + '">' + esc(nickChip(r)) + '</span>';
      }
      // P9 4.4: in "changed only" mode a day with exactly one absence that has a substitute shows them on
      // one row "absent -> sub" (wraps to two lines by itself when the cell is too narrow).
      var pairAbs = null, pairSub = null;
      if (mode === 'changed') {
        var subEvents = day.events.filter(function (ev) {
          return (ev.type === 'absent' || ev.type === 'emergency') && ev.date === date && ev.person2_id && !ev.off_schedule;
        });
        if (subEvents.length === 1) {
          pairAbs = rosterForCell.filter(function (r) { return r.id === subEvents[0].person_id && ['abs', 'hab', 'emg'].indexOf(r.status) !== -1; })[0] || null;
          pairSub = rosterForCell.filter(function (r) { return r.id === subEvents[0].person2_id && ['sub', 'tmp'].indexOf(r.status) !== -1; })[0] || null;
        }
      }
      var chips = '';
      rosterForCell.forEach(function (r) {
        if (pairAbs && pairSub) {
          if (r === pairAbs) {
            chips += '<div class="chip-pair">' + chipHtml(pairAbs) + '' + chipHtml(pairSub) + '</div>';
            return;
          }
          if (r === pairSub) return;
        }
        chips += chipHtml(r);
      });
      var cellAlerts = alertsByDate[date];
      var cls = 'cell' + (date === sel ? ' cell-sel' : '');
      cellsHtml += '<button type="button" class="' + cls + '" data-act="pickDay" data-date="' + date + '" aria-label="' + d + ' ' + esc(THAI_MONTH_FULL[Number(ym.slice(5, 7)) - 1]) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:0 1px">' +
        '<span style="font-size:12px;font-weight:600">' + d + '</span>' +
        (hasEv ? '<span style="width:7px;height:7px;border-radius:50%;background:#B8641A"></span>' : '') +
        '</div>' +
        (cellAlerts ? '<span class="cell-alert" aria-label="ต้องจัดการ">!</span>' : '') +
        '<div class="cell-chips">' + chips + '</div>' +
        '</button>';
    }
    var legend =
      '<div class="legend">' +
      '<span class="item"><span class="chip st-base">ชื่อ</span>ตามเวร</span>' +
      '<span class="item"><span class="chip st-abs">ชื่อ</span>ขาด (ขีดฆ่า)</span>' +
      '<span class="item"><span class="chip st-sub">ชื่อ</span>เข้าแทน (ตัวหนา)</span>' +
      '<span class="item"><span class="chip st-abs">ชื่อ</span>→<span class="chip st-sub">ชื่อ</span>ขาด → คนแทน</span>' +
      '<span class="item"><span class="chip st-adh">ชื่อ</span>AdHoc</span>' +
      '<span class="item"><span class="chip st-swi">ชื่อ</span>สลับ</span>' +
      '<span class="item"><span class="chip st-emg">ชื่อ</span>ลาฉุกเฉิน</span>' +
      '<span class="item"><span class="chip st-tmp">คนนอก</span>คนนอกเข้าแทน</span>' +
      '<span class="item"><span class="chip st-base slot">ชื่อ</span>ช่องอังคาร</span>' +
      '</div>';

    var calmodeHtml = '<div class="calmode-row">' +
      '<button type="button" class="calmode-btn' + (mode === 'changed' ? ' calmode-on' : '') + '" data-act="setCalMode" data-mode="changed">เฉพาะที่เปลี่ยน</button>' +
      '<button type="button" class="calmode-btn' + (mode === 'all' ? ' calmode-on' : '') + '" data-act="setCalMode" data-mode="all">ทั้งหมด</button>' +
      '</div>';

    // P7 §4.3.1: button above the grid to open the monthly Tuesday planner, with a badge when
    // any Tuesday of the displayed month is still unassigned.
    var unassignedTueCount = month.days.filter(function (day) {
      return weekdayOf(day.date) === 2 && day.tueSlot && !day.tueSlot.person_id;
    }).length;
    var tuePlannerBtnHtml = '<button type="button" class="btn-outline" style="margin-bottom:10px;width:100%;display:flex;justify-content:center;align-items:center;gap:8px" data-act="openTuePlanner">' +
      'จัดช่องอังคาร ' + esc(ymLabel(ym)) +
      (unassignedTueCount > 0 ? ' <span class="pill" style="background:#FBE1DC;color:#9B1C12">ยังไม่จัด ' + unassignedTueCount + '</span>' : '') +
      '</button>';

    var alertBtnHtml = alertCount > 0
      ? '<button type="button" class="alert-btn" data-act="openAlerts">⚠️ ต้องจัดการ ' + alertCount + '</button>'
      : '';

    app.innerHTML =
      '<div class="shell">' +
      monthHeaderHtml('', ym) +
      '<main class="app-main">' +
      alertBtnHtml +
      tuePlannerBtnHtml +
      calmodeHtml +
      '<div class="cal-grid" style="padding-bottom:4px">' +
      '<div class="cal-dow">จ</div><div class="cal-dow">อ</div><div class="cal-dow">พ</div><div class="cal-dow">พฤ</div><div class="cal-dow">ศ</div><div class="cal-dow">ส</div><div class="cal-dow">อา</div>' +
      '</div>' +
      '<div class="cal-grid">' + cellsHtml + '</div>' +
      legend +
      '</main>' +
      navHtml('calendar') +
      (calState.modalOpen ? buildDayModal(month, sel, ym, alertsByDate[sel] || []) : '') +
      (tuePlanState.open ? buildTuePlannerModal() : '') +
      (calState.alertOpen ? buildAlertSheet(monthAlertList) : '') +
      '</div>';

    actions.stop = function () { /* no-op: absorbs clicks inside modal sheet */ };
    actions.setCalMode = function (el) { setCalMode(el.getAttribute('data-mode')); drawCalendar(month, sel, ym); };
    actions.pickDay = function (el) {
      calState.selectedByYm[ym] = el.getAttribute('data-date');
      calState.modalOpen = true;
      lockBodyScroll(true);
      drawCalendar(month, calState.selectedByYm[ym], ym);
    };
    actions.prevMonth = function () { shiftMonth(-1); };
    actions.nextMonth = function () { shiftMonth(1); };
    actions.openAlerts = function () { calState.alertOpen = true; syncBodyScrollLock(); drawCalendar(month, sel, ym); };
    actions.closeAlerts = function () { calState.alertOpen = false; syncBodyScrollLock(); drawCalendar(month, sel, ym); };
    // Alert actions: find cover -> the event in edit mode with the substitute section focused;
    // arrange Tuesday -> planner; short -> the day pop-up.
    actions.alertFindCover = function (el) {
      calState.alertOpen = false; syncBodyScrollLock();
      navigate('#record?date=' + el.getAttribute('data-date') + '&event_id=' + encodeURIComponent(el.getAttribute('data-id')) + '&focus=sub');
    };
    actions.alertTuePlanner = function () { calState.alertOpen = false; openTuePlanner(ym); };
    actions.alertViewDay = function (el) {
      var dt = el.getAttribute('data-date');
      calState.alertOpen = false;
      calState.selectedByYm[ym] = dt;
      calState.modalOpen = true;
      lockBodyScroll(true);
      drawCalendar(month, dt, ym);
    };
    actions.closeDayModal = function () { calState.modalOpen = false; lockBodyScroll(false); drawCalendar(month, sel, ym); };
    actions.addEvent = function () { navigate('#record?date=' + sel); };
    actions.editEvent = function (el) { navigate('#record?date=' + sel + '&event_id=' + encodeURIComponent(el.getAttribute('data-id'))); };
    actions.deleteEvent = function (el) {
      var id = el.getAttribute('data-id');
      if (!window.confirm('ลบเหตุการณ์นี้ใช่หรือไม่')) return;
      write('deleteEvent', { event_id: id }).then(function () {
        toast('ลบแล้ว');
        syncCalendarBg(id);
        calState.modalOpen = false;
        syncBodyScrollLock();
        paintCalendar();
      });
    };
    // P7 §4.3.1/§4.3.3: monthly Tuesday planner — opened from the button above the grid or from
    // the read-only line in the day pop-up.
    actions.openTuePlanner = function () { openTuePlanner(ym); };
    actions.openTuePlannerFromDay = function () { calState.modalOpen = false; openTuePlanner(ym); };
    actions.closeTuePlanner = function () { tuePlanState.open = false; syncBodyScrollLock(); drawCalendar(month, sel, ym); };
    actions.chooseTue = function (el) {
      tuePlanState.choices[el.getAttribute('data-date')] = el.getAttribute('data-id');
      drawCalendar(month, sel, ym);
    };
    actions.saveTuePlan = function (el) {
      var slots = Object.keys(tuePlanState.choices).map(function (date) { return { date: date, person_id: tuePlanState.choices[date] }; });
      withSavingButton(el, function () { return write('setTueSlots', { ym: tuePlanState.ym, slots: slots }).then(function () {
        tuePlanState.open = false;
        calState.modalOpen = false;
        syncBodyScrollLock();
        toast('บันทึกช่องอังคารแล้ว');
        paintCalendar();
      }); });
    };
    if (calState.modalOpen) bindDayModalEsc();
  }

  function lockBodyScroll(on) {
    document.body.style.overflow = on ? 'hidden' : '';
  }

  var dayModalEscBound = false;
  function bindDayModalEsc() {
    if (dayModalEscBound) return;
    dayModalEscBound = true;
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && calState.modalOpen) {
        var el = document.querySelector('[data-act="closeDayModal"]');
        if (el) el.click();
      }
    });
  }

  // P7 §4.3.1: monthly Tuesday planner bottom sheet.
  function tueDateLabel(date) {
    var d = Number(date.slice(8, 10));
    var mIdx = Number(date.slice(5, 7)) - 1;
    return 'อ. ' + d + ' ' + THAI_MONTH_SHORT[mIdx];
  }

  function syncBodyScrollLock() {
    lockBodyScroll(tuePlanState.open || calState.modalOpen || calState.alertOpen);
  }

  // P8: the planner is computed locally (Logic.tuePlan over the bundle) - it opens instantly.
  function openTuePlanner(ym) {
    tuePlanState.open = true;
    tuePlanState.ym = ym;
    tuePlanState.choices = {};
    tuePlanState.originalUnassigned = {};
    var plan = window.tuePlan(ym, state.bundle, state.tueAllowed);
    tuePlanState.plan = plan;
    plan.days.forEach(function (d) {
      tuePlanState.choices[d.date] = d.person_id || defaultTueId();
      tuePlanState.originalUnassigned[d.date] = !d.person_id;
    });
    syncBodyScrollLock();
    paintCalendar();
  }

  function buildTuePlannerModal() {
    var plan = tuePlanState.plan;
    var ym = tuePlanState.ym;
    var bodyHtml;
    if (!plan) {
      bodyHtml = '<div style="padding:24px 0;text-align:center;color:#7A7064;font-size:13px">กำลังโหลด…</div>';
    } else if (plan.closed) {
      bodyHtml = '<div class="warn-box">งวดปิดแล้ว</div>' + plan.days.map(function (d) {
        var p = d.person_id ? personById(d.person_id) : null;
        return '<div class="detail-row"><span>' + esc(tueDateLabel(d.date)) + '</span><span>' + esc(p ? p.nick : 'ยังไม่จัด') + '</span></div>';
      }).join('');
    } else {
      bodyHtml = plan.days.map(function (d) {
        var choice = tuePlanState.choices[d.date];
        var isDefault = tuePlanState.originalUnassigned[d.date] && choice === defaultTueId();
        var opts = d.options.concat([{ person_id: '', nick: 'ไม่จัด', amount: 0, label: '' }]);
        var segHtml = opts.map(function (o) {
          var label = o.person_id === '' ? 'ไม่จัด' : o.nick;
          return '<button type="button" class="sg' + (choice === o.person_id ? ' sg-on' : '') + '" data-act="chooseTue" data-date="' + d.date + '" data-id="' + o.person_id + '">' + esc(label) + '</button>';
        }).join('');
        var chosenOpt = d.options.find(function (o) { return o.person_id === choice; });
        var payHint = chosenOpt ?
          (esc(chosenOpt.nick) + ' · ' + (chosenOpt.label.indexOf('AdHoc') !== -1 ? 'AdHoc' : 'เรทปกติ') + ' +' + money2(chosenOpt.amount)) :
          'ไม่จัด · ไม่มีผลต่อเงิน';
        return '<div style="padding:10px 0;border-top:1px solid #F0EAE0">' +
          '<span style="font-size:13px;font-weight:600">' + esc(tueDateLabel(d.date)) +
          (isDefault ? ' <span style="font-size:11px;font-weight:400;color:#7A7064">(ค่าเริ่มต้น)</span>' : '') + '</span>' +
          '<div class="seg seg-4" style="margin-top:6px">' + segHtml + '</div>' +
          '<div style="font-size:12px;color:#6B6257;margin-top:4px">' + payHint + '</div>' +
          '</div>';
      }).join('');
    }
    var footer = (plan && !plan.closed) ? '<button type="button" class="btn-primary" style="margin-top:14px;width:100%" data-act="saveTuePlan">บันทึกทั้งเดือน</button>' : '';
    return '<div class="modal-backdrop" data-act="closeTuePlanner">' +
      '<div class="modal-sheet" data-act="stop" style="position:relative">' +
      '<button type="button" class="day-modal-close" data-act="closeTuePlanner" aria-label="ปิด">✕</button>' +
      '<div style="font-weight:600;font-size:18px;padding-right:36px">จัดช่องอังคาร ' + esc(ymLabel(ym)) + '</div>' +
      bodyHtml + footer +
      '</div></div>';
  }

  // P9 4.2: the "needs attention" sheet. Today and future days first, past days under "ที่ผ่านมา".
  function alertDayLabel(date) {
    return THAI_WEEKDAY_FULL[weekdayOf(date)] + ' ' + Number(date.slice(8, 10)) + ' ' + THAI_MONTH_SHORT[Number(date.slice(5, 7)) - 1];
  }
  function alertItemHtml(date, a) {
    var btn = '';
    if (a.kind === 'pending_cover') {
      var ev = a.event_id ? findEvent(a.event_id) : null;
      var closed = ev && window.isClosedYm(window.payPeriodOf(ev), state.bundle.periods);
      if (!closed) btn = '<button type="button" class="btn-outline" data-act="alertFindCover" data-date="' + date + '" data-id="' + esc(a.event_id) + '">หาคนแทน</button>';
    } else if (a.kind === 'tue_unassigned') {
      btn = '<button type="button" class="btn-outline" data-act="alertTuePlanner">จัดช่องอังคาร</button>';
    } else {
      btn = '<button type="button" class="btn-outline" data-act="alertViewDay" data-date="' + date + '">ดูวันนี้</button>';
    }
    return '<div class="alert-item"><span>' + esc(a.message) + '</span>' + btn + '</div>';
  }
  function buildAlertSheet(list) {
    var today = state.today;
    function dayBlock(m) {
      return '<div class="alert-day"><div style="font-size:13px;font-weight:600">' + esc(alertDayLabel(m.date)) + '</div>' +
        m.alerts.map(function (a) { return alertItemHtml(m.date, a); }).join('') + '</div>';
    }
    var upcoming = list.filter(function (m) { return m.date >= today; });
    var past = list.filter(function (m) { return m.date < today; });
    var body = upcoming.map(dayBlock).join('');
    if (past.length) {
      body += '<div style="font-size:12px;font-weight:600;color:#6B6257;margin-top:14px;letter-spacing:.3px">ที่ผ่านมา</div>' + past.map(dayBlock).join('');
    }
    return '<div class="modal-backdrop" data-act="closeAlerts">' +
      '<div class="modal-sheet" data-act="stop" style="position:relative">' +
      '<button type="button" class="day-modal-close" data-act="closeAlerts" aria-label="ปิด">✕</button>' +
      '<div style="font-weight:600;font-size:18px;padding-right:36px">⚠️ ต้องจัดการ</div>' +
      body +
      '</div></div>';
  }

  // P5 §4.1: bottom-sheet day pop-up — replaces the old inline day-detail card.
  // Reuses .modal-backdrop / .modal-sheet. Closes via ✕, backdrop tap, or Escape (handled in drawCalendar).
  function buildDayModal(month, sel, ym, dayAlertList) {
    var d = Number(sel.slice(8, 10));
    var wd = weekdayOf(sel);
    var day = month.days[d - 1];
    var title = THAI_WEEKDAY_FULL[wd] + ' ' + d + ' ' + THAI_MONTH_SHORT[Number(sel.slice(5, 7)) - 1] + ' ' + sel.slice(0, 4);
    var working = day.roster.filter(function (r) { return r.id && ['abs', 'emg', 'swo'].indexOf(r.status) === -1; }).length;

    var rows = day.roster.map(function (r) {
      var p = r.id ? personById(r.id) : null;
      var name = r.id ? (p ? p.nick : r.id) : 'ยังไม่จัด';
      var tags = [];
      if (p && p.group === 'temp') tags.push('จ้างชั่วคราว');
      if (p && p.group === 'director') tags.push('กรรมการ');
      if (r.slot === 'tue') tags.push('ช่องอังคาร');
      if (r.slot === 'alt') tags.push('ศุกร์เว้นศุกร์');
      if (r.off_schedule) tags.push('นอกตาราง');
      var label = STATUS_LABEL[r.status] || r.status;
      var cls = STATUS_PILLCLS[r.status] || 'pill p-base';
      return '<div class="detail-row"><div><span style="font-size:14px;font-weight:500">' + esc(name) + '</span> <span style="font-size:12px;color:#7A7064">' + esc(tags.join(' · ')) + '</span></div><span class="' + cls + '">' + esc(label) + '</span></div>';
    }).join('');

    var eventsHtml;
    if (day.events.length) {
      eventsHtml = day.events.map(function (e) {
        var tag = (e.type === 'absent' && e.portion === 0.5) ? 'ขาดครึ่งวัน' : TYPE_TAG[e.type];
        // P6 §4.4.3: small pill when this event's money was carried to a different pay period.
        var carriedPill = e.pay_carried ? '<span class="pill" style="background:#EDE3D0;color:#6B4A17">คิดเงิน ' + esc(THAI_MONTH_SHORT[Number(e.pay_period.slice(5, 7)) - 1]) + '</span>' : '';
        var moneyHtml = (e.money || []).map(function (line) {
          var cls = line.amount > 0 ? 'amt-pos' : (line.amount < 0 ? 'amt-neg' : 'amt-zero');
          var text = line.label + (line.bucket === 'temp' ? ' · จ่ายนอกสลิป' : '');
          return '<div class="event-money-line ' + cls + '">' + esc(text) + '</div>';
        }).join('');
        var meta = 'บันทึกโดย ' + esc(e.recorded_by) + ' · ' + esc(fmtDT(e.recorded_at));
        if (e.updated_by) meta += ' · แก้โดย ' + esc(e.updated_by);
        if (e.note) meta += ' · ' + esc(e.note);
        meta += ' · ' + (e.cal_status === 'ok' ? 'ส่งเข้า Calendar แล้ว' : (e.cal_status === 'pending' ? 'กำลังส่งเข้า Calendar…' : '⚠️ ยังไม่เข้า Calendar'));
        // P6 §4.4.3: hide edit/delete based on the EVENT's own pay period being closed, not the day's month.
        var editDelete = e.pay_closed ? '' :
          '<div style="display:flex;gap:14px;margin-top:8px">' +
          '<button type="button" data-act="editEvent" data-id="' + esc(e.event_id) + '" style="font-size:12px;font-weight:600;color:#9A4F0E">แก้ไข</button>' +
          '<button type="button" data-act="deleteEvent" data-id="' + esc(e.event_id) + '" class="btn-danger" style="font-size:12px;font-weight:600">ลบ</button>' +
          '</div>';
        return '<div class="event-card">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="' + TYPE_PILLCLS[e.type] + '">' + esc(tag) + '</span><span style="font-size:14px;font-weight:500">' + esc(e.title) + '</span>' + carriedPill + '</div>' +
          moneyHtml +
          '<div class="event-meta">' + meta + '</div>' +
          editDelete +
          '</div>';
      }).join('');
    } else {
      eventsHtml = '<div style="font-size:13px;color:#7A7064;margin-top:6px">ไม่มีการเปลี่ยนแปลง เป็นไปตามตาราง</div>';
    }

    // P6 §4.4.3: the "add event" button stays visible even when the day's own month is closed
    // (a late event dated in a closed month is now allowed — its money carries to the next open period).
    var addBtn = '<button type="button" class="btn-secondary" style="margin-top:12px" data-act="addEvent">+ เพิ่มเหตุการณ์วันนี้</button>';

    // P7 §4.3.3: on Tuesdays the popup shows a read-only line for the slot (money comes straight
    // from the API's monthView `tueSlot` field) plus a link that opens the monthly planner.
    var tueHtml = '';
    if (wd === 2) {
      var slotInfo = day.tueSlot || { person_id: '', money: [] };
      var slotLine = slotInfo.person_id
        ? (esc(nickOf(slotInfo.person_id)) + (slotInfo.money.length ? ' · ' + esc(slotInfo.money[0].label) : ''))
        : 'ยังไม่จัด';
      tueHtml = '<div class="tue-ctl">' +
        '<div style="font-size:13px;font-weight:600">ช่องอังคาร</div>' +
        '<div style="font-size:13px;margin-top:4px">' + slotLine + '</div>' +
        '<button type="button" class="btn-outline" style="margin-top:8px;width:100%" data-act="openTuePlannerFromDay">จัดช่องอังคารทั้งเดือน</button>' +
        '</div>';
    }

    return '<div class="modal-backdrop" data-act="closeDayModal">' +
      '<div class="modal-sheet" data-act="stop" style="position:relative">' +
      '<button type="button" class="day-modal-close" data-act="closeDayModal" aria-label="ปิด">✕</button>' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding-right:36px">' +
      '<div><div style="font-weight:600;font-size:18px">' + esc(title) + '</div></div>' +
      '<span class="pill p-base">' + working + ' คนเข้างาน</span>' +
      '</div>' +
      ((dayAlertList && dayAlertList.length)
        ? '<div class="alert-box">' + dayAlertList.map(function (a) { return '<div>⚠️ ' + esc(a.message) + '</div>'; }).join('') + '</div>'
        : '') +
      '<div style="margin-top:8px">' + rows + '</div>' +
      tueHtml +
      '<div style="font-size:12px;font-weight:600;color:#6B6257;margin-top:10px;letter-spacing:.3px">เหตุการณ์วันนี้</div>' +
      eventsHtml +
      addBtn +
      '</div></div>';
  }

  // After a save/delete: put the calendar on that date's month with that date selected, no pop-up, and
  // a plain '#calendar' hash (see the root-cause note on renderCalendar).
  function showCalendarOn(date) {
    state.ym = date.slice(0, 7);
    calState.selectedByYm[state.ym] = date;
    calState.modalOpen = false;
    calState.alertOpen = false;
    tuePlanState.open = false;
    lockBodyScroll(false);
    if (location.hash === '#calendar') route(); else navigate('#calendar');
  }

  // ================= RECORD =================
  var recState = {};
  function resetRecState(prefillDate, editingEvent) {
    recState = {
      type: 'absent', date: prefillDate || state.today, date2: '',
      absentee: '', portion: 1, subMode: 'pending', teamSub: '', payMode: 'normal', // P9: subMode team | outside | pending (รอหาคนแทน) | none (ไม่ต้องมีคนแทน)
      tempSub: '', newTempNick: '', newTempRate: 625, newTempRegular: true, newTempBank: '', newTempAcct: '', focusSub: false,
      adhocPerson: '', swapA: '', swapB: '', note: '', eventId: '', saved: false, savedCalNote: '',
      dayRoster: [], dayRoster2: [],
      payPeriodChoice: 'event', dateMonthClosed: false,
      offSchedule: false, deductMode: 'adhoc', // P8 section 4.4: off-schedule absence
      preview: { title: '', money: [], errors: [], warnings: [] }
    };
    if (editingEvent) {
      var e = editingEvent;
      recState.eventId = e.event_id;
      recState.type = e.type;
      recState.date = e.date;
      recState.date2 = e.date2 || '';
      recState.note = e.note || '';
      recState.portion = e.portion || 1;
      // P6: prefill the pay-period choice from the saved event (falls back to the event month for legacy rows).
      recState.payPeriodChoice = (e.pay_period && e.pay_period !== e.date.slice(0, 7)) ? 'next' : 'event';
      if (e.type === 'absent' || e.type === 'emergency') {
        recState.absentee = e.person_id;
        if (e.off_schedule) {
          recState.offSchedule = true;
          recState.deductMode = e.deduct_mode === 'absent' ? 'absent' : 'adhoc';
        }
        if (e.person2_id) {
          var subP = personById(e.person2_id);
          if (subP && subP.group === 'temp') { recState.subMode = 'outside'; recState.tempSub = e.person2_id; }
          else { recState.subMode = 'team'; recState.teamSub = e.person2_id; recState.payMode = e.sub_pay === 'adhoc' ? 'adhoc' : 'normal'; }
        } else {
          // legacy events (no substitute, blank cover) count as "ไม่ต้องมีคนแทน"
          recState.subMode = e.cover === 'pending' ? 'pending' : 'none';
        }
      } else if (e.type === 'adhoc') {
        recState.adhocPerson = e.person_id;
      } else if (e.type === 'swap') {
        recState.swapA = e.person_id;
        recState.swapB = e.person2_id;
      }
    }
  }

  function renderRecord(params) {
    var prefDate = params.date || state.today;
    if (params.event_id) {
      var found = findEvent(params.event_id);
      resetRecState(found ? found.date : prefDate, found);
    } else {
      resetRecState(prefDate, null);
      if (params.type) recState.type = params.type;
    }
    // P9 4.2: "หาคนแทน" from the alert sheet opens the event with the substitute section in view.
    if (params.focus === 'sub' && recState.eventId) {
      recState.focusSub = true;
      if (recState.subMode === 'pending' || recState.subMode === 'none') recState.subMode = 'team';
    }
    loadRosterAndDraw();
  }

  // P8: rosters come from Logic.dayRoster over the local bundle (no request). While editing, the event
  // itself is left out (same as the validation does) so its own effect does not hide the absentee/sub.
  function rosterFor(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return [];
    var data = recState.eventId ? window.cloneDataWithoutEvent(state.bundle, recState.eventId) : state.bundle;
    return window.dayRoster(date, data).roster;
  }

  function loadRosterAndDraw() {
    recState.dayRoster = rosterFor(recState.date);
    recState.dateMonthClosed = /^\d{4}-\d{2}-\d{2}$/.test(recState.date || '') && window.isClosedYm(recState.date.slice(0, 7), state.bundle.periods); // P6: drives the "คิดเงินงวด" field
    recState.dayRoster2 = (recState.type === 'swap' && recState.date2) ? rosterFor(recState.date2) : [];
    refreshRecord();
  }

  // Background bundle refresh while on the Record tab: re-derive rosters + preview from the new data,
  // but do not redraw the form under the user's fingers while they are typing.
  function refreshRecordFromBundle() {
    if (!recState || !recState.date) return;
    var t = document.activeElement && document.activeElement.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      recState.dayRoster = rosterFor(recState.date);
      recState.dayRoster2 = (recState.type === 'swap' && recState.date2) ? rosterFor(recState.date2) : [];
      computePreview();
      updatePreviewDom();
      return;
    }
    loadRosterAndDraw();
  }

  function absenteeOptions(roster) {
    // P8 section 4.4: an off-schedule absentee has no shift that day -> any active director/staff.
    if (recState.type === 'absent' && recState.offSchedule) return activeDirectorsStaff();
    return roster.filter(function (r) { return r.id && ['base', 'swi', 'sub'].indexOf(r.status) !== -1; })
      .map(function (r) { return personById(r.id); }).filter(Boolean);
  }

  function recRequiredOk() {
    if (recState.type === 'absent' || recState.type === 'emergency') {
      if (!recState.absentee || !recState.date) return false;
      if (recState.type === 'absent' && recState.offSchedule) return recState.deductMode === 'adhoc' || recState.deductMode === 'absent';
      if (recState.subMode === 'outside' && !recState.tempSub) return false;
      if (recState.subMode === 'team' && !recState.teamSub) return false;
      return true;
    }
    if (recState.type === 'adhoc') return !!(recState.adhocPerson && recState.date);
    if (recState.type === 'swap') return !!(recState.swapA && recState.swapB && recState.date && recState.date2);
    return false;
  }

  // P6: pay_period payload for absent/emergency/adhoc — omitted (server defaults to the event
  // month) when the event month is not closed and the recorder kept the default choice; when the
  // event month IS closed the server forces the pay period regardless, so nothing is sent.
  function payPeriodPayloadFor(type) {
    if (type !== 'absent' && type !== 'emergency' && type !== 'adhoc') return undefined;
    if (recState.dateMonthClosed) return undefined;
    return recState.payPeriodChoice === 'next' ? nextYm(recState.date.slice(0, 7)) : '';
  }

  function buildEventPayload() {
    var ev = {};
    if (recState.eventId) ev.event_id = recState.eventId;
    ev.type = recState.type;
    ev.date = recState.date;
    ev.note = recState.note || '';
    var payPeriod = payPeriodPayloadFor(recState.type);
    if (payPeriod !== undefined) ev.pay_period = payPeriod;
    if (recState.type === 'absent' && recState.offSchedule) {
      ev.person_id = recState.absentee;
      ev.portion = recState.portion;
      ev.date2 = '';
      ev.person2_id = '';
      ev.sub_pay = '';
      ev.off_schedule = true;
      ev.deduct_mode = recState.deductMode;
    } else if (recState.type === 'absent' || recState.type === 'emergency') {
      ev.person_id = recState.absentee;
      ev.portion = recState.portion;
      ev.date2 = '';
      if (recState.subMode === 'team') {
        ev.person2_id = recState.teamSub;
        var subP = personById(recState.teamSub);
        ev.sub_pay = (subP && subP.group === 'director') ? 'adhoc' : recState.payMode;
      } else if (recState.subMode === 'outside') {
        ev.person2_id = recState.tempSub;
        ev.sub_pay = 'temp';
      } else {
        ev.person2_id = '';
        ev.sub_pay = '';
      }
      // P9 4.2: cover — '' when a substitute is chosen, else pending (รอหาคนแทน) / none (ไม่ต้องมีคนแทน)
      ev.cover = recState.subMode === 'pending' ? 'pending' : (recState.subMode === 'none' ? 'none' : '');
    } else if (recState.type === 'adhoc') {
      ev.person_id = recState.adhocPerson;
      ev.portion = recState.portion;
      ev.date2 = '';
      ev.person2_id = '';
      ev.sub_pay = '';
    } else if (recState.type === 'swap') {
      ev.person_id = recState.swapA;
      ev.person2_id = recState.swapB;
      ev.date2 = recState.date2;
      ev.portion = 1;
      ev.sub_pay = '';
    }
    return ev;
  }

  // P8: the preview is computed in the browser with the same Logic.previewEvent the server runs on save
  // (the server still re-validates every write), so it is instant - no debounce, no request.
  function computePreview() {
    if (!recRequiredOk()) {
      recState.preview = { title: '', money: [], errors: [], warnings: [] };
      return;
    }
    try {
      recState.preview = window.previewEvent(buildEventPayload(), state.bundle, recState.eventId || undefined);
    } catch (err) {
      recState.preview = { title: '', money: [], errors: [err.message], warnings: [] };
    }
  }
  function schedulePreview() { computePreview(); updatePreviewDom(); } // note typing: refresh only the preview area
  function refreshRecord() { computePreview(); drawRecord(); }         // anything that changes the form layout

  function previewSaveHtml() {
    var pv = recState.preview;
    var linesHtml = (pv.money || []).map(function (l) {
      var cls = l.amount > 0 ? 'amt-pos' : (l.amount < 0 ? 'amt-neg' : 'amt-zero');
      var name = esc(nickOf(l.person_id));
      var suffix = l.bucket === 'temp' ? ' <span style="font-size:12px;color:#7A7064">(จ่ายนอกสลิป)</span>' : '';
      var amtText = (l.amount > 0 ? '+' : (l.amount < 0 ? '' : '')) + money2(l.amount);
      return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #F0EAE0;font-size:14px"><span>' + name + suffix + '</span><span class="' + cls + '">' + amtText + '</span></div>';
    }).join('');
    var warnHtml = (pv.warnings || []).map(function (w) { return '<div class="warn-box">' + esc(w) + '</div>'; }).join('');
    var errHtml = (pv.errors || []).map(function (w) { return '<div class="error-box">' + esc(w) + '</div>'; }).join('');
    // P6 §4.4.2: pay period line, with "(ยกไปเดือนถัดไป)" when it differs from the event's own month.
    var payPeriodLine = '';
    if (pv.pay_period) {
      var evMonth = recState.date ? recState.date.slice(0, 7) : '';
      var carried = pv.pay_period !== evMonth;
      payPeriodLine = '<div style="font-size:13px;font-weight:500;margin-top:4px">คิดเงินงวด: ' + esc(monthYearShort(pv.pay_period)) + (carried ? ' (ยกไปเดือนถัดไป)' : '') + '</div>';
    }
    var previewHtml = '<div class="card" style="margin-top:18px">' +
      '<div style="font-size:13px;font-weight:500">ชื่อใน Calendar: ' + esc(pv.title || '—') + '</div>' +
      payPeriodLine +
      linesHtml + warnHtml + errHtml +
      '</div>';
    var disableSave = !recRequiredOk() || (pv.errors && pv.errors.length > 0);
    var saveBtnHtml = '<button type="button" class="btn-primary" style="margin-top:14px" data-act="saveRecord"' + (disableSave ? ' disabled' : '') + '>บันทึก</button>';
    var deleteBtnHtml = recState.eventId ? '<button type="button" class="btn-primary" style="margin-top:10px;background:#FBE1DC;color:#9B1C12" data-act="deleteRecord">ลบเหตุการณ์นี้</button>' : '';
    return '<div id="previewSaveArea">' + previewHtml + saveBtnHtml + deleteBtnHtml + '</div>';
  }

  function updatePreviewDom() {
    var el = document.getElementById('previewSaveArea');
    if (!el) return;
    el.outerHTML = previewSaveHtml();
  }

  function drawRecord() {
    var title = recState.eventId ? 'แก้ไขเหตุการณ์' : 'บันทึกเหตุการณ์';
    var roster = recState.dayRoster || [];
    var rosterNames = roster.filter(function (r) { return r.id; }).map(function (r) { return nickOf(r.id); });

    // P7 §4.3.2: fixed tab order back to ขาดงาน, AdHoc, สลับวัน, ลาฉุกเฉิน (ช่องอังคาร moved to
    // the Calendar tab's monthly planner — see openTuePlanner).
    var typeHtml = '<div class="lbl" style="margin-top:6px">ประเภท</div><div class="seg seg-4">' +
      [{ k: 'absent', l: 'ขาดงาน' }, { k: 'adhoc', l: 'AdHoc' }, { k: 'swap', l: 'สลับวัน' }, { k: 'emergency', l: 'ลาฉุกเฉิน' }].map(function (t) {
        return '<button type="button" class="sg' + (t.k === recState.type ? ' sg-on' : '') + '" data-act="setType" data-type="' + t.k + '">' + t.l + '</button>';
      }).join('') + '</div>' +
      (recState.type === 'emergency' ? '<div style="font-size:12px;color:#6B6257;margin-top:4px">ลาแบบบริษัทยังจ่ายเงิน (ไม่หักเงิน)</div>' : '');

    var absentHtml = '';
    var isOff = recState.type === 'absent' && recState.offSchedule;
    if (recState.type === 'absent' || recState.type === 'emergency') {
      var absOpts = absenteeOptions(roster);
      var label = recState.type === 'emergency' ? 'ใครลาฉุกเฉิน' : 'ใครขาด';
      if (recState.type === 'absent') {
        absentHtml += '<label class="checkbox-row"><input type="checkbox" data-onchange="setOffSchedule" ' + (isOff ? 'checked' : '') + '>ขาดนอกตาราง (ไม่มีเวรวันนั้น)</label>';
      }
      absentHtml += '<div class="lbl">' + label + '</div><div class="opt-row">' + absOpts.map(function (p) {
        return '<button type="button" class="opt' + (p.id === recState.absentee ? ' opt-on' : '') + '" data-act="setAbsentee" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
      }).join('') + '</div>';

      absentHtml += '<div class="lbl">ระยะเวลา</div><div class="seg seg-2">' +
        '<button type="button" class="sg' + (recState.portion === 1 ? ' sg-on' : '') + '" data-act="setPortion" data-p="1">เต็มวัน</button>' +
        '<button type="button" class="sg' + (recState.portion === 0.5 ? ' sg-on' : '') + '" data-act="setPortion" data-p="0.5">ครึ่งวัน</button>' +
        '</div>';

      if (isOff) {
        absentHtml += '<div class="lbl">หักเท่า</div><div class="seg seg-2">' +
          '<button type="button" class="sg' + (recState.deductMode === 'adhoc' ? ' sg-on' : '') + '" data-act="setDeductMode" data-m="adhoc">เรท AdHoc</button>' +
          '<button type="button" class="sg' + (recState.deductMode === 'absent' ? ' sg-on' : '') + '" data-act="setDeductMode" data-m="absent">เรทขาดปกติ</button>' +
          '</div>' +
          '<div style="font-size:12px;color:#6B6257;margin-top:4px">ใช้เมื่อคนนี้ไม่มีเวรวันนั้น (เช่น จ่ายเป็น AdHoc ไปแล้วแต่ไม่ได้มา) · ไม่มีคนเข้าแทน · ไม่นับเป็นวันตามตาราง</div>';
      } else {
      absentHtml += '<div class="lbl" id="subSection">คนเข้าแทน</div><div class="seg seg-4">' +
        '<button type="button" class="sg' + (recState.subMode === 'team' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="team">ทีมงาน</button>' +
        '<button type="button" class="sg' + (recState.subMode === 'outside' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="outside">คนนอก</button>' +
        '<button type="button" class="sg' + (recState.subMode === 'pending' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="pending">รอหาคนแทน</button>' +
        '<button type="button" class="sg' + (recState.subMode === 'none' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="none">ไม่ต้องมีคนแทน</button>' +
        '</div>' +
        (recState.subMode === 'pending' ? '<div style="font-size:12px;color:#6B6257;margin-top:4px">ระบบจะเตือนในปฏิทินจนกว่าจะมีคนแทน</div>' : '');

      if (recState.subMode === 'team') {
        var teamOpts = availableSubs(roster);
        absentHtml += '<div class="opt-row">' + teamOpts.map(function (p) {
          return '<button type="button" class="opt' + (p.id === recState.teamSub ? ' opt-on' : '') + '" data-act="setTeamSub" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
        }).join('') + '</div>';
        var subP2 = recState.teamSub ? personById(recState.teamSub) : null;
        if (subP2 && subP2.group === 'director') {
          absentHtml += '<div class="lbl">คนแทนได้ค่าแรงแบบไหน</div><div class="warn-box">' + esc(subP2.nick) + ' เป็นกรรมการ นับเป็น AdHoc อัตโนมัติ</div>';
        } else if (subP2) {
          absentHtml += '<div class="lbl">คนแทนได้ค่าแรงแบบไหน</div><div class="seg seg-2">' +
            '<button type="button" class="sg' + (recState.payMode === 'normal' ? ' sg-on' : '') + '" data-act="setPayMode" data-m="normal">เรทปกติ</button>' +
            '<button type="button" class="sg' + (recState.payMode === 'adhoc' ? ' sg-on' : '') + '" data-act="setPayMode" data-m="adhoc">AdHoc</button>' +
            '</div>';
        }
      } else if (recState.subMode === 'outside') {
        var temps = activeRegularTemps();
        absentHtml += '<div class="temp-card"><div style="font-size:13px;font-weight:600;color:#17613B">คนนอก (จ้างชั่วคราว)</div>' +
          '<div style="font-size:12px;color:#6B6257;margin-top:2px">เลือกจากคนที่เคยเรียกบ่อย หรือเพิ่มชื่อใหม่</div>' +
          '<div class="opt-row" style="margin-top:10px">' + temps.map(function (p) {
            return '<button type="button" class="opt' + (p.id === recState.tempSub ? ' opt-on' : '') + '" data-act="setTempSub" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
          }).join('') + '</div>' +
          '<div style="display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:8px;margin-top:12px">' +
          '<div><label for="tname" style="font-size:11px;font-weight:600;color:#6B6257">ชื่อใหม่</label><input id="tname" data-oninput="setNewTempNick" value="' + esc(recState.newTempNick) + '" placeholder="ชื่อเล่น" style="width:100%;height:42px;margin-top:4px"></div>' +
          '<div><label for="trate" style="font-size:11px;font-weight:600;color:#6B6257">ค่าแรง/วัน</label><input id="trate" data-oninput="setNewTempRate" inputmode="numeric" value="' + esc(recState.newTempRate) + '" style="width:100%;height:42px;margin-top:4px"></div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:8px;margin-top:10px">' +
          '<div><label for="tbank" style="font-size:11px;font-weight:600;color:#6B6257">ธนาคาร (ไม่บังคับ)</label><input id="tbank" data-oninput="setNewTempBank" value="' + esc(recState.newTempBank) + '" placeholder="เช่น กสิกร" style="width:100%;height:42px;margin-top:4px"></div>' +
          '<div><label for="tacct" style="font-size:11px;font-weight:600;color:#6B6257">เลขบัญชี (ไม่บังคับ)</label><input id="tacct" data-oninput="setNewTempAcct" inputmode="numeric" autocomplete="off" value="' + esc(recState.newTempAcct) + '" style="width:100%;height:42px;margin-top:4px"></div>' +
          '</div>' +
          '<label class="checkbox-row"><input type="checkbox" data-onchange="setNewTempRegular" ' + (recState.newTempRegular ? 'checked' : '') + '>บันทึกชื่อไว้ให้เลือกครั้งหน้า</label>' +
          '<div style="font-size:12px;color:#6B6257;margin-top:2px">ไม่ติ๊ก = ใช้ครั้งเดียว ชื่อจะไม่ขึ้นในรายการครั้งถัดไป (ข้อมูลเก่ายังอยู่)</div>' +
          '<button type="button" class="btn-outline" style="margin-top:10px" data-act="addTempPerson">+ เพิ่มคนนอก</button>' +
          '</div>';
      }
      } // end !isOff (substitute section)
    }

    var swapHtml = '';
    if (recState.type === 'swap') {
      var aOpts = roster.filter(function (r) { return r.status === 'base'; }).map(function (r) { return personById(r.id); }).filter(Boolean);
      swapHtml += '<div class="lbl">คนที่สลับออก (มีเวรวันนี้)</div><div class="opt-row">' + aOpts.map(function (p) {
        return '<button type="button" class="opt' + (p.id === recState.swapA ? ' opt-on' : '') + '" data-act="setSwapA" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
      }).join('') + '</div>';
      swapHtml += '<label class="lbl" for="recDate2">วันที่คนนั้นยกเวรคืนให้</label><input type="date" id="recDate2" data-oninput="setDate2" value="' + esc(recState.date2) + '" style="width:100%;height:48px">';
      var roster2 = recState.dayRoster2 || [];
      var bOpts = roster2.filter(function (r) { return r.status === 'base'; }).map(function (r) { return personById(r.id); }).filter(Boolean);
      swapHtml += '<div class="lbl">สลับกับ</div><div class="opt-row">' + bOpts.map(function (p) {
        return '<button type="button" class="opt' + (p.id === recState.swapB ? ' opt-on' : '') + '" data-act="setSwapB" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
      }).join('') + '</div>';
    }

    var adhocHtml = '';
    if (recState.type === 'adhoc') {
      var adhOpts = availableSubs(roster);
      adhocHtml += '<div class="lbl">ใครมาช่วยร้าน</div><div class="opt-row">' + adhOpts.map(function (p) {
        return '<button type="button" class="opt' + (p.id === recState.adhocPerson ? ' opt-on' : '') + '" data-act="setAdhocPerson" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
      }).join('') + '</div>';
      adhocHtml += '<div class="lbl">ระยะเวลา</div><div class="seg seg-2">' +
        '<button type="button" class="sg' + (recState.portion === 1 ? ' sg-on' : '') + '" data-act="setPortion" data-p="1">เต็มวัน</button>' +
        '<button type="button" class="sg' + (recState.portion === 0.5 ? ' sg-on' : '') + '" data-act="setPortion" data-p="0.5">ครึ่งวัน</button>' +
        '</div>';
    }

    // P6 §4.4.1: pay-period ("คิดเงินงวด") field for absent/emergency/adhoc — hidden for swap/tue.
    var payPeriodHtml = '';
    if (recState.type === 'absent' || recState.type === 'emergency' || recState.type === 'adhoc') {
      var evMonth = recState.date.slice(0, 7);
      var nextM = nextYm(evMonth);
      if (recState.dateMonthClosed) {
        var forcedYm = (recState.preview && recState.preview.pay_period) || nextM;
        payPeriodHtml = '<div class="lbl">คิดเงินงวด</div>' +
          '<div class="warn-box">เดือน ' + esc(monthYearShort(evMonth)) + ' ปิดงวดแล้ว — เงินจะไปคิดในงวด ' + esc(monthYearShort(forcedYm)) + '</div>';
      } else {
        payPeriodHtml = '<div class="lbl">คิดเงินงวด</div><div class="seg seg-2">' +
          '<button type="button" class="sg' + (recState.payPeriodChoice === 'event' ? ' sg-on' : '') + '" data-act="setPayPeriodChoice" data-c="event">' + esc(monthYearShort(evMonth)) + '</button>' +
          '<button type="button" class="sg' + (recState.payPeriodChoice === 'next' ? ' sg-on' : '') + '" data-act="setPayPeriodChoice" data-c="next">' + esc(monthYearShort(nextM)) + '</button>' +
          '</div>';
      }
    }

    var noteHtml = '<label class="lbl" for="recNote">' + (isOff ? 'หมายเหตุ (แนะนำให้ใส่)' : 'หมายเหตุ (ไม่บังคับ)') + '</label><textarea id="recNote" rows="2" data-oninput="setNote" placeholder="' + (isOff ? 'เช่น จ่าย AdHoc 12 ก.ย. ไปแล้วแต่ไม่ได้มา' : 'แจ้งตอน 10 โมง ไม่สบาย') + '" style="width:100%">' + esc(recState.note) + '</textarea>';

    app.innerHTML =
      '<div class="shell">' +
      '<header class="app-header"><div><div class="brand">CRAFTFITI · SHIFT LOG</div><h1>' + esc(title) + '</h1></div></header>' +
      '<main class="app-main">' +
      (recState.saved ? '<div class="saved-box">บันทึกแล้ว' + esc(recState.savedCalNote || '') + '</div>' : '') +
      '<label class="lbl" for="recDate" style="margin-top:0">วันที่</label>' +
      '<input type="date" id="recDate" data-oninput="setDate" value="' + esc(recState.date) + '" style="width:100%;height:48px">' +
      '<div style="font-size:12px;color:#6B6257;margin-top:6px">เวรวันนี้: ' + esc(rosterNames.join(' · ') || '—') + '</div>' +
      typeHtml + absentHtml + swapHtml + adhocHtml + payPeriodHtml +
      noteHtml + previewSaveHtml() +
      '</main>' +
      navHtml('record') +
      '</div>';

    actions.setType = function (el) {
      recState.type = el.getAttribute('data-type');
      if (recState.type !== 'absent') recState.offSchedule = false; // off-schedule is an absence-only option
      loadRosterAndDraw();
    };
    actions.setOffSchedule = function (el) {
      recState.offSchedule = !!el.checked;
      recState.absentee = '';        // the candidate list changes (roster vs everyone)
      recState.subMode = 'pending'; recState.teamSub = ''; recState.tempSub = '';
      if (recState.offSchedule && recState.deductMode !== 'absent') recState.deductMode = 'adhoc';
      refreshRecord();
    };
    actions.setDeductMode = function (el) { recState.deductMode = el.getAttribute('data-m'); refreshRecord(); };
    actions.setPayPeriodChoice = function (el) { recState.payPeriodChoice = el.getAttribute('data-c'); refreshRecord(); };
    actions.setDate = function (el) { recState.date = el.value; loadRosterAndDraw(); };
    actions.setDate2 = function (el) { recState.date2 = el.value; loadRosterAndDraw(); };
    actions.setAbsentee = function (el) { recState.absentee = el.getAttribute('data-id'); refreshRecord(); };
    actions.setPortion = function (el) { recState.portion = Number(el.getAttribute('data-p')); refreshRecord(); };
    actions.setSubMode = function (el) { recState.subMode = el.getAttribute('data-m'); refreshRecord(); };
    actions.setTeamSub = function (el) { recState.teamSub = el.getAttribute('data-id'); refreshRecord(); };
    actions.setPayMode = function (el) { recState.payMode = el.getAttribute('data-m'); refreshRecord(); };
    actions.setTempSub = function (el) { recState.tempSub = el.getAttribute('data-id'); refreshRecord(); };
    actions.setNewTempNick = function (el) { recState.newTempNick = el.value; };
    actions.setNewTempRate = function (el) { recState.newTempRate = el.value; };
    actions.setNewTempBank = function (el) { recState.newTempBank = el.value; };
    actions.setNewTempAcct = function (el) { recState.newTempAcct = el.value; };
    actions.setNewTempRegular = function (el) { recState.newTempRegular = el.checked; };
    actions.addTempPerson = function (el) {
      var nick = (recState.newTempNick || '').trim();
      if (!nick) { toast('กรุณาใส่ชื่อคนนอก'); return; }
      withSavingButton(el, function () { return write('addTemp', { nick: nick, rate: Number(recState.newTempRate) || 625, regular: !!recState.newTempRegular, bank: (recState.newTempBank || '').trim(), account_no: (recState.newTempAcct || '').replace(/[^0-9]/g, '') }).then(function (person) {
        recState.tempSub = person.id;
        recState.newTempNick = ''; recState.newTempRate = 625; recState.newTempRegular = true; recState.newTempBank = ''; recState.newTempAcct = '';
        refreshRecord();
      }); });
    };
    actions.setSwapA = function (el) { recState.swapA = el.getAttribute('data-id'); refreshRecord(); };
    actions.setSwapB = function (el) { recState.swapB = el.getAttribute('data-id'); refreshRecord(); };
    actions.setAdhocPerson = function (el) { recState.adhocPerson = el.getAttribute('data-id'); refreshRecord(); };
    actions.setNote = function (el) { recState.note = el.value; schedulePreview(); };
    actions.saveRecord = function (el) {
      var ev = buildEventPayload();
      withSavingButton(el, function () { return write('saveEvent', { event: ev }).then(function (res) {
        var stillAlert = (window.dayAlerts(ev.date, state.bundle) || []).length > 0;
        toast(stillAlert ? 'บันทึกแล้ว · วันนี้ยังมีเรื่องต้องจัดการ' : 'บันทึกแล้ว');
        showCalendarOn(ev.date);
        syncCalendarBg(res.event.event_id); // P8: Calendar is synced in the background, after the save
      }); });
    };
    if (recState.focusSub) {
      recState.focusSub = false;
      var subEl = document.getElementById('subSection');
      if (subEl && subEl.scrollIntoView) subEl.scrollIntoView({ block: 'start' });
    }
    actions.deleteRecord = function (el) {
      if (!window.confirm('ลบเหตุการณ์นี้ใช่หรือไม่')) return;
      var delId = recState.eventId, delDate = recState.date;
      withSavingButton(el, function () { return write('deleteEvent', { event_id: delId }).then(function () {
        toast('ลบแล้ว');
        showCalendarOn(delDate);
        syncCalendarBg(delId);
      }); });
    };
  }

  // ================= STATS =================
  var statsState = { grp: 'all', sort: 'sub' };
  var HEAT = { att: 'red', abs: 'red', emg: 'blu', sub: 'grn', adh: 'amb', swp: 'vio' };
  var COLS = ['sch', 'wrk', 'att', 'abs', 'emg', 'sub', 'adh', 'swp'];
  var COL_LABEL = { sch: 'เวร', wrk: 'มาจริง', att: '% มา', abs: 'ขาด', emg: 'ลา<br>ฉุกเฉิน', sub: 'เข้าแทน', adh: 'AdHoc', swp: 'สลับ' };

  function renderStats() {
    drawStats(localStats(state.ym)); // P8: computed locally, no request
  }

  function drawStats(stats) {
    var ym = state.ym;
    var list = stats.rows.filter(function (r) {
      if (statsState.grp === 'all') return true;
      return statsState.grp === 'D' ? r.group === 'director' : r.group === 'staff';
    });
    var maxes = {};
    COLS.forEach(function (k) {
      var vals = list.map(function (r) { return k === 'att' ? (100 - (r.att == null ? 100 : r.att)) : r[k]; });
      maxes[k] = vals.length ? Math.max.apply(null, vals) : 0;
    });
    function cellInfo(r, k) {
      var raw = k === 'att' ? (r.att == null ? null : 100 - r.att) : r[k];
      var displayVal = k === 'att' ? (r.att == null ? '–' : r.att + '%') : (r[k] === 0 ? '–' : numFmt(r[k]));
      if (!HEAT[k]) return { t: displayVal, cls: 'tc n0' };
      if (raw == null || raw <= 0) return { t: (k === 'att' ? displayVal : '–'), cls: 'tc z' };
      var lvl = Math.max(1, Math.ceil(raw / (maxes[k] || 1) * 4));
      return { t: displayVal, cls: 'tc ' + HEAT[k] + '-' + lvl };
    }
    var sorted = list.slice().sort(function (a, b) {
      var d = statsState.sort === 'att' ? (a.att == null ? 0 : a.att) - (b.att == null ? 0 : b.att) : (b[statsState.sort] - a[statsState.sort]);
      return d || a.nick.localeCompare(b.nick);
    });
    var headerCells = COLS.map(function (k) {
      var arrow = k === statsState.sort ? (k === 'att' ? '▲' : '▼') : '';
      return '<button type="button" class="th' + (k === statsState.sort ? ' th-on' : '') + '" data-act="sortCol" data-col="' + k + '">' + COL_LABEL[k] + '<span>' + arrow + '</span></button>';
    }).join('');
    var rowsHtml = sorted.map(function (r) {
      var cells = COLS.map(function (k) { var c = cellInfo(r, k); return '<div class="' + c.cls + '">' + c.t + '</div>'; }).join('');
      return '<div class="trow"><div class="tname"><span style="font-size:13px;font-weight:600">' + esc(r.nick) + '</span><span style="font-size:11px;color:#7A7064">' + (r.group === 'director' ? 'กรรมการ' : 'พนักงาน') + '</span></div>' + cells + '</div>';
    }).join('');
    var team = stats.team;
    var teamRowHtml = '<div class="trow" style="background:#F8F4EC;border-top:1px solid #DCD3C4"><div class="tname" style="background:#F8F4EC"><span style="font-size:13px;font-weight:600">รวมทีม</span><span style="font-size:11px;color:#7A7064">' + list.length + ' คน</span></div>' +
      '<div class="tc">' + team.sch + '</div><div class="tc">' + numFmt(team.wrk) + '</div><div class="tc">' + (team.att == null ? '–' : team.att + '%') + '</div><div class="tc">' + numFmt(team.abs) + '</div><div class="tc">' + numFmt(team.emg) + '</div><div class="tc">' + numFmt(team.sub) + '</div><div class="tc">' + numFmt(team.adh) + '</div><div class="tc">' + team.swp + '</div></div>';

    var top = stats.rows.slice().sort(function (a, b) { return (b.sub + b.adh) - (a.sub + a.adh); });
    var bestVal = top.length ? top[0].sub + top[0].adh : 0;
    var kpiHelpBest = bestVal > 0 ? top.filter(function (r) { return (r.sub + r.adh) === bestVal; }).map(function (r) { return r.nick; }).join(', ') : '—';

    var kpis = [
      { l: 'มาตามเวร (ทีม)', v: (team.att == null ? '–' : team.att + '%'), s: numFmt(team.sch - team.abs - team.emg) + ' จาก ' + team.sch + ' วันเวร' },
      { l: 'ขาด · ลาฉุกเฉิน', v: numFmt(team.abs) + ' · ' + numFmt(team.emg), s: 'หน่วยเป็นวัน' },
      { l: 'เข้าแทน + AdHoc', v: numFmt(team.sub + team.adh), s: 'ช่วยร้านมากสุด: ' + esc(kpiHelpBest) },
      { l: 'สลับวัน', v: String(team.swp / 2), s: 'คู่ · ไม่มีผลต่อเงิน' }
    ];
    var kpiHtml = kpis.map(function (k) { return '<div class="kpi"><div class="l">' + k.l + '</div><div class="v">' + k.v + '</div><div class="s">' + k.s + '</div></div>'; }).join('');
    var filters = [{ k: 'all', l: 'ทั้งหมด' }, { k: 'D', l: 'กรรมการ' }, { k: 'S', l: 'พนักงาน' }].map(function (f) {
      return '<button type="button" class="fchip' + (f.k === statsState.grp ? ' fchip-on' : '') + '" data-act="setGrp" data-grp="' + f.k + '">' + f.l + '</button>';
    }).join('');
    var tempsHtml = stats.temps.length ? stats.temps.map(function (t) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-top:1px solid #F0EAE0"><span style="font-size:13px;font-weight:600">' + esc(t.nick) + '</span><span style="font-size:12px;color:#3F382F">' + numFmt(t.days) + ' วัน · ' + esc(t.detail.join(', ')) + '</span></div>';
    }).join('') : '<div style="padding:10px 12px;font-size:12px;color:#7A7064">ไม่มี</div>';

    app.innerHTML =
      '<div class="shell">' +
      monthHeaderHtml('สถิติ', ym) +
      '<main class="app-main">' +
      '<div class="kpi-grid">' + kpiHtml + '</div>' +
      '<div style="display:flex;gap:8px;margin:14px 0 10px">' + filters + '</div>' +
      '<div class="stats-scroll"><div>' +
      '<div class="trow" style="border-top:none">' +
      '<div class="tname" style="font-size:11px;font-weight:600;color:#6B6257">ชื่อ</div>' + headerCells +
      '</div>' +
      rowsHtml + teamRowHtml +
      '</div></div>' +
      '<div class="legend" style="margin-top:10px"><span>อ่อน</span><span style="display:flex;gap:2px"><span class="swatch grn-1"></span><span class="swatch grn-2"></span><span class="swatch grn-3"></span><span class="swatch grn-4"></span></span><span>เข้ม = มากสุดในคอลัมน์ · แตะหัวคอลัมน์เพื่อเรียง</span></div>' +
      '<div class="card-plain" style="margin-top:16px;overflow:hidden">' +
      '<div style="padding:8px 12px;background:#F8F4EC;font-size:11px;font-weight:600;color:#6B6257">คนนอก (จ้างชั่วคราว) · ไม่นับรวมในตารางทีม</div>' +
      tempsHtml +
      '</div>' +
      '<div style="font-size:11px;color:#7A7064;margin-top:6px;line-height:1.6">% มา = วันที่มาตามเวรของตัวเอง ÷ วันตามตาราง (สีแดงยิ่งเข้ม = มาน้อยกว่าเวรมาก) · สลับวันไม่นับเป็นขาด · หน้านี้ไม่แสดงตัวเลขเงิน ดูได้ที่ "สรุปเงิน"</div>' +
      '</main>' +
      navHtml('stats') +
      '</div>';

    actions.prevMonth = function () { shiftMonth(-1); };
    actions.nextMonth = function () { shiftMonth(1); };
    actions.setGrp = function (el) { statsState.grp = el.getAttribute('data-grp'); drawStats(stats); };
    actions.sortCol = function (el) { statsState.sort = el.getAttribute('data-col'); drawStats(stats); };
  }

  // ================= PAYOUT =================
  function renderPayout() {
    drawPayout(localPayout(state.ym)); // P8: computed locally (tempPaid + closed come from the bundle)
  }

  function drawPayout(payout) {
    var ym = state.ym;
    var peopleHtml = payout.people.map(function (p) {
      var linesHtml = p.lines.map(function (l) { return '<div style="font-size:12px;color:#6B6257;margin-top:3px">' + esc(l) + '</div>'; }).join('');
      return '<div style="padding:10px 14px;border-top:1px solid #F0EAE0">' +
        '<div style="display:grid;grid-template-columns:minmax(0,1fr) 84px 84px;align-items:baseline">' +
        '<span style="font-size:14px;font-weight:600">' + esc(p.nick) + ' <span style="font-size:11px;font-weight:400;color:#7A7064">' + esc(p.id) + '</span></span>' +
        '<span class="' + (p.plus ? 'pos' : 'zero') + '" style="text-align:right;font-size:14px;font-weight:600">' + (p.plus ? '+' + money2(p.plus) : '–') + '</span>' +
        '<span class="' + (p.minus ? 'neg' : 'zero') + '" style="text-align:right;font-size:14px;font-weight:600">' + (p.minus ? '−' + money2(p.minus) : '–') + '</span>' +
        '</div>' + linesHtml + '</div>';
    }).join('');

    // P9 4.1: per-person temp card - bank details + copy button, one paid tick per day (owner only).
    var isOwner = state.role === 'owner';
    var tempsHtml = payout.temps.map(function (t) {
      var acct = String(t.account_no || '').replace(/[^0-9]/g, '');
      var bankHtml = (t.bank || acct)
        ? '<div style="margin-top:6px;font-size:12px;color:#6B6257">' + (t.bank ? 'ธนาคาร ' + esc(t.bank) : '') + '</div>' +
          (acct ? '<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span class="bank-box">' + esc(acct) + '</span>' +
            '<button type="button" class="btn-outline" style="height:36px;padding:0 12px" data-act="copyAcct" data-acct="' + esc(acct) + '">คัดลอกเลขบัญชี</button></div>' : '')
        : '<div style="margin-top:6px;font-size:12px;color:#9A4F0E">ยังไม่มีเลขบัญชี — Owner เพิ่มได้ในตั้งค่า</div>';
      var daysHtml = t.days.map(function (d) {
        var ctl;
        if (isOwner) {
          ctl = '<label class="checkbox-row" style="margin:0"><input type="checkbox" data-onchange="toggleTempDay" data-id="' + esc(d.event_id) + '" ' + (d.paid ? 'checked' : '') + '>จ่ายแล้ว</label>';
        } else {
          ctl = d.paid
            ? '<span class="pill p-sub">จ่ายแล้ว ✓ ' + esc(d.paid_by || '') + ' ' + esc(ddmm(d.paid_at)) + '</span>'
            : '<span class="pill p-base">ยังไม่จ่าย</span>';
        }
        return '<div class="temp-day"><div><div style="font-weight:500">' + esc(ddmm(d.date)) + ' · ' + esc(d.label) + '</div>' +
          '<div style="color:#6B6257">' + money2(d.amount) + (isOwner && d.paid ? ' · จ่ายโดย ' + esc(d.paid_by || '') + ' ' + esc(ddmm(d.paid_at)) : '') + '</div></div>' + ctl + '</div>';
      }).join('');
      return '<div style="padding:10px 14px;border-bottom:1px solid #F0EAE0">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:14px;font-weight:600">' + esc(t.nick) + ' <span style="font-size:11px;font-weight:400;color:#7A7064">คนนอก ★</span></span>' +
        '<span style="font-size:14px;font-weight:600">' + money2(t.amount) + '</span></div>' +
        bankHtml + '<div style="margin-top:6px">' + daysHtml + '</div></div>';
    }).join('');

    var statusPill = payout.closed ? '<span class="status-pill status-pill-closed">งวดปิดแล้ว</span>' : '<span class="status-pill">งวดยังเปิด</span>';

    app.innerHTML =
      '<div class="shell">' +
      '<header class="app-header"><div><div class="brand">CRAFTFITI · SHIFT LOG</div>' +
      '<div style="display:flex;align-items:center;gap:4px;margin-top:2px">' + monthArrowsHtml() + '<h1 style="font-size:24px">สรุปเงิน ' + esc(ymLabel(ym)) + '</h1></div></div>' +
      statusPill +
      '</header>' +
      '<main class="app-main">' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">' +
      '<div class="kpi"><div class="l">รายได้อื่นๆ รวม</div><div class="v pos">+' + money2(payout.totPlus) + '</div></div>' +
      '<div class="kpi"><div class="l">ขาดงาน (หัก) รวม</div><div class="v neg">−' + money2(payout.totMinus) + '</div></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin:16px 2px 8px">' +
      '<span style="font-size:12px;font-weight:600;color:#6B6257">กรรมการ + พนักงาน (เข้าสลิป)</span>' +
      '<span style="font-size:11px;color:#7A7064">' + payout.people.length + ' คนมีรายการ</span>' +
      '</div>' +
      (payout.carried > 0 ? '<div style="font-size:12px;color:#6B6257;margin:0 2px 8px">รวมรายการยกมาจากเดือนก่อน ' + payout.carried + ' รายการ</div>' : '') +
      '<div class="card-plain" style="overflow:hidden">' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) 84px 84px;padding:8px 14px;font-size:11px;font-weight:600;color:#6B6257;background:#F8F4EC"><span>ชื่อ · รหัส</span><span style="text-align:right">รายได้อื่นๆ</span><span style="text-align:right">ขาดงาน</span></div>' +
      peopleHtml +
      '</div>' +
      '<div style="margin:16px 2px 8px;font-size:12px;font-weight:600;color:#6B6257">จ้างชั่วคราว (ไม่อยู่ในไฟล์ export)</div>' +
      '<div class="card-plain" style="border-color:#17613B;overflow:hidden">' +
      tempsHtml +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#F2FAF5">' +
      '<div style="width:100%"><div style="display:flex;justify-content:space-between;font-size:13px;color:#17613B"><span>ต้องจ่ายทั้งหมด</span><span style="font-weight:600">' + money2(payout.tempTotal) + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;font-size:13px;color:#17613B;margin-top:2px"><span>จ่ายแล้ว</span><span style="font-weight:600">' + money2(payout.tempPaidTotal) + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;font-size:15px;color:#9B1C12;margin-top:2px"><span>ค้างจ่าย</span><span style="font-weight:600">' + money2(payout.tempUnpaidTotal) + '</span></div></div>' +
      '</div>' +
      '</div>' +
      '<div class="export-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:15px;font-weight:600">Export ไประบบเงินเดือน</div><div style="font-size:12px;color:#CFC5B5;margin-top:2px">' + esc(payout.filename) + ' · ' + payout.people.length + ' คน · จับคู่ด้วยรหัสพนักงาน</div></div></div>' +
      '<div class="csv-pre">' + esc(payout.csv) + '</div>' +
      '<button type="button" class="btn-secondary" style="background:#F4EFE6;color:#1F1A14;margin-top:10px" data-act="downloadCsv">ดาวน์โหลด CSV</button>' +
      '<div style="font-size:11px;color:#CFC5B5;margin-top:8px;line-height:1.6">ไปที่ Payroll Dashboard → "นำเข้า Shift Log" → เลือกไฟล์นี้ ระบบจะเติมช่อง รายได้อื่นๆ และ ขาดงาน ให้อัตโนมัติเมื่อเลือกพนักงาน</div>' +
      '</div>' +
      '</main>' +
      navHtml('payout') +
      '</div>';

    actions.prevMonth = function () { shiftMonth(-1); };
    actions.nextMonth = function () { shiftMonth(1); };
    actions.copyAcct = function (el) {
      copyText(el.getAttribute('data-acct') || '', function () { toast('คัดลอกแล้ว'); });
    };
    // owner-only; allowed even when the pay period is closed (cash paid outside payroll)
    actions.toggleTempDay = function (el) {
      var box = el;
      var want = !!box.checked;
      write('markTempDayPaid', { event_id: box.getAttribute('data-id'), paid: want }).then(function () {
        renderPayout();
      }).catch(function () { box.checked = !want; });
    };
    actions.downloadCsv = function () {
      var blob = new Blob([payout.csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = payout.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    };
  }

  // ================= SETTINGS =================
  var settingsState = {
    data: null, modal: '',
    addRate: { kind: 'normal', person_id: '', amount: '', effective_from: '', weekdays: [], replaces: '' },
    personForm: null, personIsNew: false,
    tplDraft: null, tplViewEff: '', pwWhich: 'staff', pw1: '', pw2: ''
  };

  // P8: the owner settings screen is built from the local bundle (no 'settings' request); every settings
  // write returns a fresh bundle, so re-rendering after a write is enough. (The 'settings' action stays on
  // the server for compatibility.)
  function renderSettings() {
    if (state.role !== 'owner') { drawSettingsStaff(); return; }
    // P5 §4.5: the Tuesday-slot section no longer lives here (moved to Calendar/Record).
    var b = state.bundle;
    settingsState.data = {
      people: b.people, rates: b.rates, templates: b.templates, periods: b.periods,
      appUsers: state.appUsers, tueAllowed: state.tueAllowed
    };
    drawSettingsOwner();
  }

  function drawSettingsStaff() {
    app.innerHTML =
      '<div class="shell">' + headerHtml('ตั้งค่า') +
      '<main class="app-main">' +
      '<div class="card">' +
      '<div style="font-size:14px;font-weight:600">ต้องใช้รหัส Owner</div>' +
      '<div class="form-row"><label for="ownerPw">รหัสผ่าน Owner</label><input id="ownerPw" type="password" data-oninput="setOwnerPw" value="' + esc(settingsState.ownerPwInput || '') + '"></div>' +
      (settingsState.ownerPwError ? '<div class="error-box">' + esc(settingsState.ownerPwError) + '</div>' : '') +
      '<button type="button" class="btn-primary" style="margin-top:12px" data-act="upgradeOwner">ปลดล็อก Owner</button>' +
      '</div>' +
      '<div class="sec">ระบบ</div>' +
      '<div class="card-plain"><button type="button" class="row-btn" data-act="logout"><span>ออกจากระบบ</span></button></div>' +
      '</main>' + navHtml('settings') +
      '</div>';
    actions.setOwnerPw = function (el) { settingsState.ownerPwInput = el.value; };
    actions.upgradeOwner = function () {
      api('login', { password: settingsState.ownerPwInput || '', who: state.who }).then(function (data) {
        if (data.role !== 'owner') {
          settingsState.ownerPwError = 'รหัสผ่านไม่ถูกต้อง';
          drawSettingsStaff();
          return;
        }
        state.token = data.token; state.role = data.role;
        lsSet('sl_token', state.token); lsSet('sl_role', state.role);
        settingsState.ownerPwInput = ''; settingsState.ownerPwError = '';
        renderSettings();
      }).catch(function () {
        settingsState.ownerPwError = 'รหัสผ่านไม่ถูกต้อง';
        drawSettingsStaff();
      });
    };
    actions.logout = doLogout;
  }

  function rateEffective(rates, kind, personId) {
    var today = state.today;
    var candidates = rates.filter(function (r) {
      if (r.kind !== kind) return false;
      if (r.effective_from > today) return false;
      if ((kind === 'normal' || kind === 'temp') && r.person_id !== personId) return false;
      return true;
    });
    if (!candidates.length) return null;
    return candidates.reduce(function (a, b) { return b.effective_from > a.effective_from ? b : a; });
  }

  // P5 §4.6: all currently-active `normal` rate variants for one person (generic + weekday + replaces rows),
  // each kept at its latest effective_from. Used to render the settings rate table conditions.
  function activeNormalVariants(rates, personId) {
    var today = state.today;
    var groups = {};
    (rates || []).forEach(function (r) {
      if (r.kind !== 'normal' || r.person_id !== personId || r.effective_from > today) return;
      var key = (r.weekdays || '') + '|' + (r.replaces || '');
      if (!groups[key] || r.effective_from > groups[key].effective_from) groups[key] = r;
    });
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) {
      return (a.weekdays || a.replaces ? 1 : 0) - (b.weekdays || b.replaces ? 1 : 0);
    });
  }

  function templateEffectiveRows(templates) {
    var today = state.today;
    var candidates = templates.filter(function (t) { return t.effective_from <= today; });
    if (!candidates.length) return [];
    var latestEff = candidates.reduce(function (a, b) { return b.effective_from > a ? b.effective_from : a; }, candidates[0].effective_from);
    return candidates.filter(function (t) { return t.effective_from === latestEff; }).sort(function (a, b) { return a.slot_order - b.slot_order; });
  }

  function tplWeekdayChips(rows, weekday) {
    return rows.filter(function (r) { return r.weekday === weekday; }).map(function (r) {
      if (r.kind === 'fixed') { var p = personById(r.person_id); return { l: p ? p.nick : r.person_id, cls: 'tchip' }; }
      if (r.kind === 'tue_slot') return { l: 'ช่องอังคาร', cls: 'tchip tchip-slot' };
      if (r.kind === 'alt') {
        var ids = (r.persons || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var names = ids.map(function (id) { var p2 = personById(id); return p2 ? p2.nick : id; });
        return { l: names.join('/') + ' เริ่ม ' + r.alt_anchor, cls: 'tchip tchip-alt' };
      }
      return { l: '?', cls: 'tchip' };
    });
  }

  var WD_CHIP_LABEL = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  function rateFormHtml(d) {
    var f = settingsState.addRate;
    var kindLabel = { absent_director: 'หักขาด กรรมการ', absent_staff: 'หักขาด พนักงาน', adhoc: 'AdHoc', temp_default: 'ค่าแรงคนนอกเริ่มต้น', normal: 'เรทปกติ (รายคน)', temp: 'ค่าแรงคนนอก (รายคน)' };
    var kindOpts = ['absent_director', 'absent_staff', 'adhoc', 'temp_default', 'normal', 'temp'].map(function (k) {
      return '<option value="' + k + '"' + (f.kind === k ? ' selected' : '') + '>' + kindLabel[k] + '</option>';
    }).join('');
    var personRow = '';
    if (f.kind === 'normal' || f.kind === 'temp') {
      var list = f.kind === 'normal' ? d.people.filter(function (p) { return p.group === 'staff'; }) : d.people.filter(function (p) { return p.group === 'temp'; });
      var opts = '<option value="">— เลือกคน —</option>' + list.map(function (p) { return '<option value="' + p.id + '"' + (f.person_id === p.id ? ' selected' : '') + '>' + esc(p.nick) + '</option>'; }).join('');
      personRow = '<div class="form-row"><label for="ratePerson">คน</label><select id="ratePerson" data-onchange="setRatePerson">' + opts + '</select></div>';
    }
    var conditionRow = '';
    if (f.kind === 'normal') {
      // P5 §4.6: optional per-weekday / per-replaced-person conditions for `normal` rate rows.
      var wdChips = [1, 2, 3, 4, 5, 6, 0].map(function (wd) {
        var on = (f.weekdays || []).indexOf(wd) !== -1;
        return '<button type="button" class="opt' + (on ? ' opt-on' : '') + '" data-act="toggleRateWeekday" data-wd="' + wd + '">' + WD_CHIP_LABEL[wd] + '</button>';
      }).join('');
      var replOpts = '<option value="">— ทุกคน —</option>' + d.people.filter(function (p) { return p.group === 'director' || p.group === 'staff'; }).map(function (p) {
        return '<option value="' + p.id + '"' + (f.replaces === p.id ? ' selected' : '') + '>' + esc(p.nick) + '</option>';
      }).join('');
      conditionRow = '<div class="form-row"><label>วัน (ไม่บังคับ ว่าง = ทุกวัน)</label><div class="opt-row">' + wdChips + '</div></div>' +
        '<div class="form-row"><label for="rateReplaces">เมื่อแทน (ไม่บังคับ)</label><select id="rateReplaces" data-onchange="setRateReplaces">' + replOpts + '</select></div>';
    }
    return '<div class="form-row"><label for="rateKind">ประเภทเรท</label><select id="rateKind" data-onchange="setRateKind">' + kindOpts + '</select></div>' +
      personRow + conditionRow +
      '<div class="form-row"><label for="rateAmt">จำนวนเงิน</label><input id="rateAmt" type="number" data-oninput="setRateAmt" value="' + esc(f.amount) + '"></div>' +
      '<div class="form-row"><label for="rateEff">มีผลตั้งแต่วันที่</label><input id="rateEff" type="date" data-oninput="setRateEff" value="' + esc(f.effective_from) + '"></div>' +
      '<button type="button" class="btn-primary" style="margin-top:12px" data-act="submitRate">เพิ่มเรทใหม่</button>';
  }

  // Human label for a rate row's condition, e.g. "700 · อ,พ" or "700 · แทน <ชื่อ>" (P5 §4.6).
  function rateConditionLabel(r) {
    var parts = [];
    if (r.weekdays) {
      var wds = String(r.weekdays).split(',').map(function (s) { return Number(s.trim()); });
      parts.push(wds.map(function (w) { return WD_CHIP_LABEL[w]; }).join(','));
    }
    if (r.replaces) parts.push('แทน ' + esc(nickOf(r.replaces)));
    return parts.length ? (' · ' + parts.join(' · ')) : '';
  }

  function drawSettingsOwner() {
    var d = settingsState.data;
    var todayRates = {};
    ['absent_director', 'absent_staff', 'adhoc', 'temp_default'].forEach(function (k) {
      var r = rateEffective(d.rates, k, '');
      todayRates[k] = r ? r.amount : null;
    });
    var groupLabel = { director: 'กรรมการ', staff: 'พนักงาน', temp: 'คนนอก' };
    var peopleRows = ['director', 'staff', 'temp'].map(function (g) {
      return d.people.filter(function (p) { return p.group === g; }).map(function (p) {
        var variants = g === 'staff' ? activeNormalVariants(d.rates, p.id) : [];
        var tempRate = g === 'temp' ? rateEffective(d.rates, 'temp', p.id) : null;
        var rateTxt = g === 'director' ? '–' : (g === 'staff'
          ? (variants.length ? variants.map(function (v) { return v.amount + rateConditionLabel(v); }).join(' / ') : '–')
          : (tempRate ? String(tempRate.amount) : '–'));
        var dedTxt = g === 'temp' ? '–' : (g === 'director' ? (todayRates.absent_director == null ? '–' : todayRates.absent_director) : (todayRates.absent_staff == null ? '–' : todayRates.absent_staff));
        return '<button type="button" class="row-btn" data-act="editPerson" data-id="' + esc(p.id) + '" style="display:grid;grid-template-columns:minmax(0,1fr) 70px 96px 64px;align-items:center">' +
          '<span style="font-size:14px;font-weight:500;text-align:left">' + esc(p.nick) + ' <span style="font-size:11px;color:#7A7064">' + esc(p.id) + (p.active ? '' : ' · ปิดใช้งาน') + '</span></span>' +
          '<span><span class="g g-' + (g === 'director' ? 'D' : g === 'staff' ? 'S' : 'T') + '">' + groupLabel[g] + '</span></span>' +
          '<span style="text-align:right;font-size:12px">' + rateTxt + '</span>' +
          '<span style="text-align:right;font-size:14px">' + dedTxt + '</span>' +
          '</button>';
      }).join('');
    }).join('');

    var peopleSection =
      '<div class="sec">คนและเรทรายวัน</div>' +
      '<div class="card-plain">' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) 70px 64px 64px;padding:8px 14px;font-size:11px;font-weight:600;color:#6B6257;background:#F8F4EC"><span>ชื่อ</span><span>กลุ่ม</span><span style="text-align:right">เรทปกติ</span><span style="text-align:right">หักเมื่อขาด</span></div>' +
      peopleRows +
      '<button type="button" class="row-btn" data-act="newPerson" style="color:#9A4F0E;justify-content:center;font-weight:600">+ เพิ่มคน</button>' +
      '</div>';

    var rateHistory = ['absent_director', 'absent_staff', 'adhoc', 'temp_default'].map(function (k) {
      var label = { absent_director: 'หักขาด กรรมการ', absent_staff: 'หักขาด พนักงาน', adhoc: 'AdHoc', temp_default: 'ค่าแรงคนนอกเริ่มต้น' }[k];
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-top:1px solid #F0EAE0"><span style="font-size:14px">' + label + '</span><span style="font-size:14px;font-weight:600">' + (todayRates[k] != null ? todayRates[k] : '–') + '</span></div>';
    }).join('');
    var rateSection =
      '<div class="sec">เรทกลาง</div><div class="card-plain">' + rateHistory + '</div>' +
      '<div class="sec">เพิ่มเรทใหม่</div><div class="card">' + rateFormHtml(d) + '</div>';

    // P5 §4.7: ALL template sets, with badges ใช้อยู่ / อนาคต / ในอดีต. The "จัดช่องอังคาร" section that used
    // to live here has moved to Calendar/Record (§4.5).
    var effRows = templateEffectiveRows(d.templates);
    var currentEff = effRows.length ? effRows[0].effective_from : null;
    var setsByEff = {};
    (d.templates || []).forEach(function (t) { (setsByEff[t.effective_from] = setsByEff[t.effective_from] || []).push(t); });
    var allEffs = Object.keys(setsByEff).sort().reverse();
    var tplListHtml = allEffs.map(function (eff) {
      var badge = eff === currentEff ? { l: 'ใช้อยู่', cls: 'p-sub' } : (eff > state.today ? { l: 'อนาคต', cls: 'p-adh' } : { l: 'ในอดีต', cls: 'p-base' });
      var isFuture = eff > state.today;
      var isOnly = allEffs.length <= 1;
      var open = settingsState.tplViewEff === eff;
      var weekdaysHtml = '';
      if (open) {
        weekdaysHtml = [1, 2, 3, 4, 5, 6, 0].map(function (wd) {
          var chips = tplWeekdayChips(setsByEff[eff], wd).map(function (c) { return '<span class="' + c.cls + '">' + esc(c.l) + '</span>'; }).join('');
          return '<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0"><span style="width:48px;flex-shrink:0;font-size:12px;font-weight:600">' + WD_LABEL_SHORT[wd] + '</span><div style="display:flex;flex-wrap:wrap;gap:4px">' + (chips || '<span style="font-size:11px;color:#7A7064">—</span>') + '</div></div>';
        }).join('');
      }
      return '<div style="border-top:1px solid #F0EAE0">' +
        '<button type="button" class="row-btn" data-act="viewTplSet" data-eff="' + eff + '"><span style="font-size:14px;font-weight:500">มีผลตั้งแต่ ' + esc(eff) + '</span><span class="pill ' + badge.cls + '">' + badge.l + '</span></button>' +
        (open ? '<div style="padding:0 14px 10px">' + weekdaysHtml + (isFuture && !isOnly ? '<button type="button" class="btn-outline" style="margin-top:6px;color:#9B1C12;border-color:#F2AEA3" data-act="deleteTemplateSet" data-eff="' + eff + '">ลบแม่แบบชุดนี้</button>' : '') + '</div>' : '') +
        '</div>';
    }).join('');
    var tplSection =
      '<div class="sec">แม่แบบเวร</div><div class="card-plain">' + tplListHtml +
      '<button type="button" class="row-btn" data-act="openTplEditor" style="color:#9A4F0E;justify-content:center;font-weight:600;border-top:1px solid #F0EAE0">+ สร้างแม่แบบใหม่</button></div>';

    var openMonths = [];
    var baseYm = state.today.slice(0, 7);
    for (var i = 0; i < 3; i++) {
      var y = Number(baseYm.slice(0, 4)), m = Number(baseYm.slice(5, 7)) - i;
      while (m < 1) { m += 12; y--; }
      var ym2 = y + '-' + pad2(m);
      var isC = d.periods.some(function (p) { return p.period === ym2 && p.status === 'closed'; });
      if (!isC) openMonths.push(ym2);
    }
    var closedList = d.periods.filter(function (p) { return p.status === 'closed'; }).slice().sort().reverse();
    var closeHtml = openMonths.map(function (ym3) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-top:1px solid #F0EAE0"><span style="font-size:14px">' + esc(ymLabel(ym3)) + ' <span style="font-size:12px;color:#744400">เปิดอยู่</span></span><button type="button" class="btn-outline" data-act="closePeriod" data-ym="' + ym3 + '">ปิดงวด</button></div>';
    }).join('') + closedList.map(function (p) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-top:1px solid #F0EAE0"><span style="font-size:14px">' + esc(ymLabel(p.period)) + '</span><span style="font-size:12px;color:#4A4238">ปิดแล้ว · แก้ไม่ได้</span></div>';
    }).join('');
    var closeSection = '<div class="sec">ปิดงวด</div><div class="card-plain">' + closeHtml + '</div>';

    var systemSection =
      '<div class="sec">ระบบ</div><div class="card-plain">' +
      '<button type="button" class="row-btn" data-act="openPwForm" data-which="staff"><span>เปลี่ยนรหัส Staff</span><span style="color:#7A7064">&rsaquo;</span></button>' +
      '<button type="button" class="row-btn" data-act="openPwForm" data-which="owner"><span>เปลี่ยนรหัส Owner</span><span style="color:#7A7064">&rsaquo;</span></button>' +
      '<button type="button" class="row-btn" data-act="resyncCalendar"><span>ซิงก์ Calendar ใหม่</span><span style="color:#7A7064">&rsaquo;</span></button>' +
      '<button type="button" class="row-btn" data-act="logout"><span>ออกจากระบบ</span></button>' +
      '</div>';

    app.innerHTML =
      '<div class="shell">' + headerHtml('ตั้งค่า') +
      '<main class="app-main">' +
      '<div class="owner-banner"><div style="flex-grow:1"><div style="font-size:14px;font-weight:600">โหมด Owner</div><div style="font-size:12px;color:#CFC5B5">ปลดล็อกด้วยรหัส Owner</div></div></div>' +
      peopleSection + rateSection + tplSection + closeSection + systemSection +
      '</main>' + navHtml('settings') +
      (settingsState.modal || '') +
      '</div>';

    bindSettingsActions(d);
  }

  function bindSettingsActions(d) {
    actions.stop = function () { /* no-op: absorbs clicks inside modal sheet */ };
    actions.closeModal = function () { settingsState.modal = ''; drawSettingsOwner(); };
    actions.closeModalBg = function () { settingsState.modal = ''; drawSettingsOwner(); };
    actions.editPerson = function (el) { openPersonModal(d, el.getAttribute('data-id')); };
    actions.newPerson = function () { openPersonModal(d, null); };
    actions.setPersonField = function (el) {
      var field = el.getAttribute('data-field');
      settingsState.personForm[field] = el.value;
      if (field === 'group') { settingsState.modal = personModalHtml(); drawSettingsOwner(); }
    };
    actions.setPersonCheck = function (el) { settingsState.personForm[el.getAttribute('data-field')] = el.checked; };
    actions.savePersonForm = function (el) {
      var f = settingsState.personForm;
      if (!f.nick) { toast('กรุณาใส่ชื่อเล่น'); return; }
      var payload = { nick: f.nick, group: f.group, code: f.code, active: f.active, regular: f.regular };
      if (f.group === 'temp') { payload.bank = (f.bank || '').trim(); payload.account_no = (f.account_no || '').replace(/[^0-9]/g, ''); }
      if (f.id) payload.id = f.id;
      withSavingButton(el, function () { return write('savePerson', payload).then(function () {
        toast('บันทึกแล้ว');
        settingsState.modal = '';
        renderSettings();
      }); });
    };
    actions.setRateKind = function (el) { settingsState.addRate.kind = el.value; settingsState.addRate.person_id = ''; drawSettingsOwner(); };
    actions.setRatePerson = function (el) { settingsState.addRate.person_id = el.value; };
    actions.setRateAmt = function (el) { settingsState.addRate.amount = el.value; };
    actions.setRateEff = function (el) { settingsState.addRate.effective_from = el.value; };
    actions.toggleRateWeekday = function (el) {
      var wd = Number(el.getAttribute('data-wd'));
      var f = settingsState.addRate;
      f.weekdays = f.weekdays || [];
      var idx = f.weekdays.indexOf(wd);
      if (idx === -1) f.weekdays.push(wd); else f.weekdays.splice(idx, 1);
      drawSettingsOwner();
    };
    actions.setRateReplaces = function (el) { settingsState.addRate.replaces = el.value; };
    actions.submitRate = function (el) {
      var f = settingsState.addRate;
      if (!f.amount || !f.effective_from) { toast('กรุณากรอกจำนวนเงินและวันที่มีผล'); return; }
      withSavingButton(el, function () { return write('addRate', {
        kind: f.kind, person_id: f.person_id || '', amount: Number(f.amount), effective_from: f.effective_from,
        weekdays: (f.weekdays || []).join(','), replaces: f.replaces || ''
      }).then(function () {
        toast('เพิ่มเรทแล้ว');
        settingsState.addRate = { kind: 'normal', person_id: '', amount: '', effective_from: '', weekdays: [], replaces: '' };
        renderSettings();
      }); });
    };
    actions.openTplEditor = function () { openTemplateEditor(d); };
    actions.toggleTplPerson = function (el) {
      var wd = Number(el.getAttribute('data-wd')), id = el.getAttribute('data-id');
      var draft = settingsState.tplDraft;
      if (el.checked) {
        var already = draft.rows.some(function (r) { return r.weekday === wd && r.kind === 'fixed' && r.person_id === id; });
        if (!already) {
          var maxOrder = draft.rows.filter(function (r) { return r.weekday === wd; }).reduce(function (a, r) { return Math.max(a, r.slot_order); }, -1);
          draft.rows.push({ weekday: wd, slot_order: maxOrder + 1, kind: 'fixed', person_id: id, persons: '', alt_anchor: '' });
        }
      } else {
        draft.rows = draft.rows.filter(function (r) { return !(r.weekday === wd && r.kind === 'fixed' && r.person_id === id); });
      }
    };
    actions.setTplEff = function (el) { settingsState.tplDraft.effective_from = el.value; };
    actions.toggleTplTue = function (el) {
      var wd = Number(el.getAttribute('data-wd'));
      var draft = settingsState.tplDraft;
      if (el.checked) {
        var already = draft.rows.some(function (r) { return r.weekday === wd && r.kind === 'tue_slot'; });
        if (!already) {
          var maxOrder = draft.rows.filter(function (r) { return r.weekday === wd; }).reduce(function (a, r) { return Math.max(a, r.slot_order); }, -1);
          draft.rows.push({ weekday: wd, slot_order: maxOrder + 1, kind: 'tue_slot', person_id: '', persons: '', alt_anchor: '' });
        }
      } else {
        draft.rows = draft.rows.filter(function (r) { return !(r.weekday === wd && r.kind === 'tue_slot'); });
      }
      settingsState.modal = templateModalHtml(d);
      drawSettingsOwner();
    };
    actions.toggleTplAlt = function (el) {
      var wd = Number(el.getAttribute('data-wd'));
      var draft = settingsState.tplDraft;
      if (el.checked) {
        var already = draft.rows.some(function (r) { return r.weekday === wd && r.kind === 'alt'; });
        if (!already) {
          var maxOrder = draft.rows.filter(function (r) { return r.weekday === wd; }).reduce(function (a, r) { return Math.max(a, r.slot_order); }, -1);
          draft.rows.push({ weekday: wd, slot_order: maxOrder + 1, kind: 'alt', person_id: '', persons: '', alt_anchor: '' });
        }
      } else {
        draft.rows = draft.rows.filter(function (r) { return !(r.weekday === wd && r.kind === 'alt'); });
      }
      settingsState.modal = templateModalHtml(d);
      drawSettingsOwner();
    };
    actions.setTplAltPersons = function (el) {
      var wd = Number(el.getAttribute('data-wd'));
      var row = settingsState.tplDraft.rows.find(function (r) { return r.weekday === wd && r.kind === 'alt'; });
      if (row) row.persons = el.value;
    };
    actions.setTplAltAnchor = function (el) {
      var wd = Number(el.getAttribute('data-wd'));
      var row = settingsState.tplDraft.rows.find(function (r) { return r.weekday === wd && r.kind === 'alt'; });
      if (row) row.alt_anchor = el.value;
    };
    actions.saveTemplateForm = function () {
      var draft = settingsState.tplDraft;
      if (!draft.effective_from) { toast('กรุณาเลือกวันมีผล'); return; }
      write('saveTemplate', {
        effective_from: draft.effective_from,
        rows: draft.rows.map(function (r, idx) { return { weekday: r.weekday, slot_order: idx, kind: r.kind, person_id: r.person_id || '', persons: r.persons || '', alt_anchor: r.alt_anchor || '' }; })
      }).then(function () {
        toast('บันทึกแม่แบบแล้ว');
        settingsState.modal = '';
        renderSettings();
      });
    };
    actions.deleteTemplateSet = function (el) {
      var eff = el.getAttribute('data-eff');
      if (!window.confirm('ลบแม่แบบที่มีผลตั้งแต่ ' + eff + ' ใช่หรือไม่')) return;
      withSavingButton(el, function () { return write('deleteTemplateSet', { effective_from: eff }).then(function () {
        toast('ลบแม่แบบแล้ว');
        renderSettings();
      }); });
    };
    actions.viewTplSet = function (el) { settingsState.tplViewEff = (settingsState.tplViewEff === el.getAttribute('data-eff')) ? '' : el.getAttribute('data-eff'); drawSettingsOwner(); };
    actions.closePeriod = function (el) {
      var ym2 = el.getAttribute('data-ym');
      if (!window.confirm('ปิดงวด ' + ym2 + ' แล้วจะแก้ไม่ได้อีก')) return;
      withSavingButton(el, function () { return write('closePeriod', { ym: ym2 }).then(function () { toast('ปิดงวดแล้ว'); renderSettings(); }); });
    };
    actions.openPwForm = function (el) { openPasswordModal(el.getAttribute('data-which')); };
    actions.setPw1 = function (el) { settingsState.pw1 = el.value; };
    actions.setPw2 = function (el) { settingsState.pw2 = el.value; };
    actions.submitPwChange = function (el) {
      if ((settingsState.pw1 || '').length < 4) { toast('รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร'); return; }
      if (settingsState.pw1 !== settingsState.pw2) { toast('รหัสผ่านไม่ตรงกัน'); return; }
      withSavingButton(el, function () { return api('changePassword', { which: settingsState.pwWhich, newPassword: settingsState.pw1 }).then(function () {
        toast('เปลี่ยนรหัสแล้ว');
        settingsState.modal = '';
        if (settingsState.pwWhich === state.role) doLogout();
        else renderSettings();
      }); });
    };
    actions.resyncCalendar = function (el) {
      withSavingButton(el, function () { return api('resyncCalendar', {}).then(function (res) { toast('ซิงก์แล้ว: สำเร็จ ' + res.synced + ' · ล้มเหลว ' + res.failed); refreshBundle(false); }); });
    };
    actions.logout = doLogout;
  }

  function openPersonModal(d, id) {
    var existing = id ? d.people.find(function (p) { return p.id === id; }) : null;
    settingsState.personForm = existing ? {
      id: existing.id, nick: existing.nick, group: existing.group, code: existing.code, active: existing.active, regular: existing.regular,
      bank: existing.bank || '', account_no: existing.account_no || ''
    } : { id: '', nick: '', group: 'staff', code: '', active: true, regular: false, bank: '', account_no: '' };
    settingsState.personIsNew = !existing;
    settingsState.modal = personModalHtml();
    drawSettingsOwner();
  }
  function personModalHtml() {
    var f = settingsState.personForm;
    var groupOpts = ['director', 'staff', 'temp'].map(function (g) {
      var label = { director: 'กรรมการ', staff: 'พนักงาน', temp: 'คนนอก' }[g];
      return '<option value="' + g + '"' + (f.group === g ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    return '<div class="modal-backdrop" data-act="closeModalBg"><div class="modal-sheet" data-act="stop">' +
      '<div style="font-size:16px;font-weight:600">' + (settingsState.personIsNew ? 'เพิ่มคน' : 'แก้ไข ' + esc(f.nick)) + '</div>' +
      (settingsState.personIsNew ? '<div class="form-row"><label for="pId">รหัส (4 หลัก ถ้าเป็นกรรมการ/พนักงาน)</label><input id="pId" data-oninput="setPersonField" data-field="id" value="' + esc(f.id) + '"></div>' : '') +
      '<div class="form-row"><label for="pNick">ชื่อเล่น</label><input id="pNick" data-oninput="setPersonField" data-field="nick" value="' + esc(f.nick) + '"></div>' +
      '<div class="form-row"><label for="pGroup">กลุ่ม</label><select id="pGroup" data-onchange="setPersonField" data-field="group">' + groupOpts + '</select></div>' +
      '<div class="form-row"><label for="pCode">โค้ด (ตัวย่อในปฏิทิน)</label><input id="pCode" data-oninput="setPersonField" data-field="code" value="' + esc(f.code) + '"></div>' +
      (f.group === 'temp'
        ? '<div class="form-row"><label for="pBank">ธนาคาร</label><input id="pBank" data-oninput="setPersonField" data-field="bank" value="' + esc(f.bank) + '" placeholder="เช่น กสิกร"></div>' +
          '<div class="form-row"><label for="pAcct">เลขบัญชี</label><input id="pAcct" data-oninput="setPersonField" data-field="account_no" inputmode="numeric" autocomplete="off" value="' + esc(f.account_no) + '"></div>'
        : '') +
      '<label class="checkbox-row"><input type="checkbox" data-onchange="setPersonCheck" data-field="active" ' + (f.active ? 'checked' : '') + '>ใช้งานอยู่</label>' +
      '<label class="checkbox-row"><input type="checkbox" data-onchange="setPersonCheck" data-field="regular" ' + (f.regular ? 'checked' : '') + '>คนประจำ (ขึ้นในตัวเลือกด่วน)</label>' +
      '<button type="button" class="btn-primary" style="margin-top:14px" data-act="savePersonForm">บันทึก</button>' +
      '<button type="button" class="btn-outline" style="margin-top:8px;width:100%" data-act="closeModal">ยกเลิก</button>' +
      '</div></div>';
  }

  function firstDayOfNextMonth(ymd) {
    var y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)) + 1;
    if (m > 12) { m = 1; y++; }
    return y + '-' + pad2(m) + '-01';
  }

  // P5 §4.7: "สร้างแม่แบบใหม่" opens the editor prefilled from the latest set, effective_from defaulting
  // to the first day of next month. The editor also allows editing tue_slot presence and the alt slot
  // (persons list + anchor date) per weekday.
  function openTemplateEditor(d) {
    var effRows = templateEffectiveRows(d.templates);
    settingsState.tplDraft = {
      effective_from: firstDayOfNextMonth(state.today),
      rows: effRows.map(function (r) { return Object.assign({}, r); })
    };
    settingsState.modal = templateModalHtml(d);
    drawSettingsOwner();
  }
  function templateModalHtml(d) {
    var draft = settingsState.tplDraft;
    var people = d.people.filter(function (p) { return p.active && (p.group === 'director' || p.group === 'staff'); });
    var weekdaysHtml = [1, 2, 3, 4, 5, 6, 0].map(function (wd) {
      var rows = draft.rows.filter(function (r) { return r.weekday === wd; });
      var fixedIds = rows.filter(function (r) { return r.kind === 'fixed'; }).map(function (r) { return r.person_id; });
      var hasTue = rows.some(function (r) { return r.kind === 'tue_slot'; });
      var altRow = rows.find(function (r) { return r.kind === 'alt'; });
      var checks = people.map(function (p) {
        return '<label class="checkbox-row" style="margin-top:4px"><input type="checkbox" data-onchange="toggleTplPerson" data-wd="' + wd + '" data-id="' + p.id + '" ' + (fixedIds.indexOf(p.id) !== -1 ? 'checked' : '') + '>' + esc(p.nick) + '</label>';
      }).join('');
      return '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #F0EAE0"><div style="font-size:13px;font-weight:600">' + WD_LABEL_SHORT[wd] + '</div>' +
        checks +
        '<label class="checkbox-row" style="margin-top:8px"><input type="checkbox" data-onchange="toggleTplTue" data-wd="' + wd + '" ' + (hasTue ? 'checked' : '') + '>ช่องอังคาร (tue_slot)</label>' +
        '<label class="checkbox-row" style="margin-top:6px"><input type="checkbox" data-onchange="toggleTplAlt" data-wd="' + wd + '" ' + (altRow ? 'checked' : '') + '>ศุกร์เว้นศุกร์ (alt)</label>' +
        (altRow ? '<div style="display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:8px;margin-top:6px">' +
          '<input data-oninput="setTplAltPersons" data-wd="' + wd + '" placeholder="รหัสคน 4 หลัก คั่นด้วย ," value="' + esc(altRow.persons || '') + '" style="height:40px">' +
          '<input type="date" data-oninput="setTplAltAnchor" data-wd="' + wd + '" value="' + esc(altRow.alt_anchor || '') + '" style="height:40px">' +
          '</div>' : '') +
        '</div>';
    }).join('');
    return '<div class="modal-backdrop" data-act="closeModalBg"><div class="modal-sheet" data-act="stop">' +
      '<div style="font-size:16px;font-weight:600">สร้างแม่แบบเวรใหม่</div>' +
      '<div style="font-size:12px;color:#6B6257;margin-top:4px">ติ๊กเพื่อเพิ่ม/ลดคนใน slot คงที่ (fixed) ต่อวัน · แก้ไขช่องอังคาร (tue_slot) และศุกร์เว้นศุกร์ (alt) ได้เช่นกัน</div>' +
      '<div class="form-row"><label for="tplEff">มีผลตั้งแต่วันที่</label><input id="tplEff" type="date" data-oninput="setTplEff" value="' + esc(draft.effective_from) + '"></div>' +
      weekdaysHtml +
      '<button type="button" class="btn-primary" style="margin-top:14px" data-act="saveTemplateForm">บันทึกแม่แบบใหม่</button>' +
      '<button type="button" class="btn-outline" style="margin-top:8px;width:100%" data-act="closeModal">ยกเลิก</button>' +
      '</div></div>';
  }

  function openPasswordModal(which) {
    settingsState.pwWhich = which;
    settingsState.pw1 = ''; settingsState.pw2 = '';
    settingsState.modal = passwordModalHtml();
    drawSettingsOwner();
  }
  function passwordModalHtml() {
    return '<div class="modal-backdrop" data-act="closeModalBg"><div class="modal-sheet" data-act="stop">' +
      '<div style="font-size:16px;font-weight:600">เปลี่ยนรหัส ' + (settingsState.pwWhich === 'owner' ? 'Owner' : 'Staff') + '</div>' +
      '<div class="form-row"><label for="pw1">รหัสผ่านใหม่</label><input id="pw1" type="password" data-oninput="setPw1" value="' + esc(settingsState.pw1) + '"></div>' +
      '<div class="form-row"><label for="pw2">ยืนยันรหัสผ่านใหม่</label><input id="pw2" type="password" data-oninput="setPw2" value="' + esc(settingsState.pw2) + '"></div>' +
      '<button type="button" class="btn-primary" style="margin-top:14px" data-act="submitPwChange">บันทึก</button>' +
      '<button type="button" class="btn-outline" style="margin-top:8px;width:100%" data-act="closeModal">ยกเลิก</button>' +
      '</div></div>';
  }

  // ================= BOOT =================
  // P8: applies a bootstrap response (bundle + session info).
  function applyBootstrap(data) {
    state.role = data.role; state.who = data.who;
    state.today = data.today;
    if (data.appUsers && data.appUsers.length) { state.appUsers = data.appUsers; state.users = data.appUsers; lsSetJSON('sl_users', data.appUsers); }
    installBundle(data.bundle);
    persistBundle();
    lsSet('sl_role', state.role); lsSet('sl_who', state.who);
    state.refreshedAt = Date.now();
  }

  function showConnectError() {
    app.innerHTML = '<div class="shell"><main class="app-main"><div style="padding:60px 16px;text-align:center">' +
      '<div style="font-size:15px;font-weight:600">เชื่อมต่อไม่ได้</div>' +
      '<div style="font-size:13px;color:#7A7064;margin-top:6px">ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่</div>' +
      '<button type="button" class="btn-primary" style="margin-top:16px" data-act="retryBoot">ลองใหม่</button>' +
      '</div></main></div>';
    actions.retryBoot = function () { boot(); };
  }

  // Fetches the whole bundle. foreground=true (no local copy yet): loading bar + tap lock.
  // foreground=false: background refresh - only the small corner spinner; the screen is repainted when
  // it returns. A result that raced with a write (bundleVer changed) is dropped: the write's bundle is newer.
  function refreshBundle(foreground) {
    var ver = state.bundleVer;
    return api('bootstrap', {}, foreground ? {} : { silent: true, spin: true }).then(function (data) {
      if (ver !== state.bundleVer) return;
      applyBootstrap(data);
      if (foreground) route(); else repaintCurrent();
    }).catch(function () {
      if (!state.bundle && state.token) showConnectError();
    });
  }

  var logicLoadTried = false;
  function boot() {
    // Safety net for a stale cached index.html that predates logic.js: load it once, then start.
    if (typeof window.monthView !== 'function') {
      if (logicLoadTried) { showConnectError(); return; }
      logicLoadTried = true;
      var sc = document.createElement('script');
      sc.src = './logic.js';
      sc.onload = boot;
      sc.onerror = showConnectError;
      document.head.appendChild(sc);
      return;
    }
    // legacy P5 caches are superseded by sl_bundle
    lsDel('sl_last_month'); lsDel('sl_last_people');
    state.today = bkkToday();
    if (!state.ym) state.ym = state.today.slice(0, 7);

    if (!state.token) { route(); return; }

    // Instant start: paint from the persisted bundle, then refresh in the background.
    var cached = lsGetJSON('sl_bundle');
    if (cached && cached.people && cached.config) {
      installBundle(cached);
      route();
      refreshBundle(false);
    } else {
      route(); // skeleton
      refreshBundle(true);
    }
  }

  // Coming back to the app (tab focus / PWA resume): quietly refresh if the data is over a minute old.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.token && state.bundle && Date.now() - state.refreshedAt > 60000) {
      refreshBundle(false);
    }
  });

  if (location.search.indexOf('mock=1') === -1 && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
