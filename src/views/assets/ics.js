// Roster rows <-> iCalendar (.ics), shared by /roster (export) and /calendar (view).
//   <script src="/assets/ics.js"></script>  ->  window.RosterIcs
//
// RosterIcs.rosterEvents({ published, planned }, { name }) -> { events, skipped }
// RosterIcs.rowsToIcs({ published, planned }, { name, now }) -> { ics, events, skipped }
//   Times of a row: "19:50 Z" = UTC; "09:00 L" / "LB" / "B" = local time of the place, written
//   as floating time; "A"/"E" before a time (actual / estimated) is dropped; "+1" / "-1" after
//   it moves it a day; an end before the begin is the next day. A row without a time is all-day.
//   Events (rows in roster order, Published then Planned):
//   - duty: from a check-in (C/I, CHECK-IN) to the next check-out (C/O, CHECK-OUT). The rows
//     between them (flights, sims, ...) are its own events inside it (RELATED-TO the duty).
//     No check-out: the duty ends with its last event. Without a check-in, rows stand alone.
//   - hotel (HT, HTL, H1, H5*, H?, without times of its own): from the end of the last event
//     before it to the start of the first event after it; nights in a row at the same hotel
//     are one event. No such neighbours (or on another clock): all-day on its dates.
//   - any other row: an event of its own (a moment when it has only one time).
//   Planned rows are STATUS:TENTATIVE with CATEGORIES:Planned. Rows whose date can not be
//   read are left out (`skipped`). X-ROSTER-KIND: duty | flight | sim | hotel | event.
// RosterIcs.parseIcs(text) -> { name, events: [{ uid, summary, location, description, status,
//   categories, kind, parent, allDay, start, end }] }   start/end: { y, mo, d, h, mi, utc }
(function (root) {
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** "7 Jan 25" / "07 JAN 2025" -> { y, mo, d } (mo 1-12), or null. */
  function parseDate(s) {
    const m = /^\s*(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\.?\s*(\d{2}|\d{4})\s*$/.exec(String(s || ''));
    if (!m) return null;
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (!mo) return null;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = Number(m[1]);
    if (d < 1 || d > 31) return null;
    return { y, mo, d };
  }

  /** "A02:00 Z +1" -> { h, mi, utc, offset }; of "08:00 Z / 10:00 L" the first one. */
  function parseTime(s) {
    const first = String(s || '').split('/')[0];
    const m = /^\s*[AE]?\s*(\d{1,2}):(\d{2})\s*(Z|LB|L|B)?\s*([+-]\s*\d+)?/i.exec(first);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 24 || mi > 59) return null;
    return { h, mi, utc: !m[3] || m[3].toUpperCase() === 'Z', offset: m[4] ? Number(m[4].replace(/\s/g, '')) : 0 };
  }

  // Calendar arithmetic on plain fields (no time zone involved).
  function addMinutes(t, minutes) {
    const x = new Date(Date.UTC(t.y, t.mo - 1, t.d, t.h || 0, t.mi || 0) + minutes * 60000);
    return { ...t, y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() };
  }
  const addDays = (t, days) => addMinutes(t, days * 1440);
  const stamp = (t) => Date.UTC(t.y, t.mo - 1, t.d, t.h || 0, t.mi || 0);

  const fmtDate = (t) => `${t.y}${pad(t.mo)}${pad(t.d)}`;
  const fmtDateTime = (t) => `${fmtDate(t)}T${pad(t.h)}${pad(t.mi)}00${t.utc ? 'Z' : ''}`;

  const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  // Lines longer than 75 octets are folded (RFC 5545 3.1), never inside a UTF-8 character.
  const enc = new TextEncoder();
  function fold(line) {
    if (enc.encode(line).length <= 75) return line;
    const out = [];
    let cur = '', bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }

  function hash(s) { // FNV-1a, for stable UIDs: importing the file again updates the same events
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  const LABELS = { dc: 'DC', registration: 'Reg', ac: 'AC', crew: 'Crew', info: 'Info' };

  function summaryOf(row) {
    const route = row.dep && row.arr ? `${row.dep} → ${row.arr}` : row.dep || row.arr || '';
    const duty = String(row.duty || '').trim();
    if (duty || route) return [duty, route].filter(Boolean).join(' ');
    const info = /^\[([^\]]+)\]/.exec(String(row.info || ''));
    return info ? info[1] : 'Roster';
  }

  function descriptionOf(row, section) {
    const lines = [`${section === 'planned' ? 'Planned' : 'Published'} · ${row.date || ''}${row.day ? ` (${row.day})` : ''}`];
    if (row.duty) lines.push(`Duty: ${row.duty}`);
    if (row.dep || row.arr) lines.push(`Route: ${row.dep || '?'} → ${row.arr || '?'}`);
    if (row.begin || row.end) lines.push(`Time: ${row.begin || '–'} → ${row.end || '–'}`);
    for (const [k, title] of Object.entries(LABELS)) {
      if (!row[k]) continue;
      // "[a][b]" lists (crew, info) one per line
      const parts = String(row[k]).match(/\[[^\]]*\]/g);
      if (parts && parts.join('') === String(row[k]).trim()) lines.push(`${title}:`, ...parts.map(p => `  ${p.slice(1, -1)}`));
      else lines.push(`${title}: ${row[k]}`);
    }
    return lines.join('\n');
  }

  /** The times of one row: { allDay, start, end } (end may be null), or null when the date is not readable. */
  function timesOf(row) {
    const date = parseDate(row.date);
    if (!date) return null;
    const b = parseTime(row.begin), e = parseTime(row.end);
    if (!b && !e) return { allDay: true, start: date, end: addDays(date, 1) };
    const at = (t) => addDays({ ...date, h: t.h, mi: t.mi, utc: t.utc }, t.offset);
    if (b && e && b.utc === e.utc) {
      const start = at(b);
      let end = at(e);
      if (stamp(end) < stamp(start) && !e.offset) end = addDays(end, 1); // "23:10 Z" -> "01:20 Z"
      return { allDay: false, start, end: stamp(end) > stamp(start) ? end : null };
    }
    // one time, or a UTC begin with a local end (no common clock): the first one as a moment
    return { allDay: false, start: at(b || e), end: null };
  }

  // ---- roster rows -> calendar events ----

  // one letter of CHECK may be misread ("CHFCK-IN")
  const CHECK_IN_RE = /^(C\/I|CH[A-Z]CK[- ]?IN)$/i;
  const CHECK_OUT_RE = /^(C\/O|CH[A-Z]CK[- ]?OUT)$/i;
  const HOTEL_RE = /^(HT|HTL|H\d+\*?|H\?)$/i; // HT/HTL, or a hotel code ("H2624" with times and an arrival is a flight)
  const MAX_DUTY_MIN = 36 * 60; // a check-in never holds rows later than this (a missing check-out)

  const dutyOf = (row) => String(row.duty || '').trim();
  const isHotel = (row) => HOTEL_RE.test(dutyOf(row)) && (/^HTL?$/i.test(dutyOf(row)) || (!row.begin && !row.end && !row.arr));
  const kindOf = (row) => (isHotel(row) ? 'hotel' : /SIM/i.test(dutyOf(row)) ? 'sim' : row.dep && row.arr && row.dep !== row.arr ? 'flight' : 'event');
  const minutesBetween = (a, b) => (stamp(b) - stamp(a)) / 60000;
  const lastMoment = (e) => e.end || e.start;
  const sameClock = (a, b) => !!a && !!b && !!a.utc === !!b.utc;

  function rosterEvents(result, { name = 'Roster' } = {}) {
    const seen = new Map();
    const uid = (parts) => {
      const key = [name, ...parts].join('|');
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return `${hash(key)}-${n}@roster-ocr`;
    };
    const skipped = [];
    const items = [];
    for (const section of ['published', 'planned']) {
      for (const row of result[section] || []) {
        const t = timesOf(row);
        if (t) items.push({ row, section, t }); else skipped.push({ section, row });
      }
    }

    const rowEvent = ({ row, section, t }, kind = kindOf(row)) => ({
      uid: uid([section, row.date, row.duty, row.dep, row.arr, row.begin, row.end]),
      kind, summary: summaryOf(row), location: row.dep || '', description: descriptionOf(row, section),
      tentative: section === 'planned', allDay: t.allDay, start: t.start, end: t.end, rows: [row],
    });

    // 1. duties: check-in .. check-out, the rows between them inside (timed rows and hotels as
    // events of the duty, rows without a time in its description)
    const out = [];
    let open = null; // { ci: item, inside: [item] } in roster order
    const timedChild = (it) => !it.t.allDay && !isHotel(it.row);
    const closeDuty = (co) => {
      const { ci } = open;
      let inside = open.inside;
      open = null;
      let after = [];
      if (!co) { // no check-out: the duty ends with its last timed event; what follows stands alone
        const last = inside.map(timedChild).lastIndexOf(true);
        after = inside.slice(last + 1);
        inside = inside.slice(0, last + 1);
      }
      const children = inside.filter(it => !it.t.allDay || isHotel(it.row));
      const notes = inside.filter(it => it.t.allDay && !isHotel(it.row));
      const emitAfter = () => after.forEach(it => out.push(rowEvent(it)));
      const start = ci.t.start;
      const childEnd = children.filter(timedChild).map(c => lastMoment(c.t)).filter(m => sameClock(m, start)).sort((a, b) => stamp(b) - stamp(a))[0];
      const coEnd = co && sameClock(lastMoment(co.t), start) && stamp(lastMoment(co.t)) >= stamp(start) ? lastMoment(co.t) : null;
      const end = coEnd || childEnd || null;
      if (!end || stamp(end) <= stamp(start)) { // nothing to span: the check-in (and check-out) as moments
        out.push(rowEvent(ci), ...inside.map(c => rowEvent(c)));
        if (co) out.push(rowEvent(co));
        emitAfter();
        return;
      }
      const legs = children.filter(timedChild).map(c => c.row);
      const route = [];
      for (const r of legs) {
        if (r.dep && route[route.length - 1] !== r.dep) route.push(r.dep);
        if (r.arr && route[route.length - 1] !== r.arr) route.push(r.arr);
      }
      const where = route.length > 1 ? route.join(' → ') : ci.row.dep || route[0] || '';
      const duty = {
        uid: uid(['duty', ci.section, ci.row.date, ci.row.begin, ci.row.dep]),
        kind: 'duty', summary: `Duty${where ? ` ${where}` : ''}`, location: ci.row.dep || legs[0]?.dep || '',
        tentative: ci.section === 'planned', allDay: false, start, end, rows: [ci.row, ...inside.map(it => it.row), ...(co ? [co.row] : [])],
      };
      const hours = minutesBetween(start, end);
      duty.description = [
        `${ci.section === 'planned' ? 'Planned' : 'Published'} duty · ${Math.floor(hours / 60)}h${pad(hours % 60)}`,
        `Check-in: ${ci.row.date} ${ci.row.begin}${ci.row.dep ? ` ${ci.row.dep}` : ''}`,
        co ? `Check-out: ${co.row.date} ${co.row.end || co.row.begin}${co.row.arr ? ` ${co.row.arr}` : ''}` : 'Check-out: (not in the roster: until the last event)',
        '{events}', // its events with their times, once the hotels' are known (below)
        ...(notes.length ? [`Also: ${notes.map(({ row: r }) => summaryOf(r)).join(', ')}`] : []),
        ...[ci.row.info, co && co.row.info].filter(Boolean).map(i => `Info: ${i}`),
      ].join('\n');
      out.push(duty, ...children.map(c => ({ ...rowEvent(c), parent: duty.uid })));
      emitAfter();
    };
    for (const it of items) {
      const d = dutyOf(it.row);
      if (CHECK_IN_RE.test(d) && !it.t.allDay) { if (open) closeDuty(null); open = { ci: it, inside: [] }; continue; }
      if (CHECK_OUT_RE.test(d) && !it.t.allDay) { if (open) closeDuty(it); else out.push(rowEvent(it)); continue; }
      if (open) {
        // a row of the duty: on its clock (a row without a time: its day) and not too long after the check-in
        const at = it.t.allDay ? { ...it.t.start, h: 0, mi: 0, utc: open.ci.t.start.utc } : it.t.start;
        if (sameClock(at, open.ci.t.start) && minutesBetween(open.ci.t.start, at) <= MAX_DUTY_MIN) { open.inside.push(it); continue; }
        closeDuty(null);
      }
      out.push(rowEvent(it));
    }
    if (open) closeDuty(null);

    // 2. hotels: nights in a row at the same hotel are one event, from the event before to the event after
    const events = [];
    for (const e of out) {
      const prev = events[events.length - 1];
      const row = e.rows[0];
      if (e.kind === 'hotel' && e.allDay && prev?.kind === 'hotel' && prev.allDay && prev.parent === e.parent
        && dutyOf(prev.rows[0]) === dutyOf(row) && (prev.rows[0].dep || '') === (row.dep || '') && (prev.rows[0].info || '') === (row.info || '')
        && stamp(prev.end) >= stamp(e.start)) {
        prev.end = e.end;
        prev.rows.push(row);
        continue;
      }
      events.push(e);
    }
    events.forEach((h, i) => {
      if (h.kind !== 'hotel' || !h.allDay) return;
      const firstDay = h.start, lastDay = addDays(h.end, -1);
      // neighbours at the hotel's level: the events of its duty, or the events outside duties
      const neighbour = (e) => e.kind !== 'hotel' && (e.parent || '') === (h.parent || '');
      let before = null;
      for (let k = i - 1; k >= 0 && !before; k--) {
        const e = events[k];
        if (!neighbour(e)) continue;
        if (e.allDay) break;
        before = lastMoment(e);
      }
      if (!before || stamp(before) < stamp(addDays(firstDay, -1))) return;
      let after = null;
      for (let k = i + 1; k < events.length && !after; k++) {
        const e = events[k];
        if (!neighbour(e)) continue;
        if (e.allDay) break;
        if (sameClock(e.start, before) && stamp(e.start) > stamp(before)) after = e.start;
      }
      if (!after || !sameClock(after, before) || stamp(after) > stamp(addDays(lastDay, 2))) return;
      const nights = h.rows.length;
      Object.assign(h, { allDay: false, start: before, end: after });
      h.description = `${h.description}${nights > 1 ? `\nNights: ${nights}` : ''}\nFrom the end of the event before to the start of the event after.`;
    });

    // 3. a duty's description lists its events
    const clock = (t) => `${pad(t.h)}:${pad(t.mi)}${t.utc ? ' Z' : ''}`;
    for (const d of events) {
      if (d.kind !== 'duty') continue;
      const inside = events.filter(e => e.parent === d.uid)
        .map(e => `  ${e.allDay ? 'all day' : `${clock(e.start)}${e.end ? ` → ${clock(e.end)}` : ''}`}  ${e.summary}`);
      d.description = d.description.split('\n').flatMap(l => (l === '{events}' ? (inside.length ? ['Events:', ...inside] : []) : [l])).join('\n');
    }
    return { events, skipped };
  }

  function rowsToIcs(result, { name = 'Roster', now = new Date() } = {}) {
    const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RosterParser//Roster export//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeText(name)}`];
    const { events, skipped } = rosterEvents(result, { name });
    for (const e of events) {
      lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${dtstamp}`);
      if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${fmtDate(e.start)}`, `DTEND;VALUE=DATE:${fmtDate(e.end)}`, 'TRANSP:TRANSPARENT');
      else {
        lines.push(`DTSTART:${fmtDateTime(e.start)}`);
        if (e.end) lines.push(`DTEND:${fmtDateTime(e.end)}`);
      }
      lines.push(`SUMMARY:${escapeText(e.summary)}`);
      if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
      lines.push(`DESCRIPTION:${escapeText(e.description)}`);
      if (e.parent) lines.push(`RELATED-TO;RELTYPE=PARENT:${e.parent}`);
      lines.push(`X-ROSTER-KIND:${e.kind}`);
      lines.push(`CATEGORIES:${e.tentative ? 'Planned' : 'Published'}`);
      lines.push(`STATUS:${e.tentative ? 'TENTATIVE' : 'CONFIRMED'}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return { ics: lines.map(fold).join('\r\n') + '\r\n', events: events.length, skipped };
  }

  // ---- reading .ics ----

  const unescapeText = (s) => String(s).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

  /** "20250107T020000Z" / "20250107T0200" / "20250107" -> { y, mo, d, h, mi, utc, dateOnly } */
  function parseIcsDate(value, params) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
    if (!m) return null;
    const dateOnly = !m[4] || params.VALUE === 'DATE';
    return { y: +m[1], mo: +m[2], d: +m[3], h: dateOnly ? 0 : +m[4], mi: dateOnly ? 0 : +m[5], utc: !!m[7], dateOnly };
  }

  /** "P1DT2H30M" / "-PT15M" / "P2W" -> minutes */
  function parseDuration(s) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s).trim());
    if (!m) return null;
    const min = (+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.floor((+m[6] || 0) / 60);
    return m[1] === '-' ? -min : min;
  }

  function parseLine(line) {
    // NAME;PARAM=a;PARAM="b:c":value (a colon inside quotes is not the separator)
    let i = 0, quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (c === ':' && !quoted) break;
    }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...rest] = head.split(';');
    const params = {};
    for (const p of rest) {
      const k = p.indexOf('=');
      if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
    }
    return { name: name.toUpperCase(), params, value };
  }

  function parseIcs(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const events = [];
    let name = '', cur = null, depth = 0;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const { name: prop, params, value } = parseLine(raw);
      if (prop === 'BEGIN' && value.toUpperCase() === 'VEVENT') { cur = { props: {} }; depth = 0; continue; }
      if (cur && prop === 'BEGIN') { depth += 1; continue; } // VALARM etc. inside an event
      if (cur && prop === 'END' && depth) { depth -= 1; continue; }
      if (prop === 'END' && value.toUpperCase() === 'VEVENT' && cur) {
        const p = cur.props;
        const start = p.DTSTART && parseIcsDate(p.DTSTART.value, p.DTSTART.params);
        if (start) {
          let end = p.DTEND ? parseIcsDate(p.DTEND.value, p.DTEND.params) : null;
          if (!end && p.DURATION) {
            const min = parseDuration(p.DURATION.value);
            if (min != null) end = { ...addMinutes(start, min), utc: start.utc, dateOnly: start.dateOnly };
          }
          if (!end && start.dateOnly) end = { ...addDays(start, 1), dateOnly: true };
          events.push({
            uid: p.UID ? p.UID.value : '',
            summary: p.SUMMARY ? unescapeText(p.SUMMARY.value) : (root.__ || ((s) => s))('(no title)'),
            location: p.LOCATION ? unescapeText(p.LOCATION.value) : '',
            description: p.DESCRIPTION ? unescapeText(p.DESCRIPTION.value) : '',
            status: p.STATUS ? p.STATUS.value.toUpperCase() : '',
            categories: p.CATEGORIES ? unescapeText(p.CATEGORIES.value).split(',').map(s => s.trim()).filter(Boolean) : [],
            tzid: p.DTSTART.params.TZID || '',
            kind: p['X-ROSTER-KIND'] ? p['X-ROSTER-KIND'].value.toLowerCase() : '',
            parent: p['RELATED-TO'] && (p['RELATED-TO'].params.RELTYPE || 'PARENT').toUpperCase() === 'PARENT' ? p['RELATED-TO'].value : '',
            allDay: start.dateOnly,
            start,
            end,
          });
        }
        cur = null;
        continue;
      }
      if (cur) { if (!depth && !cur.props[prop]) cur.props[prop] = { params, value }; }
      else if (prop === 'X-WR-CALNAME') name = unescapeText(value);
    }
    return { name, events };
  }

  const api = { rosterEvents, rowsToIcs, parseIcs, parseDate, parseTime, timesOf, addDays, addMinutes };
  root.RosterIcs = api;
})(typeof window !== 'undefined' ? window : globalThis);
