// Logic.js — PURE business logic for Craftfiti Shift Log.
// No SpreadsheetApp / CalendarApp / any GAS service calls in this file.
// Must run identically in Node (tests) and inside Apps Script.

var MONTH_SHORT_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
var MINUS_SIGN = '−'; // U+2212 minus sign used in money labels

// ---------- generic helpers ----------

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function fmt2(x) {
  return round2(x).toFixed(2);
}

function parseYmd(date) {
  var parts = date.split('-');
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
}

function daysInMonth(ym) {
  var parts = ym.split('-');
  var y = Number(parts[0]), m = Number(parts[1]);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weekdayOf(date) {
  var p = parseYmd(date);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

function daysBetween(dateA, dateB) {
  var a = parseYmd(dateA), b = parseYmd(dateB);
  var ua = Date.UTC(a.y, a.m - 1, a.d);
  var ub = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((ub - ua) / 86400000);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function datesOfMonth(ym) {
  var parts = ym.split('-');
  var y = Number(parts[0]), m = Number(parts[1]);
  var n = daysInMonth(ym);
  var out = [];
  for (var d = 1; d <= n; d++) {
    out.push(ym + '-' + pad2(d));
  }
  return out;
}

function thaiShortDate(date) {
  var p = parseYmd(date);
  return p.d + ' ' + MONTH_SHORT_TH[p.m - 1];
}

function isClosed(date, periods) {
  var ym = date.slice(0, 7);
  return (periods || []).some(function (p) { return p.period === ym && p.status === 'closed'; });
}

function latestClosedEnd(periods) {
  var closed = (periods || []).filter(function (p) { return p.status === 'closed'; });
  if (!closed.length) return null;
  var latest = closed.reduce(function (a, b) { return b.period > a.period ? b : a; });
  var last = daysInMonth(latest.period);
  return latest.period + '-' + pad2(last);
}

// ---------- pay periods (P6: pay period carry-over) ----------

function isClosedYm(ym, periods) {
  return (periods || []).some(function (p) { return p.period === ym && p.status === 'closed'; });
}

function nextMonthStr(ym) {
  var parts = ym.split('-');
  var y = Number(parts[0]), m = Number(parts[1]) + 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + pad2(m);
}

function monthShortYear(ym) {
  var parts = ym.split('-');
  return MONTH_SHORT_TH[Number(parts[1]) - 1] + ' ' + parts[0];
}

// `event.pay_period` is optional (blank/legacy = date's month).
function payPeriodOf(event) {
  return (event && event.pay_period) || (event && event.date ? event.date.slice(0, 7) : '');
}

// ym if it is open, else the next month after it that is not closed.
function firstOpenPeriodFrom(ym, periods) {
  var cur = ym;
  var guard = 0;
  while (isClosedYm(cur, periods) && guard < 1200) {
    cur = nextMonthStr(cur);
    guard++;
  }
  return cur;
}

// Decides which pay period an event's money belongs to (owner decision, P6 §1).
function resolvePayPeriod(event, data) {
  var periods = data.periods;
  var eventMonth = event.date.slice(0, 7);
  if (event.type === 'swap') {
    return firstOpenPeriodFrom(eventMonth, periods);
  }
  if (isClosedYm(eventMonth, periods)) {
    return firstOpenPeriodFrom(eventMonth, periods);
  }
  if (event.pay_period) {
    var nextM = nextMonthStr(eventMonth);
    if ((event.pay_period === eventMonth || event.pay_period === nextM) && !isClosedYm(event.pay_period, periods)) {
      return event.pay_period;
    }
    throw new Error('งวดคิดเงินต้องเป็นเดือนเดียวกันหรือเดือนถัดไป');
  }
  return eventMonth;
}

function personById(id, data) {
  return (data.people || []).find(function (p) { return p.id === id; }) || null;
}

function nickOf(id, data) {
  var p = personById(id, data);
  return p ? p.nick : id;
}

// ---------- rates ----------

var PERSON_SCOPED_KINDS = { normal: true, temp: true };

function rateRowScore_(r) {
  var s = 0;
  if (r.replaces) s += 2;
  if (r.weekdays) s += 1;
  return s;
}

// opts = { replaces: personId } (optional) — used to pick the correct `normal` rate
// when personId is substituting for a specific absentee.
function rateOn(kind, personId, date, rates, opts) {
  opts = opts || {};
  var wd = weekdayOf(date);
  var candidates = (rates || []).filter(function (r) {
    if (r.kind !== kind) return false;
    if (r.effective_from > date) return false;
    if (PERSON_SCOPED_KINDS[kind] && r.person_id !== personId) return false;
    if (r.weekdays) {
      var wds = String(r.weekdays).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (wds.indexOf(String(wd)) === -1) return false;
    }
    if (r.replaces) {
      if (!opts.replaces || r.replaces !== opts.replaces) return false;
    }
    return true;
  });
  if (!candidates.length) {
    throw new Error('ไม่พบเรท ' + kind + ' ' + (personId || ''));
  }
  var best = candidates.reduce(function (a, b) {
    var sa = rateRowScore_(a), sb = rateRowScore_(b);
    if (sa !== sb) return sb > sa ? b : a;
    return b.effective_from > a.effective_from ? b : a;
  });
  return best.amount;
}

function absentRateKind(group) {
  return group === 'director' ? 'absent_director' : 'absent_staff';
}

// ---------- templates / roster ----------

function templateFor(date, templates) {
  var candidates = (templates || []).filter(function (t) { return t.effective_from <= date; });
  if (!candidates.length) return [];
  var latestEff = candidates.reduce(function (a, b) { return b.effective_from > a ? b.effective_from : a; }, candidates[0].effective_from);
  return candidates
    .filter(function (t) { return t.effective_from === latestEff; })
    .slice()
    .sort(function (a, b) { return a.slot_order - b.slot_order; });
}

function baseRoster(date, data) {
  var weekday = weekdayOf(date);
  var rows = templateFor(date, data.templates).filter(function (r) { return r.weekday === weekday; });
  var out = [];
  rows.forEach(function (r) {
    if (r.kind === 'fixed') {
      out.push({ id: r.person_id, slot: 'fixed' });
    } else if (r.kind === 'tue_slot') {
      var slot = (data.tueSlots || []).find(function (s) { return s.date === date; });
      if (slot && slot.person_id) {
        out.push({ id: slot.person_id, slot: 'tue' });
      } else {
        out.push({ id: '', slot: 'tue', unassigned: true });
      }
    } else if (r.kind === 'alt') {
      var persons = (r.persons || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var n = persons.length;
      if (n) {
        var diff = daysBetween(r.alt_anchor, date);
        var idx = (((Math.floor(diff / 7)) % n) + n) % n;
        out.push({ id: persons[idx], slot: 'alt' });
      }
    }
  });
  return out;
}

function eventsTouching(date, events) {
  return (events || []).filter(function (e) { return e.date === date || e.date2 === date; });
}

function dayRoster(date, data) {
  var weekday = weekdayOf(date);
  var roster = baseRoster(date, data).map(function (r) {
    var e = { id: r.id, status: 'base' };
    if (r.slot) e.slot = r.slot;
    if (r.unassigned) e.unassigned = true;
    return e;
  });
  var events = eventsTouching(date, data.events);

  function findEntry(id) {
    return roster.find(function (r) { return r.id === id; });
  }

  events.forEach(function (e) {
    if (e.type === 'absent' || e.type === 'emergency') {
      if (e.date === date) {
        var absEntry = findEntry(e.person_id);
        var status = e.type === 'emergency' ? 'emg' : (e.portion === 0.5 ? 'hab' : 'abs');
        if (absEntry) {
          absEntry.status = status;
        } else {
          var newEntry = { id: e.person_id, status: status };
          if (e.off_schedule) newEntry.off_schedule = true; // P8: not counted as scheduled
          roster.push(newEntry);
        }
        if (e.person2_id) {
          var subP = personById(e.person2_id, data);
          var subGroup = subP ? subP.group : '';
          roster.push({ id: e.person2_id, status: subGroup === 'temp' ? 'tmp' : 'sub' });
        }
      }
    } else if (e.type === 'adhoc') {
      if (e.date === date) {
        roster.push({ id: e.person_id, status: 'adh' });
      }
    } else if (e.type === 'swap') {
      if (e.date === date) {
        var aEntry = findEntry(e.person_id);
        if (aEntry) aEntry.status = 'swo'; else roster.push({ id: e.person_id, status: 'swo' });
        roster.push({ id: e.person2_id, status: 'swi' });
      }
      if (e.date2 === date) {
        var bEntry = findEntry(e.person2_id);
        if (bEntry) bEntry.status = 'swo'; else roster.push({ id: e.person2_id, status: 'swo' });
        roster.push({ id: e.person_id, status: 'swi' });
      }
    }
  });

  return { date: date, weekday: weekday, roster: roster, events: events };
}

// ---------- money ----------

function eventMoney(event, data) {
  if (event.type === 'swap') return [];
  var portion = event.portion || 1;
  var half = portion === 0.5 ? ' ครึ่งวัน' : '';
  var d = thaiShortDate(event.date);

  if (event.type === 'adhoc') {
    var amt = round2(rateOn('adhoc', null, event.date, data.rates) * portion);
    return [{
      person_id: event.person_id,
      amount: amt,
      bucket: 'slip',
      label: d + ' AdHoc' + half + ' +' + fmt2(amt)
    }];
  }

  // absent / emergency
  var absentee = personById(event.person_id, data);
  var out = [];
  var typeLabel = event.type === 'emergency' ? 'ลาฉุกเฉิน' : 'ขาด';

  if (event.type === 'emergency') {
    out.push({
      person_id: event.person_id,
      amount: 0,
      bucket: 'slip',
      label: d + ' ' + typeLabel + half + ' · ไม่หัก'
    });
  } else if (event.off_schedule) {
    // P8 §4.4: off-schedule absence — deduct at the AdHoc rate (default) or the normal absent rate.
    var offAdhoc = event.deduct_mode !== 'absent';
    var offAmt = round2((offAdhoc
      ? rateOn('adhoc', null, event.date, data.rates)
      : rateOn(absentRateKind(absentee.group), absentee.id, event.date, data.rates)) * portion);
    out.push({
      person_id: event.person_id,
      amount: -offAmt,
      bucket: 'slip',
      label: d + ' ขาดนอกตาราง' + half + (offAdhoc ? ' (หักเท่าเรท AdHoc) ' : ' (หักเท่าเรทขาด) ') + MINUS_SIGN + fmt2(offAmt)
    });
  } else {
    var absAmt = round2(rateOn(absentRateKind(absentee.group), absentee.id, event.date, data.rates) * portion);
    out.push({
      person_id: event.person_id,
      amount: -absAmt,
      bucket: 'slip',
      label: d + ' ' + typeLabel + half + ' ' + MINUS_SIGN + fmt2(absAmt)
    });
  }

  if (event.person2_id) {
    var sub = personById(event.person2_id, data);
    var subNick = sub ? sub.nick : event.person2_id;
    if (sub && sub.group === 'director') {
      var subAmt = round2(rateOn('adhoc', null, event.date, data.rates) * portion);
      out.push({
        person_id: event.person2_id,
        amount: subAmt,
        bucket: 'slip',
        label: d + ' เข้าแทน ' + absentee.nick + half + ' (AdHoc) +' + fmt2(subAmt)
      });
    } else if (sub && sub.group === 'staff') {
      var payMode = event.sub_pay === 'adhoc' ? 'adhoc' : 'normal';
      var sAmt = payMode === 'adhoc'
        ? round2(rateOn('adhoc', null, event.date, data.rates) * portion)
        : round2(rateOn('normal', sub.id, event.date, data.rates, { replaces: event.person_id }) * portion);
      var tag = payMode === 'adhoc' ? '(AdHoc)' : '(เรทปกติ)';
      out.push({
        person_id: event.person2_id,
        amount: sAmt,
        bucket: 'slip',
        label: d + ' เข้าแทน ' + absentee.nick + half + ' ' + tag + ' +' + fmt2(sAmt)
      });
    } else if (sub && sub.group === 'temp') {
      var tAmt = round2(rateOn('temp', sub.id, event.date, data.rates) * portion);
      out.push({
        person_id: event.person2_id,
        amount: tAmt,
        bucket: 'temp',
        label: d + ' เข้าแทน ' + absentee.nick + half + ' (คนนอก) +' + fmt2(tAmt)
      });
    }
  }

  return out;
}

// P7 §4.1.1: Tuesday-slot pay. slot = {date, person_id}. director -> adhoc rate; staff -> normal
// rate (weekday-aware via rateOn). No person -> no line.
function tueSlotMoney(slot, data) {
  if (!slot || !slot.person_id) return [];
  var p = personById(slot.person_id, data);
  if (!p) return [];
  var d = thaiShortDate(slot.date);
  var amt, tag;
  if (p.group === 'director') {
    amt = round2(rateOn('adhoc', null, slot.date, data.rates));
    tag = '(AdHoc)';
  } else {
    amt = round2(rateOn('normal', p.id, slot.date, data.rates, {}));
    tag = '(เรทปกติ)';
  }
  return [{
    person_id: p.id,
    amount: amt,
    bucket: 'slip',
    label: d + ' ช่องอังคาร ' + tag + ' +' + fmt2(amt)
  }];
}

// P7 §4.1.4: the monthly Tuesday planner — one row per Tuesday of ym, with the pay options for
// each allowed id (in the order given by `tueAllowed`, which the server passes already ordered).
function tuePlan(ym, data, tueAllowed) {
  var closed = isClosedYm(ym, data.periods);
  var dates = datesOfMonth(ym).filter(function (d) { return weekdayOf(d) === 2; });
  var days = dates.map(function (d) {
    var slot = (data.tueSlots || []).find(function (s) { return s.date === d; });
    var personId = slot ? slot.person_id : '';
    var options = (tueAllowed || []).map(function (id) {
      var p = personById(id, data);
      var nick = p ? p.nick : id;
      var lines = tueSlotMoney({ date: d, person_id: id }, data);
      return {
        person_id: id,
        nick: nick,
        amount: lines.length ? lines[0].amount : 0,
        label: lines.length ? lines[0].label : ''
      };
    });
    return { date: d, person_id: personId, options: options };
  });
  return { ym: ym, closed: closed, days: days };
}

function effectivePay(event, data) {
  if (event.type === 'adhoc') return 'adhoc';
  if (event.type === 'swap') return '';
  if (!event.person2_id) return '';
  var sub = personById(event.person2_id, data);
  if (!sub) return '';
  if (sub.group === 'director') return 'adhoc';
  if (sub.group === 'temp') return 'temp';
  return event.sub_pay === 'adhoc' ? 'adhoc' : 'normal';
}

// ---------- calendar titles ----------

function calendarTitle(event, data) {
  var half = event.portion === 0.5 ? ' (ครึ่งวัน)' : '';

  if (event.type === 'swap') {
    var aNick = nickOf(event.person_id, data);
    var bNick = nickOf(event.person2_id, data);
    return '[สลับ] ' + aNick + ' ⇄ ' + bNick + ' (' + bNick + ' ' + thaiShortDate(event.date) +
      ' · ' + aNick + ' ' + thaiShortDate(event.date2) + ')';
  }

  if (event.type === 'adhoc') {
    return '[AdHoc] ' + nickOf(event.person_id, data) + ' มาช่วยร้าน' + half;
  }

  var prefix = event.type === 'emergency' ? '[ลาฉุกเฉิน]' : '[ขาด]';
  var absentNick = nickOf(event.person_id, data);

  if (event.off_schedule) {
    return prefix + ' ' + absentNick + ' นอกตาราง' + half;
  }

  if (!event.person2_id) {
    if (event.cover === 'pending') return prefix + ' ' + absentNick + ' รอหาคนแทน' + half;
    return prefix + ' ' + absentNick + ' ไม่มีคนแทน' + half;
  }

  var sub = personById(event.person2_id, data);
  var subNick = sub ? sub.nick : event.person2_id;
  var pay = effectivePay(event, data);

  if (sub && sub.group === 'temp') {
    return prefix + ' ' + absentNick + ' → ' + subNick + ' (คนนอก) เข้าแทน' + half;
  }
  if (pay === 'adhoc') {
    return prefix + ' ' + absentNick + ' → ' + subNick + ' เข้าแทน (AdHoc)' + half;
  }
  return prefix + ' ' + absentNick + ' → ' + subNick + ' เข้าแทน' + half;
}

// ---------- validation ----------

function isScheduledBase(id, roster) {
  return roster.some(function (r) { return r.id === id && r.status === 'base'; });
}

function cloneDataWithoutEvent(data, editingId) {
  if (!editingId) return data;
  var events = data.events.filter(function (e) { return e.event_id !== editingId; });
  var clone = {};
  for (var k in data) clone[k] = data[k];
  clone.events = events;
  return clone;
}

// Shared pay-period checks for absent/emergency/adhoc/swap (P6 §4.1.4). Pushes Thai error
// messages into `errors` and returns the resolved pay period (or null if it could not be resolved).
function applyPayPeriodChecks_(event, data, editingId, errors) {
  var resolved = null;
  try {
    resolved = resolvePayPeriod(event, data);
  } catch (err) {
    errors.push(err.message);
  }
  // Guard: should not happen after resolve, but never allow saving into a closed period.
  if (resolved && isClosedYm(resolved, data.periods)) {
    errors.push('งวดคิดเงิน ' + resolved + ' ปิดแล้ว แก้ไขไม่ได้');
  }
  if (editingId) {
    var orig = (data.events || []).find(function (e) { return e.event_id === editingId; });
    if (orig) {
      var origPeriod = payPeriodOf(orig);
      if (isClosedYm(origPeriod, data.periods)) {
        errors.push('รายการนี้คิดเงินในงวด ' + origPeriod + ' ที่ปิดแล้ว แก้ไขไม่ได้');
      }
    }
  }
  return resolved;
}

// P9 §4.3 helpers
function sameEventKey_(a, b) {
  return a.type === b.type &&
    (a.date || '') === (b.date || '') &&
    (a.date2 || '') === (b.date2 || '') &&
    (a.person_id || '') === (b.person_id || '') &&
    (a.person2_id || '') === (b.person2_id || '');
}

function findExactDuplicate_(event, vdata) {
  return (vdata.events || []).find(function (e) {
    return e.status !== 'deleted' && sameEventKey_(e, event);
  }) || null;
}

function collectSameDayWarnings_(event, vdata, warnings) {
  var mine = [];
  if (event.person_id) mine.push(event.person_id);
  if (event.person2_id) mine.push(event.person2_id);
  var dates = [event.date];
  if (event.type === 'swap' && event.date2) dates.push(event.date2);
  var seen = {};
  dates.forEach(function (d) {
    eventsTouching(d, vdata.events).forEach(function (o) {
      if (o.status === 'deleted') return;
      if (sameEventKey_(o, event)) return; // exact duplicate: already an error
      mine.forEach(function (pid) {
        if (o.person_id !== pid && o.person2_id !== pid) return;
        var key = pid + '|' + o.event_id;
        if (seen[key]) return;
        seen[key] = true;
        warnings.push(nickOf(pid, vdata) + ' มีรายการอื่นในวันเดียวกันแล้ว: ' + calendarTitle(o, vdata));
      });
    });
  });
}

function validateEvent(event, data, editingId) {
  var errors = [];
  var warnings = [];
  var known = { absent: 1, emergency: 1, swap: 1, adhoc: 1 };

  if (!event || !event.type || !known[event.type]) {
    errors.push('ประเภทรายการไม่ถูกต้อง');
    return { errors: errors, warnings: warnings };
  }

  if (event.type !== 'swap' && (event.portion !== 1 && event.portion !== 0.5)) {
    errors.push('สัดส่วนวันต้องเป็น 1 หรือ 0.5');
  }

  var vdata = cloneDataWithoutEvent(data, editingId);

  // P9 §4.3: exact duplicate guard (same type/date/date2/person/person2 as another active event).
  var exactDup = !!(event.person_id && event.date && findExactDuplicate_(event, vdata));
  if (exactDup) {
    errors.push('บันทึกซ้ำ: มีรายการนี้อยู่แล้ว');
  }
  // P9 §4.3: warn when a person already appears in another (non-identical) event on the same date.
  if (event.date) collectSameDayWarnings_(event, vdata, warnings);

  if (event.type === 'absent' || event.type === 'emergency') {
    if (!event.person_id || !event.date) {
      errors.push('กรุณากรอกข้อมูลให้ครบ');
      return { errors: errors, warnings: warnings };
    }
    if (event.cover && event.cover !== 'pending' && event.cover !== 'none') {
      errors.push('สถานะคนแทนไม่ถูกต้อง');
    }
    applyPayPeriodChecks_(event, data, editingId, errors);
    var absentee = personById(event.person_id, data);
    var absentNick = absentee ? absentee.nick : event.person_id;
    var roster = dayRoster(event.date, vdata).roster;
    var entry = roster.find(function (r) { return r.id === event.person_id; });
    var okStatuses = { base: 1, swi: 1, sub: 1 };
    if (event.off_schedule) {
      // P8 §4.4: off-schedule absence — the person has NO shift that day, so the roster-based
      // "must be scheduled" check is skipped (and inverted below); no substitute is allowed.
      if (event.type !== 'absent') {
        errors.push('ขาดนอกตารางใช้ได้เฉพาะประเภทขาดงาน');
      }
      if (!absentee || (absentee.group !== 'director' && absentee.group !== 'staff')) {
        errors.push('ผู้ขาดนอกตารางต้องเป็นกรรมการหรือพนักงาน');
      }
      if (event.deduct_mode !== 'adhoc' && event.deduct_mode !== 'absent') {
        errors.push('กรุณาเลือกหักเท่าเรทไหน (AdHoc หรือขาดปกติ)');
      }
      if (event.person2_id) {
        errors.push('ขาดนอกตารางห้ามมีคนเข้าแทน');
      }
      if (entry && okStatuses[entry.status]) {
        errors.push(absentNick + ' มีเวรวันนี้ ให้บันทึกเป็นขาดงานปกติ');
      }
    } else if (!entry || !okStatuses[entry.status]) {
      errors.push(absentNick + ' ไม่มีเวรวันนี้');
    }
    var dupe = vdata.events.some(function (e) {
      return e.status !== 'deleted' && (e.type === 'absent' || e.type === 'emergency') &&
        e.date === event.date && e.person_id === event.person_id;
    });
    if (dupe) {
      errors.push(absentNick + ' มีรายการขาด/ลาอยู่แล้ววันนี้');
    }
    if (event.person2_id && !event.off_schedule) {
      if (event.person2_id === event.person_id) {
        errors.push('คนแทนต้องไม่ใช่คนเดียวกับผู้ขาด');
      }
      var sub = personById(event.person2_id, data);
      var subNick = sub ? sub.nick : event.person2_id;
      if (!sub) {
        errors.push('ไม่พบคนแทน');
      } else {
        if (sub.group !== 'temp') {
          var subEntry = roster.find(function (r) { return r.id === event.person2_id; });
          if (subEntry && subEntry.id) {
            errors.push(subNick + ' มีเวรอยู่แล้ววันนี้');
          }
          if (sub.group === 'director' && event.sub_pay === 'normal') {
            warnings.push('กรรมการเข้าแทนคิดเป็น AdHoc อัตโนมัติ');
          }
        }
        // Staff who are also Tuesday-slot candidates (Config tue_allowed, passed in via data.config).
        var tueIds = (data.config && data.config.tue_allowed) || [];
        if (sub.group === 'staff' && tueIds.indexOf(sub.id) !== -1) {
          var tueNicks = tueIds.map(function (id) { return personById(id, data); })
            .filter(function (p) { return p && p.group === 'staff'; })
            .map(function (p) { return p.nick; });
          warnings.push(subNick + ' เข้าแทน (' + tueNicks.join('/') + ')');
        }
      }
    }
  } else if (event.type === 'adhoc') {
    if (!event.person_id || !event.date) {
      errors.push('กรุณากรอกข้อมูลให้ครบ');
      return { errors: errors, warnings: warnings };
    }
    applyPayPeriodChecks_(event, data, editingId, errors);
    var p = personById(event.person_id, data);
    var pNick = p ? p.nick : event.person_id;
    if (!p || p.group === 'temp') {
      errors.push('ผู้ทำ AdHoc ต้องเป็นกรรมการหรือพนักงาน');
    } else {
      var r2 = dayRoster(event.date, vdata).roster;
      var e2 = r2.find(function (r) { return r.id === event.person_id; });
      if (e2 && e2.id) {
        errors.push(pNick + ' มีเวรอยู่แล้ววันนี้');
      }
    }
  } else if (event.type === 'swap') {
    if (!event.person_id || !event.person2_id || !event.date || !event.date2) {
      errors.push('กรุณากรอกข้อมูลให้ครบ');
      return { errors: errors, warnings: warnings };
    }
    if (event.person_id === event.person2_id) {
      errors.push('คนสลับต้องไม่ใช่คนเดียวกัน');
    }
    if (event.date === event.date2) {
      errors.push('วันที่สลับต้องไม่ใช่วันเดียวกัน');
    }
    applyPayPeriodChecks_(event, data, editingId, errors);
    var aNick = nickOf(event.person_id, data);
    var bNick = nickOf(event.person2_id, data);
    var rosterDate = dayRoster(event.date, vdata).roster;
    var rosterDate2 = dayRoster(event.date2, vdata).roster;
    if (!isScheduledBase(event.person_id, rosterDate)) {
      errors.push(aNick + ' ไม่มีเวรวันที่ ' + event.date);
    }
    if (isScheduledBase(event.person_id, rosterDate2)) {
      errors.push(aNick + ' มีเวรอยู่แล้ววันที่ ' + event.date2);
    }
    if (!isScheduledBase(event.person2_id, rosterDate2)) {
      errors.push(bNick + ' ไม่มีเวรวันที่ ' + event.date2);
    }
    if (isScheduledBase(event.person2_id, rosterDate)) {
      errors.push(bNick + ' มีเวรอยู่แล้ววันที่ ' + event.date);
    }
  }

  return { errors: errors, warnings: warnings };
}

function previewEvent(event, data, editingId) {
  var v = validateEvent(event, data, editingId);
  var title = '';
  var money = [];
  try {
    title = calendarTitle(event, data);
    money = eventMoney(event, data);
  } catch (err) {
    // amounts may fail if rates are missing; surface as validation error instead of throwing
    v.errors.push(err.message);
  }
  // resolved pay period + whether it was forced by a closed month (P6 §4.1.5); best-effort,
  // errors from an invalid explicit pay_period are already reported via validateEvent above.
  var payPeriod = null;
  var payForced = false;
  if (event && event.date) {
    try {
      payPeriod = resolvePayPeriod(event, data);
    } catch (err2) { /* already surfaced in v.errors */ }
    payForced = isClosedYm(event.date.slice(0, 7), data.periods);
  }
  return { title: title, money: money, errors: v.errors, warnings: v.warnings, pay_period: payPeriod, pay_forced: payForced };
}

// ---------- staffing alerts (P9 section 4.2) ----------

// Effective "cover" of an absent/emergency event: '' has a substitute; 'pending' = waiting for cover;
// 'none' = no substitute needed. Legacy events (no substitute, blank cover) count as 'none' => no alert.
function coverOf(event) {
  if (!event || (event.type !== 'absent' && event.type !== 'emergency')) return '';
  if (event.person2_id) return '';
  return event.cover === 'pending' ? 'pending' : 'none';
}

var WORKING_STATUSES_ = { base: 1, sub: 1, tmp: 1, swi: 1, adh: 1, hab: 1 };

// -> [{kind, message, event_id?}] for one date.
function dayAlerts(date, data) {
  var alerts = [];
  var dr = dayRoster(date, data);
  var scheduled = baseRoster(date, data);
  var unassigned = 0;
  scheduled.forEach(function (r) { if (r.unassigned) unassigned++; });

  var explained = unassigned;
  dr.events.forEach(function (e) {
    if (e.status === 'deleted') return;
    if ((e.type !== 'absent' && e.type !== 'emergency') || e.date !== date) return;
    if (e.off_schedule || e.person2_id) return;
    explained++; // this person is out and nobody replaces them: a known reason for the gap
    if (coverOf(e) === 'pending' && (e.portion || 1) === 1) {
      alerts.push({ kind: 'pending_cover', message: nickOf(e.person_id, data) + ' ขาด ยังไม่มีคนแทน', event_id: e.event_id });
    }
  });

  if (unassigned && weekdayOf(date) === 2) {
    alerts.push({ kind: 'tue_unassigned', message: 'ช่องอังคารยังไม่ได้จัด' });
  }

  var working = dr.roster.filter(function (r) { return r.id && WORKING_STATUSES_[r.status]; }).length;
  var sched = scheduled.length;
  if (working < sched - explained) {
    alerts.push({ kind: 'short', message: 'คนไม่ครบ (' + working + '/' + sched + ')' });
  }
  return alerts;
}

// -> [{date, alerts:[...]}] for the days of ym that have alerts.
function monthAlerts(ym, data) {
  var out = [];
  datesOfMonth(ym).forEach(function (d) {
    var a = dayAlerts(d, data);
    if (a.length) out.push({ date: d, alerts: a });
  });
  return out;
}

// ---------- monthly aggregates ----------

function monthPayout(ym, data) {
  var peopleMap = {};
  var tempsMap = {};
  var carried = 0;

  (data.events || []).forEach(function (e) {
    if (e.status === 'deleted') return;
    if (e.type === 'swap') return;
    if (payPeriodOf(e) !== ym) return;
    var dateMonth = e.date.slice(0, 7);
    var isCarried = dateMonth !== ym;
    if (isCarried) carried++;
    var suffix = isCarried ? ' (ยกมาจาก ' + monthShortYear(dateMonth) + ')' : '';
    var lines = eventMoney(e, data);
    lines.forEach(function (line) {
      var label = line.label + suffix;
      if (line.bucket === 'slip') {
        var p = personById(line.person_id, data);
        var nick = p ? p.nick : line.person_id;
        if (!peopleMap[line.person_id]) {
          peopleMap[line.person_id] = { id: line.person_id, nick: nick, plus: 0, minus: 0, lines: [] };
        }
        var entry = peopleMap[line.person_id];
        if (line.amount > 0) entry.plus = round2(entry.plus + line.amount);
        else if (line.amount < 0) entry.minus = round2(entry.minus - line.amount);
        entry.lines.push(label);
      } else if (line.bucket === 'temp') {
        var tp = personById(line.person_id, data);
        var tnick = tp ? tp.nick : line.person_id;
        if (!tempsMap[line.person_id]) {
          tempsMap[line.person_id] = {
            id: line.person_id, nick: tnick, bank: (tp && tp.bank) || '', account_no: (tp && tp.account_no) || '',
            amount: 0, paidAmount: 0, unpaidAmount: 0, lines: [], days: []
          };
        }
        var tentry = tempsMap[line.person_id];
        tentry.amount = round2(tentry.amount + line.amount);
        tentry.lines.push(label);
        var isPaid = e.temp_paid === true || e.temp_paid === 'TRUE' || e.temp_paid === 'true';
        tentry.days.push({
          event_id: e.event_id, date: e.date,
          label: 'แทน ' + nickOf(e.person_id, data) + (e.portion === 0.5 ? ' ครึ่งวัน' : ''),
          amount: line.amount, paid: isPaid,
          paid_by: isPaid ? (e.temp_paid_by || '') : '', paid_at: isPaid ? (e.temp_paid_at || '') : ''
        });
        if (isPaid) tentry.paidAmount = round2(tentry.paidAmount + line.amount);
        else tentry.unpaidAmount = round2(tentry.unpaidAmount + line.amount);
      }
    });
  });

  // P7 §4.1.2: Tuesday-slot pay lines for every Tuesday of ym that has a person assigned.
  // Slots cannot be set in closed months, so there is no carry-over case to handle here.
  (data.tueSlots || []).forEach(function (slot) {
    if (!slot.person_id) return;
    if (slot.date.slice(0, 7) !== ym) return;
    var lines = tueSlotMoney(slot, data);
    lines.forEach(function (line) {
      var p = personById(line.person_id, data);
      var nick = p ? p.nick : line.person_id;
      if (!peopleMap[line.person_id]) {
        peopleMap[line.person_id] = { id: line.person_id, nick: nick, plus: 0, minus: 0, lines: [] };
      }
      var entry = peopleMap[line.person_id];
      if (line.amount > 0) entry.plus = round2(entry.plus + line.amount);
      else if (line.amount < 0) entry.minus = round2(entry.minus - line.amount);
      entry.lines.push(line.label);
    });
  });

  var people = Object.keys(peopleMap).map(function (k) { return peopleMap[k]; });
  people.sort(function (a, b) { return (b.plus - b.minus) - (a.plus - a.minus); });

  var temps = Object.keys(tempsMap).map(function (k) { return tempsMap[k]; });
  temps.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });

  var totPlus = round2(people.reduce(function (s, p) { return s + p.plus; }, 0));
  var totMinus = round2(people.reduce(function (s, p) { return s + p.minus; }, 0));
  temps.forEach(function (t) {
    t.days.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  });
  var tempTotal = round2(temps.reduce(function (s, t) { return s + t.amount; }, 0));
  var tempPaidTotal = round2(temps.reduce(function (s, t) { return s + t.paidAmount; }, 0));
  var tempUnpaidTotal = round2(temps.reduce(function (s, t) { return s + t.unpaidAmount; }, 0));

  var csvRows = Object.keys(peopleMap)
    .filter(function (id) { var e = peopleMap[id]; return e.plus > 0 || e.minus > 0; })
    .sort();
  var csvLines = ['emp_id,nick,other_earn,absent'];
  csvRows.forEach(function (id) {
    var e = peopleMap[id];
    csvLines.push(id + ',' + e.nick + ',' + fmt2(e.plus) + ',' + fmt2(e.minus));
  });
  var csv = csvLines.join('\n');
  var filename = 'ShiftLog_' + ym + '.csv';

  return { ym: ym, people: people, temps: temps, totPlus: totPlus, totMinus: totMinus, tempTotal: tempTotal, tempPaidTotal: tempPaidTotal, tempUnpaidTotal: tempUnpaidTotal, csv: csv, filename: filename, carried: carried };
}

function monthStats(ym, data) {
  var dates = datesOfMonth(ym);
  var statMap = {};
  (data.people || []).forEach(function (p) {
    if (p.group === 'director' || p.group === 'staff') {
      statMap[p.id] = { id: p.id, nick: p.nick, group: p.group, sch: 0, abs: 0, absOff: 0, emg: 0, sub: 0, adh: 0, swp: 0 };
    }
  });

  dates.forEach(function (d) {
    baseRoster(d, data).forEach(function (r) {
      if (r.id && statMap[r.id]) statMap[r.id].sch += 1;
    });
  });

  var tempsMap = {};

  dates.forEach(function (d) {
    eventsTouching(d, data.events).forEach(function (e) {
      if (e.status === 'deleted') return;
      if (e.type === 'absent' && e.date === d) {
        if (statMap[e.person_id]) {
          statMap[e.person_id].abs += e.portion;
          // P8: off-schedule absence counts in abs but not against attendance (sch is unchanged).
          if (e.off_schedule) statMap[e.person_id].absOff += e.portion;
        }
        if (e.person2_id) {
          var sub = personById(e.person2_id, data);
          if (sub && sub.group === 'temp') {
            if (!tempsMap[e.person2_id]) tempsMap[e.person2_id] = { id: e.person2_id, nick: sub.nick, days: 0, detail: [] };
            tempsMap[e.person2_id].days = round2(tempsMap[e.person2_id].days + e.portion);
            tempsMap[e.person2_id].detail.push('แทน ' + nickOf(e.person_id, data) + ' ' + thaiShortDate(d));
          } else if (statMap[e.person2_id]) {
            statMap[e.person2_id].sub += e.portion;
          }
        }
      } else if (e.type === 'emergency' && e.date === d) {
        if (statMap[e.person_id]) statMap[e.person_id].emg += e.portion;
        if (e.person2_id) {
          var sub2 = personById(e.person2_id, data);
          if (sub2 && sub2.group === 'temp') {
            if (!tempsMap[e.person2_id]) tempsMap[e.person2_id] = { id: e.person2_id, nick: sub2.nick, days: 0, detail: [] };
            tempsMap[e.person2_id].days = round2(tempsMap[e.person2_id].days + e.portion);
            tempsMap[e.person2_id].detail.push('แทน ' + nickOf(e.person_id, data) + ' ' + thaiShortDate(d));
          } else if (statMap[e.person2_id]) {
            statMap[e.person2_id].sub += e.portion;
          }
        }
      } else if (e.type === 'adhoc' && e.date === d) {
        if (statMap[e.person_id]) statMap[e.person_id].adh += e.portion;
      } else if (e.type === 'swap' && (e.date === d || e.date2 === d)) {
        if (e.date === d) {
          if (statMap[e.person_id]) statMap[e.person_id].swp += 1;
          if (statMap[e.person2_id]) statMap[e.person2_id].swp += 1;
        }
      }
    });
  });

  var rows = (data.people || [])
    .filter(function (p) { return p.group === 'director' || p.group === 'staff'; })
    .map(function (p) {
      var s = statMap[p.id];
      var schAbs = s.abs - s.absOff; // absences against scheduled shifts only
      var onDuty = s.sch - schAbs - s.emg;
      var extra = Math.max(0, s.sub + s.adh - s.absOff);
      var wrk = onDuty + extra;
      var att = s.sch > 0 ? Math.round((s.sch - schAbs - s.emg) / s.sch * 100) : null;
      return { id: s.id, nick: s.nick, group: s.group, sch: s.sch, onDuty: onDuty, extra: extra, wrk: wrk, att: att, abs: s.abs, absOff: s.absOff, emg: s.emg, sub: s.sub, adh: s.adh, swp: s.swp };
    });

  var team = rows.reduce(function (acc, r) {
    acc.sch += r.sch; acc.abs += r.abs; acc.absOff += r.absOff; acc.emg += r.emg; acc.sub += r.sub; acc.adh += r.adh; acc.swp += r.swp;
    return acc;
  }, { sch: 0, abs: 0, absOff: 0, emg: 0, sub: 0, adh: 0, swp: 0 });
  var teamSchAbs = team.abs - team.absOff;
  team.onDuty = rows.reduce(function (a, r) { return a + r.onDuty; }, 0);
  team.extra = rows.reduce(function (a, r) { return a + r.extra; }, 0);
  team.wrk = team.onDuty + team.extra;
  team.att = team.sch > 0 ? Math.round((team.sch - teamSchAbs - team.emg) / team.sch * 100) : null;

  var temps = Object.keys(tempsMap).map(function (k) { return tempsMap[k]; });

  return { ym: ym, rows: rows, team: team, temps: temps };
}

function monthView(ym, data) {
  var closed = (data.periods || []).some(function (p) { return p.period === ym && p.status === 'closed'; });
  var dates = datesOfMonth(ym);
  var days = dates.map(function (d) {
    var dr = dayRoster(d, data);
    var events = dr.events.map(function (e) {
      var enriched = {};
      for (var k in e) enriched[k] = e[k];
      enriched.title = calendarTitle(e, data);
      enriched.money = eventMoney(e, data);
      enriched.effectivePay = effectivePay(e, data);
      enriched.pay_period = payPeriodOf(e);
      enriched.pay_carried = enriched.pay_period !== e.date.slice(0, 7);
      // Derived (not stored): lets the UI hide edit/delete for a specific event without
      // needing to fetch the closed status of a different month's period.
      enriched.pay_closed = isClosedYm(enriched.pay_period, data.periods);
      return enriched;
    });
    var out = { date: dr.date, weekday: dr.weekday, roster: dr.roster, events: events };
    // P7 §4.1.3: Tuesday-slot pay preview, so the UI can show it without a separate call.
    if (dr.weekday === 2) {
      var slot = (data.tueSlots || []).find(function (s) { return s.date === d; });
      var personId = slot ? slot.person_id : '';
      out.tueSlot = { person_id: personId, money: tueSlotMoney({ date: d, person_id: personId }, data) };
    }
    return out;
  });
  return { ym: ym, closed: closed, days: days };
}

if (typeof module !== 'undefined') {
  module.exports = {
    round2: round2,
    daysInMonth: daysInMonth,
    weekdayOf: weekdayOf,
    thaiShortDate: thaiShortDate,
    isClosed: isClosed,
    latestClosedEnd: latestClosedEnd,
    isClosedYm: isClosedYm,
    nextMonthStr: nextMonthStr,
    monthShortYear: monthShortYear,
    payPeriodOf: payPeriodOf,
    firstOpenPeriodFrom: firstOpenPeriodFrom,
    resolvePayPeriod: resolvePayPeriod,
    rateOn: rateOn,
    templateFor: templateFor,
    baseRoster: baseRoster,
    dayRoster: dayRoster,
    eventMoney: eventMoney,
    tueSlotMoney: tueSlotMoney,
    tuePlan: tuePlan,
    effectivePay: effectivePay,
    calendarTitle: calendarTitle,
    validateEvent: validateEvent,
    previewEvent: previewEvent,
    monthPayout: monthPayout,
    monthStats: monthStats,
    monthView: monthView,
    coverOf: coverOf,
    dayAlerts: dayAlerts,
    monthAlerts: monthAlerts,
    datesOfMonth: datesOfMonth
  };
}
