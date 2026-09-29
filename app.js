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

  var state = {
    token: lsGet('sl_token') || '',
    role: lsGet('sl_role') || '',
    who: lsGet('sl_who') || '',
    users: lsGetJSON('sl_users') || cfg.APP_USERS,
    people: [],
    appUsers: cfg.APP_USERS,
    tueAllowed: [],
    today: '',
    ym: '',
    monthCache: {}
  };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = (s === undefined || s === null) ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- date / thai helpers (self-contained; Logic.js is NOT loaded in production) ----------
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
  function toast(msg) {
    if (toastEl) { toastEl.remove(); toastEl = null; }
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.textContent = msg;
    document.body.appendChild(toastEl);
    setTimeout(function () { if (toastEl) { toastEl.remove(); toastEl = null; } }, 3200);
  }
  // ---------- P5 §4.3: loading bar with % label + tap-lock overlay ----------
  // Several concurrent requests share one bar/overlay via a counter. Background prefetch (api(action, payload, {silent:true}))
  // never shows the bar or the overlay.
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
    lsDel('sl_token'); lsDel('sl_role'); lsDel('sl_who');
  }

  // ---------- API helper ----------
  // opts.silent = true -> background prefetch: no loading bar, no tap-lock overlay (P5 §4.2/§4.3).
  function api(action, payload, opts) {
    var silent = !!(opts && opts.silent);
    if (!silent) setLoading(true);
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
      if (!silent) setLoading(false);
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
      if (!silent) { setLoading(false); toast('เชื่อมต่อไม่ได้'); }
      throw networkErr;
    });
  }

  function getMonth(ym, opts) {
    if (state.monthCache[ym]) return Promise.resolve(state.monthCache[ym]);
    return api('month', { ym: ym }, opts).then(function (data) { state.monthCache[ym] = data; return data; });
  }
  function invalidateMonth(ym) { delete state.monthCache[ym]; }
  function invalidateAllMonths() { state.monthCache = {}; }

  // P5 §4.2: after rendering a month, silently prefetch the adjacent months in the background.
  function prefetchAdjacentMonths(ym) {
    function shiftYm(base, delta) {
      var y = Number(base.slice(0, 4)), m = Number(base.slice(5, 7)) + delta;
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      return y + '-' + pad2(m);
    }
    [shiftYm(ym, -1), shiftYm(ym, 1)].forEach(function (adjYm) {
      if (!state.monthCache[adjYm]) {
        getMonth(adjYm, { silent: true }).catch(function () { /* ignore prefetch failure */ });
      }
    });
  }

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
        boot();
      }).catch(function (err) {
        loginState.error = err.message || 'เข้าสู่ระบบไม่สำเร็จ';
        renderLogin();
      });
    };
  }

  // ================= CALENDAR =================
  var calState = { selectedByYm: {}, modalOpen: false, tueModalChoice: '', tueModalCurrent: '' };
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

  function renderCalendar(params) {
    // Only auto-open the day pop-up when navigated here with an explicit ?date= (e.g. right after
    // saving/deleting a record). Landing on the Calendar tab normally should not pop the sheet open.
    calState.modalOpen = !!(params && params.date);
    if (params && params.date) {
      var pym = params.date.slice(0, 7);
      state.ym = pym;
      calState.selectedByYm[pym] = params.date;
      if (calState.modalOpen) { calState.modalOpenedFor = null; lockBodyScroll(true); }
      else lockBodyScroll(false);
    } else {
      lockBodyScroll(false);
    }
    var ym = state.ym;
    app.innerHTML = shellSkeleton(ymLabel(ym), 'calendar');
    getMonth(ym).then(function (month) {
      var sel = calState.selectedByYm[ym];
      if (!sel) {
        sel = (ym === state.today.slice(0, 7)) ? state.today : (ym + '-01');
        calState.selectedByYm[ym] = sel;
      }
      drawCalendar(month, sel, ym);
      prefetchAdjacentMonths(ym);
      lsSetJSON('sl_last_month', { ym: ym, month: month });
    });
  }

  function drawCalendar(month, sel, ym) {
    var mode = getCalMode();
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
      var chips = rosterForCell.map(function (r) {
        var cls = 'chip st-' + r.status + (r.slot === 'tue' ? ' slot' : '');
        return '<span class="' + cls + '">' + esc(nickChip(r)) + '</span>';
      }).join('');
      var cls = 'cell' + (date === sel ? ' cell-sel' : '');
      cellsHtml += '<button type="button" class="' + cls + '" data-act="pickDay" data-date="' + date + '" aria-label="' + d + ' ' + esc(THAI_MONTH_FULL[Number(ym.slice(5, 7)) - 1]) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:0 1px">' +
        '<span style="font-size:12px;font-weight:600">' + d + '</span>' +
        (hasEv ? '<span style="width:7px;height:7px;border-radius:50%;background:#B8641A"></span>' : '') +
        '</div>' +
        '<div class="cell-chips">' + chips + '</div>' +
        '</button>';
    }
    var legend =
      '<div class="legend">' +
      '<span class="item"><span class="chip st-base">MOST</span>ตามเวร</span>' +
      '<span class="item"><span class="chip st-abs">MOST</span>ขาด</span>' +
      '<span class="item"><span class="chip st-sub">Dao</span>เข้าแทน</span>' +
      '<span class="item"><span class="chip st-adh">Tong</span>AdHoc</span>' +
      '<span class="item"><span class="chip st-swi">Bomb</span>สลับ</span>' +
      '<span class="item"><span class="chip st-emg">Dook</span>ลาฉุกเฉิน</span>' +
      '<span class="item"><span class="chip st-tmp">คนนอก</span>คนนอกเข้าแทน</span>' +
      '<span class="item"><span class="chip st-base slot">Ai</span>ช่องอังคาร</span>' +
      '</div>';

    var calmodeHtml = '<div class="calmode-row">' +
      '<button type="button" class="calmode-btn' + (mode === 'changed' ? ' calmode-on' : '') + '" data-act="setCalMode" data-mode="changed">เฉพาะที่เปลี่ยน</button>' +
      '<button type="button" class="calmode-btn' + (mode === 'all' ? ' calmode-on' : '') + '" data-act="setCalMode" data-mode="all">ทั้งหมด</button>' +
      '</div>';

    app.innerHTML =
      '<div class="shell">' +
      monthHeaderHtml('', ym) +
      '<main class="app-main">' +
      calmodeHtml +
      '<div class="cal-grid" style="padding-bottom:4px">' +
      '<div class="cal-dow">จ</div><div class="cal-dow">อ</div><div class="cal-dow">พ</div><div class="cal-dow">พฤ</div><div class="cal-dow">ศ</div><div class="cal-dow">ส</div><div class="cal-dow">อา</div>' +
      '</div>' +
      '<div class="cal-grid">' + cellsHtml + '</div>' +
      legend +
      '</main>' +
      navHtml('calendar') +
      (calState.modalOpen ? buildDayModal(month, sel, ym) : '') +
      '</div>';

    actions.stop = function () { /* no-op: absorbs clicks inside modal sheet */ };
    actions.setCalMode = function (el) { setCalMode(el.getAttribute('data-mode')); drawCalendar(month, sel, ym); };
    actions.pickDay = function (el) {
      calState.selectedByYm[ym] = el.getAttribute('data-date');
      calState.modalOpen = true;
      calState.modalOpenedFor = null; // force the Tuesday selector to re-init from server state
      lockBodyScroll(true);
      drawCalendar(month, calState.selectedByYm[ym], ym);
    };
    actions.prevMonth = function () { shiftMonth(-1); };
    actions.nextMonth = function () { shiftMonth(1); };
    actions.closeDayModal = function () { calState.modalOpen = false; lockBodyScroll(false); drawCalendar(month, sel, ym); };
    actions.addEvent = function () { navigate('#record?date=' + sel); };
    actions.editEvent = function (el) { navigate('#record?date=' + sel + '&event_id=' + encodeURIComponent(el.getAttribute('data-id'))); };
    actions.deleteEvent = function (el) {
      var id = el.getAttribute('data-id');
      if (!window.confirm('ลบเหตุการณ์นี้ใช่หรือไม่')) return;
      api('deleteEvent', { event_id: id }).then(function () {
        invalidateMonth(ym);
        toast('ลบแล้ว');
        renderCalendar({});
      });
    };
    actions.setTueModalChoice = function (el) { calState.tueModalChoice = el.value; };
    actions.saveTueModalSlot = function (el) {
      withSavingButton(el, function () { return api('setTueSlot', { date: sel, person_id: calState.tueModalChoice || '' }).then(function () {
        invalidateMonth(ym);
        toast('บันทึกช่องอังคารแล้ว');
        renderCalendar({});
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

  // P5 §4.1: bottom-sheet day pop-up — replaces the old inline day-detail card.
  // Reuses .modal-backdrop / .modal-sheet. Closes via ✕, backdrop tap, or Escape (handled in drawCalendar).
  function buildDayModal(month, sel, ym) {
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
      var label = STATUS_LABEL[r.status] || r.status;
      var cls = STATUS_PILLCLS[r.status] || 'pill p-base';
      return '<div class="detail-row"><div><span style="font-size:14px;font-weight:500">' + esc(name) + '</span> <span style="font-size:12px;color:#7A7064">' + esc(tags.join(' · ')) + '</span></div><span class="' + cls + '">' + esc(label) + '</span></div>';
    }).join('');

    var eventsHtml;
    if (day.events.length) {
      eventsHtml = day.events.map(function (e) {
        var tag = (e.type === 'absent' && e.portion === 0.5) ? 'ขาดครึ่งวัน' : TYPE_TAG[e.type];
        var moneyHtml = (e.money || []).map(function (line) {
          var cls = line.amount > 0 ? 'amt-pos' : (line.amount < 0 ? 'amt-neg' : 'amt-zero');
          var text = line.label + (line.bucket === 'temp' ? ' · จ่ายนอกสลิป' : '');
          return '<div class="event-money-line ' + cls + '">' + esc(text) + '</div>';
        }).join('');
        var meta = 'บันทึกโดย ' + esc(e.recorded_by) + ' · ' + esc(fmtDT(e.recorded_at));
        if (e.updated_by) meta += ' · แก้โดย ' + esc(e.updated_by);
        if (e.note) meta += ' · ' + esc(e.note);
        meta += ' · ' + (e.cal_status === 'ok' ? 'ส่งเข้า Calendar แล้ว' : '⚠️ ยังไม่เข้า Calendar');
        var editDelete = month.closed ? '' :
          '<div style="display:flex;gap:14px;margin-top:8px">' +
          '<button type="button" data-act="editEvent" data-id="' + esc(e.event_id) + '" style="font-size:12px;font-weight:600;color:#9A4F0E">แก้ไข</button>' +
          '<button type="button" data-act="deleteEvent" data-id="' + esc(e.event_id) + '" class="btn-danger" style="font-size:12px;font-weight:600">ลบ</button>' +
          '</div>';
        return '<div class="event-card">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="' + TYPE_PILLCLS[e.type] + '">' + esc(tag) + '</span><span style="font-size:14px;font-weight:500">' + esc(e.title) + '</span></div>' +
          moneyHtml +
          '<div class="event-meta">' + meta + '</div>' +
          editDelete +
          '</div>';
      }).join('');
    } else {
      eventsHtml = '<div style="font-size:13px;color:#7A7064;margin-top:6px">ไม่มีการเปลี่ยนแปลง เป็นไปตามตาราง</div>';
    }

    var addBtn = month.closed
      ? '<span class="pill" style="margin-top:12px;display:inline-flex;background:#FBE8C4;color:#744400">งวดปิดแล้ว</span>'
      : '<button type="button" class="btn-secondary" style="margin-top:12px" data-act="addEvent">+ เพิ่มเหตุการณ์วันนี้</button>';

    // P5 §4.5: on Tuesdays the popup also shows the Tuesday-slot selector inline (staff and owner alike).
    var tueHtml = '';
    if (wd === 2) {
      var slotEntry = day.roster.find(function (r) { return r.slot === 'tue'; });
      var curId = slotEntry && !slotEntry.unassigned ? slotEntry.id : '';
      calState.tueModalCurrent = curId;
      if (calState.modalOpenedFor !== sel) { calState.tueModalChoice = curId; calState.modalOpenedFor = sel; }
      var tueOpts = state.tueAllowed.map(function (id) { return personById(id); }).filter(Boolean);
      var tueOptsHtml = '<option value=""' + (calState.tueModalChoice === '' ? ' selected' : '') + '>ยังไม่จัด</option>' +
        tueOpts.map(function (p) { return '<option value="' + p.id + '"' + (calState.tueModalChoice === p.id ? ' selected' : '') + '>' + esc(p.nick) + '</option>'; }).join('');
      tueHtml = '<div class="tue-ctl">' +
        '<div style="font-size:13px;font-weight:600">ช่องอังคาร</div>' +
        '<select data-onchange="setTueModalChoice" style="width:100%;height:42px;margin-top:6px">' + tueOptsHtml + '</select>' +
        '<div style="font-size:11px;color:#6B6257;margin-top:6px">บันทึกว่าอังคารนี้ใครเข้าร้านตามรอบ (ไม่ใช่การขาดหรือ AdHoc · ไม่มีผลต่อเงิน)</div>' +
        '<button type="button" class="btn-outline" style="margin-top:8px;width:100%" data-act="saveTueModalSlot">บันทึกช่องอังคาร</button>' +
        '</div>';
    }

    return '<div class="modal-backdrop" data-act="closeDayModal">' +
      '<div class="modal-sheet" data-act="stop" style="position:relative">' +
      '<button type="button" class="day-modal-close" data-act="closeDayModal" aria-label="ปิด">✕</button>' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding-right:36px">' +
      '<div><div style="font-weight:600;font-size:18px">' + esc(title) + '</div></div>' +
      '<span class="pill p-base">' + working + ' คนเข้างาน</span>' +
      '</div>' +
      '<div style="margin-top:8px">' + rows + '</div>' +
      tueHtml +
      '<div style="font-size:12px;font-weight:600;color:#6B6257;margin-top:10px;letter-spacing:.3px">เหตุการณ์วันนี้</div>' +
      eventsHtml +
      addBtn +
      '</div></div>';
  }

  // ================= RECORD =================
  var recState = {};
  function resetRecState(prefillDate, editingEvent) {
    recState = {
      type: 'absent', date: prefillDate || state.today, date2: '',
      absentee: '', portion: 1, subMode: 'none', teamSub: '', payMode: 'normal',
      tempSub: '', newTempNick: '', newTempRate: 625, newTempRegular: true,
      adhocPerson: '', swapA: '', swapB: '', note: '', eventId: '', saved: false, savedCalNote: '',
      dayRoster: [], dayRoster2: [], tueChoice: '', tueCurrent: '',
      preview: { title: '', money: [], errors: [], warnings: [] }, previewTimer: null
    };
    if (editingEvent) {
      var e = editingEvent;
      recState.eventId = e.event_id;
      recState.type = e.type;
      recState.date = e.date;
      recState.date2 = e.date2 || '';
      recState.note = e.note || '';
      recState.portion = e.portion || 1;
      if (e.type === 'absent' || e.type === 'emergency') {
        recState.absentee = e.person_id;
        if (e.person2_id) {
          var subP = personById(e.person2_id);
          if (subP && subP.group === 'temp') { recState.subMode = 'outside'; recState.tempSub = e.person2_id; }
          else { recState.subMode = 'team'; recState.teamSub = e.person2_id; recState.payMode = e.sub_pay === 'adhoc' ? 'adhoc' : 'normal'; }
        }
      } else if (e.type === 'adhoc') {
        recState.adhocPerson = e.person_id;
      } else if (e.type === 'swap') {
        recState.swapA = e.person_id;
        recState.swapB = e.person2_id;
      }
    }
  }

  function findCachedEvent(id) {
    for (var ym in state.monthCache) {
      var month = state.monthCache[ym];
      for (var i = 0; i < month.days.length; i++) {
        var day = month.days[i];
        for (var j = 0; j < day.events.length; j++) {
          if (day.events[j].event_id === id) return day.events[j];
        }
      }
    }
    return null;
  }

  function renderRecord(params) {
    app.innerHTML = shellSkeleton('บันทึกเหตุการณ์', 'record');
    var prefDate = params.date || state.today;
    if (params.event_id) {
      var found = findCachedEvent(params.event_id);
      if (found) {
        resetRecState(found.date, found);
        loadRosterAndDraw();
      } else {
        getMonth(prefDate.slice(0, 7)).then(function (month) {
          var ev = null;
          month.days.forEach(function (day) { day.events.forEach(function (e) { if (e.event_id === params.event_id) ev = e; }); });
          resetRecState(ev ? ev.date : prefDate, ev);
          loadRosterAndDraw();
        });
      }
    } else {
      resetRecState(prefDate, null);
      if (params.type) recState.type = params.type;
      loadRosterAndDraw();
    }
  }

  function loadRosterAndDraw() {
    var ym = recState.date.slice(0, 7);
    getMonth(ym).then(function (month) {
      var day = month.days[Number(recState.date.slice(8, 10)) - 1];
      recState.dayRoster = day ? day.roster : [];
      if (recState.type === 'swap' && recState.date2) {
        getMonth(recState.date2.slice(0, 7)).then(function (month2) {
          var day2 = month2.days[Number(recState.date2.slice(8, 10)) - 1];
          recState.dayRoster2 = day2 ? day2.roster : [];
          drawRecord();
          schedulePreview();
        });
      } else if (recState.type === 'tue' && weekdayOf(recState.date) === 2) {
        api('tueSlots', { ym: ym }).then(function (rows) {
          var row = rows.find(function (r) { return r.date === recState.date; });
          recState.tueCurrent = row ? row.person_id : '';
          recState.tueChoice = recState.tueCurrent;
          drawRecord();
        });
      } else {
        drawRecord();
        schedulePreview();
      }
    });
  }

  function absenteeOptions(roster) {
    return roster.filter(function (r) { return r.id && ['base', 'swi', 'sub'].indexOf(r.status) !== -1; })
      .map(function (r) { return personById(r.id); }).filter(Boolean);
  }

  function recRequiredOk() {
    if (recState.type === 'absent' || recState.type === 'emergency') {
      if (!recState.absentee || !recState.date) return false;
      if (recState.subMode === 'outside' && !recState.tempSub) return false;
      if (recState.subMode === 'team' && !recState.teamSub) return false;
      return true;
    }
    if (recState.type === 'adhoc') return !!(recState.adhocPerson && recState.date);
    if (recState.type === 'swap') return !!(recState.swapA && recState.swapB && recState.date && recState.date2);
    return false;
  }

  function buildEventPayload() {
    var ev = {};
    if (recState.eventId) ev.event_id = recState.eventId;
    ev.type = recState.type;
    ev.date = recState.date;
    ev.note = recState.note || '';
    if (recState.type === 'absent' || recState.type === 'emergency') {
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

  function schedulePreview() {
    if (recState.previewTimer) clearTimeout(recState.previewTimer);
    recState.previewTimer = setTimeout(function () {
      if (!recRequiredOk()) {
        recState.preview = { title: '', money: [], errors: [], warnings: [] };
        updatePreviewDom();
        return;
      }
      api('preview', { event: buildEventPayload() }).then(function (res) {
        recState.preview = res;
        updatePreviewDom();
      }).catch(function () { /* toast already shown */ });
    }, 400);
  }

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
    var previewHtml = '<div class="card" style="margin-top:18px">' +
      '<div style="font-size:13px;font-weight:500">ชื่อใน Calendar: ' + esc(pv.title || '—') + '</div>' +
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

    // P5 §4.4: fixed tab order ขาดงาน, AdHoc, สลับวัน, ลาฉุกเฉิน, ช่องอังคาร (new, §4.5).
    var isTue = weekdayOf(recState.date) === 2;
    var typeHtml = '<div class="lbl" style="margin-top:6px">ประเภท</div><div class="seg seg-5">' +
      [{ k: 'absent', l: 'ขาดงาน' }, { k: 'adhoc', l: 'AdHoc' }, { k: 'swap', l: 'สลับวัน' }, { k: 'emergency', l: 'ลาฉุกเฉิน' }, { k: 'tue', l: 'ช่องอังคาร' }].map(function (t) {
        var disabled = t.k === 'tue' && !isTue;
        return '<button type="button" class="sg' + (t.k === recState.type ? ' sg-on' : '') + '" data-act="setType" data-type="' + t.k + '"' + (disabled ? ' disabled' : '') + '>' + t.l + '</button>';
      }).join('') + '</div>' +
      (recState.type === 'emergency' ? '<div style="font-size:12px;color:#6B6257;margin-top:4px">ลาแบบบริษัทยังจ่ายเงิน (ไม่หักเงิน)</div>' : '') +
      (recState.type === 'tue' && !isTue ? '<div style="font-size:12px;color:#6B6257;margin-top:4px">เลือกได้เฉพาะวันอังคาร</div>' : '');

    var absentHtml = '';
    if (recState.type === 'absent' || recState.type === 'emergency') {
      var absOpts = absenteeOptions(roster);
      var label = recState.type === 'emergency' ? 'ใครลาฉุกเฉิน' : 'ใครขาด';
      absentHtml += '<div class="lbl">' + label + '</div><div class="opt-row">' + absOpts.map(function (p) {
        return '<button type="button" class="opt' + (p.id === recState.absentee ? ' opt-on' : '') + '" data-act="setAbsentee" data-id="' + p.id + '">' + esc(p.nick) + '</button>';
      }).join('') + '</div>';

      absentHtml += '<div class="lbl">ระยะเวลา</div><div class="seg seg-2">' +
        '<button type="button" class="sg' + (recState.portion === 1 ? ' sg-on' : '') + '" data-act="setPortion" data-p="1">เต็มวัน</button>' +
        '<button type="button" class="sg' + (recState.portion === 0.5 ? ' sg-on' : '') + '" data-act="setPortion" data-p="0.5">ครึ่งวัน</button>' +
        '</div>';

      absentHtml += '<div class="lbl">คนเข้าแทน</div><div class="seg seg-3">' +
        '<button type="button" class="sg' + (recState.subMode === 'none' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="none">ไม่มี</button>' +
        '<button type="button" class="sg' + (recState.subMode === 'team' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="team">ทีมงาน</button>' +
        '<button type="button" class="sg' + (recState.subMode === 'outside' ? ' sg-on' : '') + '" data-act="setSubMode" data-m="outside">คนนอก</button>' +
        '</div>';

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
          '<label class="checkbox-row"><input type="checkbox" data-onchange="setNewTempRegular" ' + (recState.newTempRegular ? 'checked' : '') + '>เก็บไว้เป็นคนประจำ</label>' +
          '<button type="button" class="btn-outline" style="margin-top:10px" data-act="addTempPerson">+ เพิ่มคนนอก</button>' +
          '</div>';
      }
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

    // P5 §4.5: Tuesday-slot tab (moved from Settings). Editable by staff and owner alike (owner decision override).
    var tueHtml = '';
    if (recState.type === 'tue') {
      if (!isTue) {
        tueHtml = '<div class="tue-ctl tue-ctl-disabled"><div style="font-size:13px;color:#6B6257">เลือกได้เฉพาะวันอังคาร</div></div>';
      } else {
        var tueOpts = state.tueAllowed.map(function (id) { return personById(id); }).filter(Boolean);
        var tueOptsHtml = '<option value=""' + (recState.tueChoice === '' ? ' selected' : '') + '>ยังไม่จัด</option>' +
          tueOpts.map(function (p) { return '<option value="' + p.id + '"' + (recState.tueChoice === p.id ? ' selected' : '') + '>' + esc(p.nick) + '</option>'; }).join('');
        tueHtml = '<div class="tue-ctl">' +
          '<div style="font-size:13px;font-weight:600">อังคาร ' + esc(recState.date) + '</div>' +
          '<div style="font-size:12px;color:#6B6257;margin-top:2px">ปัจจุบัน: ' + esc(recState.tueCurrent ? nickOf(recState.tueCurrent) : 'ยังไม่จัด') + '</div>' +
          '<div class="form-row"><label for="tueSel">ใครเข้าร้านตามรอบ</label><select id="tueSel" data-onchange="setTueChoice">' + tueOptsHtml + '</select></div>' +
          '<div style="font-size:11px;color:#6B6257;margin-top:6px">บันทึกว่าอังคารนี้ใครเข้าร้านตามรอบ (ไม่ใช่การขาดหรือ AdHoc · ไม่มีผลต่อเงิน)</div>' +
          '<button type="button" class="btn-primary" style="margin-top:12px" data-act="saveTueSlot">บันทึกช่องอังคาร</button>' +
          '</div>';
      }
    }

    var noteHtml = '<label class="lbl" for="recNote">หมายเหตุ (ไม่บังคับ)</label><textarea id="recNote" rows="2" data-oninput="setNote" placeholder="แจ้งตอน 10 โมง ไม่สบาย" style="width:100%">' + esc(recState.note) + '</textarea>';

    app.innerHTML =
      '<div class="shell">' +
      '<header class="app-header"><div><div class="brand">CRAFTFITI · SHIFT LOG</div><h1>' + esc(title) + '</h1></div></header>' +
      '<main class="app-main">' +
      (recState.saved ? '<div class="saved-box">บันทึกแล้ว' + esc(recState.savedCalNote || '') + '</div>' : '') +
      '<label class="lbl" for="recDate" style="margin-top:0">วันที่</label>' +
      '<input type="date" id="recDate" data-oninput="setDate" value="' + esc(recState.date) + '" style="width:100%;height:48px">' +
      '<div style="font-size:12px;color:#6B6257;margin-top:6px">เวรวันนี้: ' + esc(rosterNames.join(' · ') || '—') + '</div>' +
      typeHtml + absentHtml + swapHtml + adhocHtml + tueHtml +
      (recState.type === 'tue' ? '' : noteHtml + previewSaveHtml()) +
      '</main>' +
      navHtml('record') +
      '</div>';

    actions.setType = function (el) {
      var t = el.getAttribute('data-type');
      if (t === 'tue' && weekdayOf(recState.date) !== 2) return; // ช่องอังคาร: Tuesday only
      recState.type = t;
      loadRosterAndDraw();
    };
    actions.setTueChoice = function (el) { recState.tueChoice = el.value; };
    actions.saveTueSlot = function (el) {
      withSavingButton(el, function () { return api('setTueSlot', { date: recState.date, person_id: recState.tueChoice || '' }).then(function () {
        invalidateMonth(recState.date.slice(0, 7));
        toast('บันทึกช่องอังคารแล้ว');
        navigate('#calendar?date=' + recState.date);
      }); });
    };
    actions.setDate = function (el) { recState.date = el.value; loadRosterAndDraw(); };
    actions.setDate2 = function (el) { recState.date2 = el.value; loadRosterAndDraw(); };
    actions.setAbsentee = function (el) { recState.absentee = el.getAttribute('data-id'); drawRecord(); schedulePreview(); };
    actions.setPortion = function (el) { recState.portion = Number(el.getAttribute('data-p')); drawRecord(); schedulePreview(); };
    actions.setSubMode = function (el) { recState.subMode = el.getAttribute('data-m'); drawRecord(); schedulePreview(); };
    actions.setTeamSub = function (el) { recState.teamSub = el.getAttribute('data-id'); drawRecord(); schedulePreview(); };
    actions.setPayMode = function (el) { recState.payMode = el.getAttribute('data-m'); drawRecord(); schedulePreview(); };
    actions.setTempSub = function (el) { recState.tempSub = el.getAttribute('data-id'); drawRecord(); schedulePreview(); };
    actions.setNewTempNick = function (el) { recState.newTempNick = el.value; };
    actions.setNewTempRate = function (el) { recState.newTempRate = el.value; };
    actions.setNewTempRegular = function (el) { recState.newTempRegular = el.checked; };
    actions.addTempPerson = function (el) {
      var nick = (recState.newTempNick || '').trim();
      if (!nick) { toast('กรุณาใส่ชื่อคนนอก'); return; }
      withSavingButton(el, function () { return api('addTemp', { nick: nick, rate: Number(recState.newTempRate) || 625, regular: !!recState.newTempRegular }).then(function (person) {
        return api('bootstrap', {}).then(function (data) { state.people = data.people; return person; });
      }).then(function (person) {
        recState.tempSub = person.id;
        recState.newTempNick = ''; recState.newTempRate = 625; recState.newTempRegular = true;
        drawRecord(); schedulePreview();
      }); });
    };
    actions.setSwapA = function (el) { recState.swapA = el.getAttribute('data-id'); drawRecord(); schedulePreview(); };
    actions.setSwapB = function (el) { recState.swapB = el.getAttribute('data-id'); drawRecord(); schedulePreview(); };
    actions.setAdhocPerson = function (el) { recState.adhocPerson = el.getAttribute('data-id'); drawRecord(); schedulePreview(); };
    actions.setNote = function (el) { recState.note = el.value; schedulePreview(); };
    actions.saveRecord = function (el) {
      var ev = buildEventPayload();
      withSavingButton(el, function () { return api('saveEvent', { event: ev }).then(function (res) {
        invalidateMonth(ev.date.slice(0, 7));
        if (ev.date2) invalidateMonth(ev.date2.slice(0, 7));
        calState.selectedByYm[ev.date.slice(0, 7)] = ev.date;
        toast('บันทึกแล้ว' + (res.cal_status === 'ok' ? '' : ' · Calendar ยังไม่ซิงก์'));
        navigate('#calendar?date=' + ev.date);
      }); });
    };
    actions.deleteRecord = function (el) {
      if (!window.confirm('ลบเหตุการณ์นี้ใช่หรือไม่')) return;
      withSavingButton(el, function () { return api('deleteEvent', { event_id: recState.eventId }).then(function () {
        invalidateMonth(recState.date.slice(0, 7));
        toast('ลบแล้ว');
        navigate('#calendar');
      }); });
    };
  }

  // ================= STATS =================
  var statsState = { grp: 'all', sort: 'sub' };
  var HEAT = { att: 'red', abs: 'red', emg: 'blu', sub: 'grn', adh: 'amb', swp: 'vio' };
  var COLS = ['sch', 'wrk', 'att', 'abs', 'emg', 'sub', 'adh', 'swp'];
  var COL_LABEL = { sch: 'เวร', wrk: 'มาจริง', att: '% มา', abs: 'ขาด', emg: 'ลา<br>ฉุกเฉิน', sub: 'เข้าแทน', adh: 'AdHoc', swp: 'สลับ' };

  function renderStats() {
    app.innerHTML = shellSkeleton('สถิติ', 'stats');
    api('stats', { ym: state.ym }).then(function (stats) { drawStats(stats); });
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
    app.innerHTML = shellSkeleton('สรุปเงิน', 'payout');
    api('payout', { ym: state.ym }).then(function (payout) { drawPayout(payout); });
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

    var tempsHtml = payout.temps.map(function (t) {
      var linesTxt = t.lines.map(function (l) { return esc(l); }).join(' · ');
      return '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:10px 14px;border-bottom:1px solid #F0EAE0">' +
        '<div><div style="font-size:14px;font-weight:600">' + esc(t.nick) + ' <span style="font-size:11px;font-weight:400;color:#7A7064">คนนอก ★</span></div><div style="font-size:12px;color:#6B6257;margin-top:2px">' + linesTxt + '</div></div>' +
        '<span style="font-size:14px;font-weight:600">' + money2(t.amount) + '</span></div>';
    }).join('');

    var paid = payout.tempPaid && payout.tempPaid.paid;
    var paidLabel = paid ? ('จ่ายแล้ว ✓ ' + esc(payout.tempPaid.marked_by || '')) : 'ทำเครื่องหมายว่าจ่ายแล้ว';
    var paidDisabled = payout.closed ? 'disabled' : '';
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
      '<div class="card-plain" style="overflow:hidden">' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) 84px 84px;padding:8px 14px;font-size:11px;font-weight:600;color:#6B6257;background:#F8F4EC"><span>ชื่อ · รหัส</span><span style="text-align:right">รายได้อื่นๆ</span><span style="text-align:right">ขาดงาน</span></div>' +
      peopleHtml +
      '</div>' +
      '<div style="margin:16px 2px 8px;font-size:12px;font-weight:600;color:#6B6257">จ้างชั่วคราว (ไม่อยู่ในไฟล์ export)</div>' +
      '<div class="card-plain" style="border-color:#17613B;overflow:hidden">' +
      tempsHtml +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#F2FAF5">' +
      '<div><div style="font-size:12px;color:#17613B">ต้องจ่ายคนนอกเดือนนี้ (เงินสด/โอน)</div><div style="font-size:20px;font-weight:600;color:#17613B">' + money2(payout.tempTotal) + '</div></div>' +
      '<button type="button" class="paid' + (paid ? ' paid-on' : '') + '" data-act="togglePaid" ' + paidDisabled + '>' + paidLabel + '</button>' +
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
    actions.togglePaid = function (el) {
      if (payout.closed) return;
      withSavingButton(el, function () { return api('markTempPaid', { ym: ym, paid: !paid }).then(function () { renderPayout(); }); });
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

  function renderSettings() {
    app.innerHTML = shellSkeleton('ตั้งค่า', 'settings');
    if (state.role !== 'owner') { drawSettingsStaff(); return; }
    // P5 §4.5: the Tuesday-slot section no longer lives here (moved to Calendar/Record).
    api('settings', {}).then(function (data) {
      settingsState.data = data;
      settingsState.modal = '';
      drawSettingsOwner();
    });
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

  // Human label for a rate row's condition, e.g. "700 · อ,พ" or "700 · แทน MOST" (P5 §4.6).
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
      if (f.id) payload.id = f.id;
      withSavingButton(el, function () { return api('savePerson', payload).then(function () {
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
      withSavingButton(el, function () { return api('addRate', {
        kind: f.kind, person_id: f.person_id || '', amount: Number(f.amount), effective_from: f.effective_from,
        weekdays: (f.weekdays || []).join(','), replaces: f.replaces || ''
      }).then(function () {
        invalidateAllMonths();
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
      api('saveTemplate', {
        effective_from: draft.effective_from,
        rows: draft.rows.map(function (r, idx) { return { weekday: r.weekday, slot_order: idx, kind: r.kind, person_id: r.person_id || '', persons: r.persons || '', alt_anchor: r.alt_anchor || '' }; })
      }).then(function () {
        invalidateAllMonths();
        toast('บันทึกแม่แบบแล้ว');
        settingsState.modal = '';
        renderSettings();
      });
    };
    actions.deleteTemplateSet = function (el) {
      var eff = el.getAttribute('data-eff');
      if (!window.confirm('ลบแม่แบบที่มีผลตั้งแต่ ' + eff + ' ใช่หรือไม่')) return;
      withSavingButton(el, function () { return api('deleteTemplateSet', { effective_from: eff }).then(function () {
        invalidateAllMonths();
        toast('ลบแม่แบบแล้ว');
        renderSettings();
      }); });
    };
    actions.viewTplSet = function (el) { settingsState.tplViewEff = (settingsState.tplViewEff === el.getAttribute('data-eff')) ? '' : el.getAttribute('data-eff'); drawSettingsOwner(); };
    actions.closePeriod = function (el) {
      var ym2 = el.getAttribute('data-ym');
      if (!window.confirm('ปิดงวด ' + ym2 + ' แล้วจะแก้ไม่ได้อีก')) return;
      withSavingButton(el, function () { return api('closePeriod', { ym: ym2 }).then(function () { invalidateMonth(ym2); toast('ปิดงวดแล้ว'); renderSettings(); }); });
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
      withSavingButton(el, function () { return api('resyncCalendar', {}).then(function (res) { toast('ซิงก์แล้ว: สำเร็จ ' + res.synced + ' · ล้มเหลว ' + res.failed); }); });
    };
    actions.logout = doLogout;
  }

  function openPersonModal(d, id) {
    var existing = id ? d.people.find(function (p) { return p.id === id; }) : null;
    settingsState.personForm = existing ? {
      id: existing.id, nick: existing.nick, group: existing.group, code: existing.code, active: existing.active, regular: existing.regular
    } : { id: '', nick: '', group: 'staff', code: '', active: true, regular: false };
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
          '<input data-oninput="setTplAltPersons" data-wd="' + wd + '" placeholder="รหัสคน คั่นด้วย , เช่น 0003,0010" value="' + esc(altRow.persons || '') + '" style="height:40px">' +
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
  function boot() {
    // P5 §4.2: if a previous month view is cached in localStorage, paint it immediately (using the
    // last-known people list too, so nicks resolve) before the network round-trip completes.
    var lastMonth = lsGetJSON('sl_last_month'); // { ym, month }
    var lastPeople = lsGetJSON('sl_last_people');
    var lastToday = lsGet('sl_last_today');
    if (lastMonth && lastMonth.ym && lastMonth.month) {
      state.ym = lastMonth.ym;
      state.monthCache[lastMonth.ym] = lastMonth.month;
    }
    if (lastPeople) state.people = lastPeople;
    if (lastToday) state.today = lastToday;

    if (state.token) {
      if (lastMonth && state.people.length) route(); // instant paint from cache
      api('bootstrap', { ym: state.ym || undefined }).then(function (data) {
        state.role = data.role; state.who = data.who;
        state.people = data.people; state.appUsers = data.appUsers;
        state.tueAllowed = data.tueAllowed; state.today = data.today;
        if (!state.ym) state.ym = state.today.slice(0, 7);
        state.users = data.appUsers;
        lsSetJSON('sl_users', state.appUsers);
        lsSetJSON('sl_last_people', data.people);
        lsSet('sl_last_today', data.today);
        lsSet('sl_role', state.role); lsSet('sl_who', state.who);
        if (data.month) {
          state.monthCache[data.month.ym] = data.month;
          lsSetJSON('sl_last_month', { ym: data.month.ym, month: data.month });
        }
        route();
      }).catch(function () { route(); });
    } else {
      route();
    }
  }

  if (location.search.indexOf('mock=1') === -1 && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
