'use strict';
// QIS Sales Dashboard — static app. Views: #/dashboard (default), #/entries, #/new, #/edit/:id.
(function () {
  const p = window.QIS_PACING;
  const db = window.QIS_DB;
  const C = window.QIS_CONFIG;

  const TEAM_WIN = 'Team Win';
  const LEAD_SOURCES = [
    'In Bound Email', 'In Bound Call', 'In Bound Order/PO', 'Pop Up Form',
    'Online form Submission', 'Liam N Outbound', 'Jack N Outbound',
    'Luke H Outbound', 'Allegra Outbound',
  ];
  const PENDING = 'Pending Source';
  const INBOUND = new Set(['In Bound Email', 'In Bound Call', 'In Bound Order/PO', 'Pop Up Form', 'Online form Submission']);
  const OUTBOUND = new Set(['Liam N Outbound', 'Jack N Outbound', 'Luke H Outbound', 'Allegra Outbound']);
  const sourceType = (src) => (INBOUND.has(src) ? 'in' : OUTBOUND.has(src) ? 'out' : 'pend');
  const LOSS_REASONS = ['Price too high', 'Chose a competitor', 'No response / went quiet',
    'Timing / project postponed', "Couldn't meet spec or MOQ", 'Lead time too long', 'Other'];
  // aging buckets (days): long purchasing cycles — aged = 60+
  const AGE_BUCKETS = [
    { key: '0-14', label: '0–14 days', min: 0, max: 14, cls: 'b1', chip: 'a1' },
    { key: '15-30', label: '15–30 days', min: 15, max: 30, cls: 'b2', chip: 'a2' },
    { key: '30-60', label: '30–60 days', min: 31, max: 59, cls: 'b3', chip: 'a3' },
    { key: '60+', label: '60+ days ⚠', min: 60, max: 99999, cls: 'b4', chip: 'a4' },
  ];
  const ageOf = (q, asOf) => Math.max(0, Math.round((Date.parse(asOf) - Date.parse(q.quote_date)) / 86400000));
  const bucketOf = (days) => AGE_BUCKETS.find((b) => days >= b.min && days <= b.max) || AGE_BUCKETS[3];

  let S = null; // { entries, targets, holidays(Set), roster, fyMonths }

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt$ = (v) => (v == null ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: 0 }));
  const fmt$2 = (v) => '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%';
  const stateOf = (vp) => (vp >= 0 ? 'good' : vp >= -0.15 ? 'warn' : 'bad');
  const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const AU_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayLabel = (iso) => `${DAYS[p.dow(iso)]} ${ddmmyyyy(iso)}`;
  const monthLabel = (m) => `${AU_MONTH[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const round2 = (n) => Math.round(n * 100) / 100;
  const todayBrisbane = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
  const isRealDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };

  function hashParts() {
    const h = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart] = h.split('?');
    return { path: pathPart || 'dashboard', q: new URLSearchParams(queryPart || '') };
  }
  const go = (path, params) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    location.hash = `#/${path}${qs}`;
  };

  // ---------- validation (ported from the portal) ----------
  function parseRevenue(raw) {
    const cleaned = String(raw ?? '').trim().replace(/[$,\s]/g, '');
    if (cleaned === '') return { error: 'Revenue is required.' };
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { error: 'Revenue must be a positive amount with at most 2 decimals (ex-GST).' };
    return { value: Math.round(parseFloat(cleaned) * 100) };
  }
  function parseGp(raw) {
    const s = String(raw ?? '').trim().replace(/%$/, '').trim();
    if (s === '') return { value: null };
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { error: 'GP% must be between 0 and 100 (e.g. 40 or 0.40).' };
    if (n > 100) return { error: 'GP% cannot exceed 100.' };
    return { value: n <= 1 ? n : n / 100 };
  }
  function parseEntryForm(f) {
    const errors = []; const warnings = [];
    if (!isRealDate(f.entry_date)) errors.push('A valid date is required.');
    else {
      const fyEnd = p.monthEnd(S.fyMonths[11]);
      if (f.entry_date < C.FY_START || f.entry_date > fyEnd) warnings.push('Date is outside the current financial year.');
    }
    const okPeople = [...S.roster, TEAM_WIN];
    if (!okPeople.includes(f.person)) errors.push('Pick a team member (or Team Win) from the list.');
    const customer = String(f.customer ?? '').trim();
    if (!customer) errors.push('Customer is required.');
    const orderRef = String(f.order_ref ?? '').trim().slice(0, 50) || null;
    const revenue = parseRevenue(f.revenue);
    if (revenue.error) errors.push(revenue.error);
    const gp = parseGp(f.gp_pct);
    if (gp.error) errors.push(gp.error);
    const rawSource = String(f.lead_source ?? '').trim();
    const leadSource = LEAD_SOURCES.includes(rawSource) ? rawSource : null;
    if (errors.length) return { errors };
    return {
      value: {
        entry_date: f.entry_date, person: f.person, customer,
        order_ref: orderRef, revenue_cents: revenue.value, gp_pct: gp.value, lead_source: leadSource,
      },
      warnings,
    };
  }

  // ---------- data shaping (ported from dashboard-data.js) ----------
  function buildD(q) {
    const holidays = S.holidaySet;
    const roster = S.roster;
    const fyMonths = S.fyMonths;
    const fyEnd = p.monthEnd(fyMonths[11]);
    const asOf = todayBrisbane();
    const asOfClamped = asOf < C.FY_START ? C.FY_START : asOf > fyEnd ? fyEnd : asOf;
    const currentMonth = p.monthOf(asOfClamped);
    const selMonth = fyMonths.includes(q.get('month')) ? q.get('month') : currentMonth;
    const selDay = isRealDate(q.get('day')) ? q.get('day') : asOfClamped;
    const weekAnchor = isRealDate(q.get('week')) ? q.get('week') : asOfClamped;
    const { mon, fri, sun } = p.weekBounds(weekAnchor);

    const tmap = {};
    for (const t of S.targets) (tmap[t.person] ??= {})[t.month] = t.amount;
    const targetFor = (person) => (month) => tmap[person]?.[month] ?? 0;
    const teamTargetFor = (month) => roster.reduce((s, per) => s + (tmap[per]?.[month] ?? 0), 0);

    const inMonth = (e) => e.entry_date.slice(0, 7) === selMonth;
    const between = (a, b) => S.entries.filter((e) => e.entry_date >= a && e.entry_date <= b);
    const monthEntries = S.entries.filter(inMonth);
    const sumBy = (list, person) => list.filter((e) => e.person === person).reduce((s, e) => s + e.revenue_cents, 0) / 100;
    const weightedGp = (list) => p.weightedGp(list.map((e) => ({ revenue: e.revenue_cents / 100, gp: e.gp_pct })));

    const wdTotal = p.workingDaysInMonth(selMonth, holidays);
    const wdElapsed = p.elapsedWD(selMonth, asOfClamped, holidays);
    const remWD = wdTotal - wdElapsed;

    const monthly = roster.map((person) => {
      const target = targetFor(person)(selMonth);
      const actual = sumBy(monthEntries, person);
      return {
        name: person, target: round2(target), actual: round2(actual),
        pace: round2(p.monthPace(target, selMonth, asOfClamped, holidays)),
        reqDay: remWD > 0 ? round2(p.requiredPerDay(target, actual, remWD)) : null,
        gp: weightedGp(monthEntries.filter((e) => e.person === person)),
      };
    });
    monthly.push({
      name: TEAM_WIN, target: null, actual: round2(sumBy(monthEntries, TEAM_WIN)),
      pace: null, reqDay: null, gp: weightedGp(monthEntries.filter((e) => e.person === TEAM_WIN)), teamWin: true,
    });
    const teamTarget = teamTargetFor(selMonth);
    const teamActual = monthEntries.reduce((s, e) => s + e.revenue_cents, 0) / 100;
    monthly.push({
      name: 'TEAM', target: round2(teamTarget), actual: round2(teamActual),
      pace: round2(p.monthPace(teamTarget, selMonth, asOfClamped, holidays)),
      reqDay: remWD > 0 ? round2(p.requiredPerDay(teamTarget, teamActual, remWD)) : null,
      gp: weightedGp(monthEntries),
    });

    const weekEntries = between(mon, sun);
    const weeklyRaw = roster.map((person) => ({ person, target: p.weeklyTarget(targetFor(person), mon, holidays) }));
    const weekly = weeklyRaw.map((r) => ({ name: r.person, target: round2(r.target), actual: round2(sumBy(weekEntries, r.person)) }));
    const twWeek = sumBy(weekEntries, TEAM_WIN);
    if (twWeek !== 0) weekly.push({ name: TEAM_WIN, target: null, actual: round2(twWeek), teamWin: true });
    weekly.push({
      name: 'TEAM', target: round2(weeklyRaw.reduce((s, r) => s + r.target, 0)),
      actual: round2(weekEntries.reduce((s, e) => s + e.revenue_cents, 0) / 100),
    });

    const dayEntries = between(selDay, selDay);
    const dailyRaw = roster.map((person) => ({ person, target: p.dailyTarget(targetFor(person), selDay, holidays) }));
    const daily = dailyRaw.map((r) => ({ name: r.person, target: round2(r.target), actual: round2(sumBy(dayEntries, r.person)) }));
    const twDay = sumBy(dayEntries, TEAM_WIN);
    if (twDay !== 0) daily.push({ name: TEAM_WIN, target: null, actual: round2(twDay), teamWin: true });
    daily.push({
      name: 'TEAM', target: round2(dailyRaw.reduce((s, r) => s + r.target, 0)),
      actual: round2(dayEntries.reduce((s, e) => s + e.revenue_cents, 0) / 100),
    });

    const fyEntries = between(C.FY_START, fyEnd);
    const ytdRaw = roster.map((person) => ({
      person,
      target: p.ytdProRata(targetFor(person), fyMonths, asOfClamped, holidays),
      fy: fyMonths.reduce((s, m) => s + targetFor(person)(m), 0),
    }));
    const ytd = ytdRaw.map((r) => ({ name: r.person, target: round2(r.target), actual: round2(sumBy(fyEntries, r.person)), fy: round2(r.fy) }));
    const twYtd = sumBy(fyEntries, TEAM_WIN);
    if (twYtd !== 0) ytd.push({ name: TEAM_WIN, target: null, actual: round2(twYtd), fy: null, teamWin: true });
    ytd.push({
      name: 'TEAM', target: round2(ytdRaw.reduce((s, r) => s + r.target, 0)),
      actual: round2(fyEntries.reduce((s, e) => s + e.revenue_cents, 0) / 100),
      fy: round2(ytdRaw.reduce((s, r) => s + r.fy, 0)),
    });

    const mStart = p.monthStart(selMonth);
    const mEnd = p.monthEnd(selMonth);
    const daysInMonth = Number(mEnd.slice(8, 10));
    const wd = [];
    for (let d = mStart; d <= mEnd; d = p.addDays(d, 1)) if (p.isWorkingDay(d, holidays)) wd.push(Number(d.slice(8, 10)));
    const lastDatedDay = selMonth === currentMonth ? Math.min(Number(asOfClamped.slice(8, 10)), daysInMonth)
      : selMonth < currentMonth ? daysInMonth : 0;
    const byDay = new Map();
    for (const e of monthEntries) byDay.set(e.entry_date, (byDay.get(e.entry_date) ?? 0) + e.revenue_cents);
    const dated = [];
    let running = 0;
    for (let i = 1; i <= lastDatedDay; i += 1) {
      running += byDay.get(`${selMonth}-${String(i).padStart(2, '0')}`) ?? 0;
      dated.push(round2(running / 100));
    }

    const curMonthEntries = S.entries.filter((e) => e.entry_date.slice(0, 7) === currentMonth);
    const needFri = p.upcomingFriday(asOfClamped);
    const needWeek = {
      amount: round2(p.needToCloseThisWeek(teamTargetFor(currentMonth), currentMonth, asOfClamped,
        curMonthEntries.reduce((s, e) => s + e.revenue_cents, 0) / 100, holidays)),
      by: ddmm(needFri > p.monthEnd(currentMonth) ? p.monthEnd(currentMonth) : needFri),
    };

    return {
      monthly, weekly, daily, ytd, needWeek,
      cume: { teamTarget: round2(teamTarget), wd, daysInMonth, dated },
      labelsWd: { elapsed: wdElapsed, remaining: remWD },
      meta: { selMonth, selDay, weekAnchor, mon, fri, asOf: asOfClamped, currentMonth },
      orders: monthEntries.map((e) => [ddmm(e.entry_date), e.person, e.customer, e.order_ref ?? '', e.revenue_cents / 100, e.gp_pct]),
    };
  }

  // ---------- views ----------
  function navHtml(active) {
    const link = (path, label) => `<a class="navlink ${active === path ? 'active' : ''}" href="#/${path}">${label}</a>`;
    return `<nav>
      <span class="brand"><img src="img/qis-logo.png" alt="QIS Packaging"></span>
      ${link('dashboard', 'Dashboard')}${link('pipeline', 'Pipeline')}${link('entries', 'Entries')}${link('new', 'Log a sale')}${link('reporting', 'Reporting')}
      <span class="who">${db.isDemo() ? '<b style="color:var(--warn)">preview data</b>' : 'Shared link'}</span>
    </nav>`;
  }

  function renderDashboard(q) {
    const D = buildD(q);
    const M = D.meta;
    const nameCell = (name) => `<a class="pname" href="#/entries?person=${encodeURIComponent(name)}&month=${M.selMonth}">${esc(name)}</a>`;
    const T = D.monthly[D.monthly.length - 1];
    const varAmt = T.actual - T.pace;
    const varPct = T.pace > 0 ? varAmt / T.pace : null;

    const monthOptions = S.fyMonths.map((m) => `<option value="${m}" ${m === M.selMonth ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');

    $('#app').innerHTML = `${navHtml('dashboard')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>${C.FY_LABEL} Sales Dashboard</h1></div>
      <div class="stamp"><b>${monthLabel(M.selMonth)}</b> · ${D.labelsWd.elapsed} of ${D.labelsWd.elapsed + D.labelsWd.remaining} working days gone<br>As at ${dayLabel(M.asOf)} · figures AUD ex-GST</div>
    </header>
    <form class="selectors" id="selform">
      <div><label>Month</label><select name="month">${monthOptions}</select></div>
      <div><label>Day</label><input type="date" name="day" value="${M.selDay}"></div>
      <div><label>Week of</label><input type="date" name="week" value="${M.weekAnchor}"></div>
      <button class="btn small" type="submit">View</button>
    </form>
    <div class="pulse">
      <div><div class="k">Month so far</div><div class="v num">${fmt$(T.actual)}</div><div class="s num">of ${fmt$(T.target)} target</div></div>
      <div><div class="k">On-track target</div><div class="v num">${fmt$(T.pace)}</div><div class="s">after ${D.labelsWd.elapsed} working day${D.labelsWd.elapsed === 1 ? '' : 's'}</div></div>
      <div><div class="k">Versus target</div><div class="v num ${varAmt >= 0 ? 'good' : 'bad'}">${fmt$(varAmt)}</div><div class="s num">${varPct == null ? 'month not started' : pct(varPct) + ' — ' + (varAmt >= 0 ? 'ahead' : 'behind')}</div></div>
      <div><div class="k">Need to close this week</div><div class="v num">${fmt$(D.needWeek.amount)}</div><div class="s">by Fri ${D.needWeek.by} to be on track</div></div>
      <div><div class="k">Needed per day</div><div class="v num">${T.reqDay == null ? '—' : fmt$(T.reqDay)}</div><div class="s">${T.reqDay == null ? 'month finished' : 'for the ' + D.labelsWd.remaining + ' days left'}</div></div>
      <div class="pulsebar"><div class="track">
        <div class="fill" style="width:${T.target > 0 ? Math.min(100, T.actual / T.target * 100) : 0}%"></div>
        <div class="tick" data-label="on track ${fmt$(T.pace)}" style="left:${T.target > 0 ? Math.min(100, T.pace / T.target * 100) : 0}%"></div>
      </div><div class="tracklegend num"><span>$0</span><span>month target ${fmt$(T.target)}</span></div></div>
    </div>
    <h2>The team — ${monthLabel(M.selMonth)}</h2>
    <div class="cards">${D.monthly.slice(0, -1).map((r) => {
      if (r.teamWin) {
        return `<div class="card"><div class="name"><span>${nameCell(r.name)}</span><span class="chip good num">team</span></div>
          <div class="big num">${fmt$(r.actual)}</div><div class="sub">counts to the team total — no individual target</div>
          <div class="kv" style="margin-top:10px"><span>Avg GP%</span><b class="num">${r.gp == null ? '—' : (r.gp * 100).toFixed(1) + '%'}</b></div></div>`;
      }
      const v = r.actual - r.pace; const vp = r.pace > 0 ? v / r.pace : 0; const st = r.pace > 0 ? stateOf(vp) : 'warn';
      const col = st === 'good' ? 'var(--good)' : st === 'warn' ? 'var(--warn)' : 'var(--bad)';
      return `<div class="card"><div class="name"><span>${nameCell(r.name)}</span><span class="chip ${st} num">${r.pace > 0 ? pct(vp) + ' vs target' : 'no pace yet'}</span></div>
        <div class="big num">${fmt$(r.actual)}</div><div class="sub num">of ${fmt$(r.target)} month target</div>
        <div class="ptrack"><div class="fill" style="width:${r.target > 0 ? Math.min(100, r.actual / r.target * 100) : 0}%;background:${col}"></div>
        <div class="tick" style="left:${r.target > 0 ? Math.min(100, r.pace / r.target * 100) : 0}%"></div></div>
        <div class="kv"><span>Needs per day</span><b class="num">${r.reqDay == null ? '—' : fmt$(r.reqDay)}</b></div>
        <div class="kv"><span>Avg GP%</span><b class="num">${r.gp == null ? '—' : (r.gp * 100).toFixed(1) + '%'}</b></div></div>`;
    }).join('')}</div>
    <h2>${monthLabel(M.selMonth)} — cumulative sales vs on-track target</h2>
    <div class="panel"><figure><svg id="cume" viewBox="0 0 960 300" width="100%" role="img" aria-label="Cumulative sales vs on-track target"></svg>
      <figcaption><span style="display:inline-block;width:22px;border-top:3px solid var(--accent);vertical-align:middle;margin-right:6px"></span>Actual (cumulative)
      <span style="display:inline-block;width:22px;border-top:3px dashed var(--ink-soft);vertical-align:middle;margin:0 6px 0 18px"></span>On-track target — <span class="num">${fmt$(D.cume.teamTarget)}</span> by month end</figcaption></figure></div>
    <h2>Week &amp; day</h2>
    <div class="split">
      <div class="panel"><p style="margin:0 0 8px;font-weight:600;font-size:13.5px">Week of Mon ${ddmm(M.mon)} – Fri ${ddmm(M.fri)} <span style="color:var(--ink-soft);font-weight:400">(actuals incl. weekend)</span></p><table id="weekly"></table></div>
      <div class="panel"><p style="margin:0 0 8px;font-weight:600;font-size:13.5px">${dayLabel(M.selDay)}</p><table id="dailyT"></table></div>
    </div>
    <h2>Year to date</h2>
    <div class="panel scroll"><table id="ytd"></table></div>
    <h2>${monthLabel(M.selMonth)} order log — ${D.orders.length} orders</h2>
    <div class="panel scroll"><table id="orders"></table></div>
    <footer>
      <div><b>How it works</b> — targets: monthly team budget split across the team. Pacing: Mon–Fri working days excluding QLD public holidays. Revenue ex-GST.</div>
      <div><b>Logging sales</b> — use “Log a sale” in the menu; the dashboard updates when an entry is saved.</div>
    </footer>`;

    $('#selform').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      go('dashboard', { month: f.get('month'), day: f.get('day'), week: f.get('week') });
    });

    const paceTable = (el, rows, head) => {
      el.innerHTML = `<tr><th>Person</th><th>${head}</th><th>Actual</th><th>Var $</th></tr>` +
        rows.map((r) => {
          const nt = r.target == null; const v = nt ? null : r.actual - r.target;
          const cell = r.name === 'TEAM' ? esc(r.name) : nameCell(r.name);
          return `<tr class="${r.name === 'TEAM' ? 'team' : ''}"><td>${cell}</td><td class="num">${nt ? '—' : fmt$(r.target)}</td>
            <td class="num">${fmt$(r.actual)}</td><td class="num ${nt ? '' : v >= 0 ? 'pos' : 'neg'}">${nt ? '—' : fmt$(v)}</td></tr>`;
        }).join('');
    };
    paceTable($('#weekly'), D.weekly, 'Week target');
    paceTable($('#dailyT'), D.daily, 'Day target');

    $('#ytd').innerHTML = `<tr><th>Person</th><th>YTD target</th><th>YTD actual</th><th>Var $</th><th>Var %</th><th>FY target</th><th>% of FY</th></tr>` +
      D.ytd.map((r) => {
        const nt = r.target == null; const v = nt ? null : r.actual - r.target;
        const cell = r.name === 'TEAM' ? esc(r.name) : nameCell(r.name);
        return `<tr class="${r.name === 'TEAM' ? 'team' : ''}"><td>${cell}</td><td class="num">${nt ? '—' : fmt$(r.target)}</td>
          <td class="num">${fmt$(r.actual)}</td><td class="num ${nt ? '' : v >= 0 ? 'pos' : 'neg'}">${nt ? '—' : fmt$(v)}</td>
          <td class="num ${nt ? '' : v >= 0 ? 'pos' : 'neg'}">${nt ? '—' : r.target > 0 ? pct(v / r.target) : '—'}</td>
          <td class="num">${r.fy == null ? '—' : fmt$(r.fy)}</td>
          <td class="num">${r.fy > 0 ? (r.actual / r.fy * 100).toFixed(1) + '%' : '—'}</td></tr>`;
      }).join('');

    const totRev = D.orders.reduce((s, o) => s + o[4], 0);
    const gpRows = D.orders.filter((o) => o[5] != null);
    $('#orders').innerHTML = `<tr><th>Date</th><th>Person</th><th style="text-align:left">Customer</th><th>Order #</th><th>Revenue</th><th>GP%</th></tr>` +
      D.orders.map((o) => `<tr><td class="num">${o[0]}</td><td>${esc(o[1])}</td><td class="left">${esc(o[2])}</td><td class="num">${esc(o[3])}</td>
        <td class="num">${fmt$2(o[4])}</td><td class="num">${o[5] == null ? '—' : (o[5] * 100).toFixed(1) + '%'}</td></tr>`).join('') +
      (D.orders.length ? `<tr class="team"><td></td><td>TEAM</td><td class="left">${D.orders.length} orders</td><td></td>
        <td class="num">${fmt$2(totRev)}</td><td class="num">${gpRows.length ? (gpRows.reduce((s, o) => s + o[4] * o[5], 0) / gpRows.reduce((s, o) => s + o[4], 0) * 100).toFixed(1) + '%' : '—'}</td></tr>`
        : `<tr><td colspan="6" class="left" style="color:var(--ink-soft)">No orders logged for this month yet.</td></tr>`);

    drawCume(D.cume);
  }

  function drawCume(cume) {
    const svg = $('#cume'); if (!svg) return;
    const W = 960, H = 300, L = 64, R = 18, TP = 18, B = 34;
    const { teamTarget, wd, daysInMonth, dated } = cume;
    if (teamTarget <= 0) { svg.outerHTML = "<p class='sub'>No targets set for this month.</p>"; return; }
    const x = (d) => L + (d - 1) / (daysInMonth - 1) * (W - L - R);
    const y = (v) => H - B - (v / teamTarget) * (H - TP - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = teamTarget * i / 4, yy = y(v);
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#ECE9E1" stroke-width="1"/>` +
        `<text x="${L - 8}" y="${yy + 4}" text-anchor="end" font-size="11.5" fill="#5E6774">$${Math.round(v / 1000)}k</text>`;
    }
    [1, 5, 10, 15, 20, 25, daysInMonth].forEach((d) => { g += `<text x="${x(d)}" y="${H - B + 18}" text-anchor="middle" font-size="11.5" fill="#5E6774">${d}</text>`; });
    g += `<text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle" font-size="11" fill="#8B8E95">day of month</text>`;
    let pacePts = [[x(1), y(0)]];
    let cumWd = 0;
    for (let d = 1; d <= daysInMonth; d++) { if (wd.includes(d)) cumWd++; pacePts.push([x(d), y(teamTarget * cumWd / wd.length)]); }
    g += `<polyline points="${pacePts.map((pt) => pt.join(',')).join(' ')}" fill="none" stroke="#5E6774" stroke-width="2" stroke-dasharray="6 5"/>`;
    if (dated.length && dated.some((v) => v > 0)) {
      const pts = dated.map((v, i) => [x(i + 1), y(Math.min(v, teamTarget * 1.05))]);
      g += `<polyline points="${pts.map((pt) => pt.join(',')).join(' ')}" fill="none" stroke="#B98A3C" stroke-width="3.5" stroke-linecap="round"/>`;
      const [ex, ey] = pts[pts.length - 1];
      g += `<circle cx="${ex}" cy="${ey}" r="5" fill="#B98A3C"/>`;
      g += `<text x="${Math.min(ex + 10, W - 150)}" y="${ey - 8}" font-size="12.5" font-weight="600" fill="#8A6524">${fmt$(dated[dated.length - 1])} MTD</text>`;
    } else if (dated.length) {
      g += `<polyline points="${x(1)},${y(0)} ${x(dated.length)},${y(0)}" fill="none" stroke="#B98A3C" stroke-width="3.5" stroke-linecap="round"/>`;
      g += `<text x="${(L + W - R) / 2}" y="${(TP + H - B) / 2}" text-anchor="middle" font-size="13.5" fill="#8A6524">No sales logged yet this month</text>`;
    }
    svg.innerHTML = g;
  }

  function renderEntries(q) {
    const currentMonth = p.monthOf(todayBrisbane());
    const selMonth = S.fyMonths.includes(q.get('month')) ? q.get('month') : S.fyMonths.includes(currentMonth) ? currentMonth : S.fyMonths[0];
    const personFilter = q.get('person') || '';
    const sourceFilter = q.get('source') || '';
    let rows = S.entries.filter((e) => e.entry_date.slice(0, 7) === selMonth);
    if (personFilter) rows = rows.filter((e) => e.person === personFilter);
    const resolved = (e) => e.lead_source || PENDING;
    if (sourceFilter) rows = rows.filter((e) => resolved(e) === sourceFilter);
    const monthOptions = S.fyMonths.map((m) => `<option value="${m}" ${m === selMonth ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');
    const people = [...S.roster, TEAM_WIN];
    const sourceOpts = [...new Set(S.entries.filter((e) => e.entry_date.slice(0, 7) === selMonth).map(resolved))].sort();

    $('#app').innerHTML = `${navHtml('entries')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>Entries — ${monthLabel(selMonth)}</h1></div>
      <div><button class="btn secondary small" id="csv">Download CSV</button> <a class="btn accent" href="#/new">Log a sale</a></div></header>
    <form class="selectors" id="filterform">
      <div><label>Month</label><select name="month">${monthOptions}</select></div>
      <div><label>Person</label><select name="person"><option value="">Everyone</option>${people.map((pp) => `<option ${pp === personFilter ? 'selected' : ''}>${esc(pp)}</option>`).join('')}</select></div>
      <div><label>Lead source</label><select name="source"><option value="">Any source</option>${sourceOpts.map((s) => `<option ${s === sourceFilter ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <button class="btn small" type="submit">Filter</button>
    </form>
    <div class="panel scroll"><table>
      <tr><th>Date</th><th>Person</th><th class="left">Customer</th><th>Order #</th><th class="left">Lead source</th><th>Revenue</th><th>GP%</th><th></th></tr>
      ${rows.map((e) => `<tr id="entry-${e.id}">
        <td class="num">${ddmmyyyy(e.entry_date)}</td><td>${esc(e.person)}</td><td class="left">${esc(e.customer)}</td>
        <td class="num">${esc(e.order_ref ?? '')}</td>
        <td class="left src-cell">
          <select class="src-select" data-id="${e.id}">
            <option value="">${PENDING}</option>
            ${LEAD_SOURCES.map((s) => `<option ${e.lead_source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </td>
        <td class="num">${fmt$2(e.revenue_cents / 100)}</td>
        <td class="num">${e.gp_pct == null ? '—' : (e.gp_pct * 100).toFixed(1) + '%'}</td>
        <td class="rowactions"><a class="btn small secondary" href="#/edit/${e.id}">Edit</a>
          <button class="btn small danger" data-del="${e.id}">Delete</button></td>
      </tr>`).join('')}
      ${rows.length === 0 ? `<tr><td colspan="8" class="left" style="color:var(--ink-soft)">No entries for this filter.</td></tr>` : ''}
      ${rows.length ? `<tr class="team"><td></td><td>TOTAL</td><td class="left">${rows.length} entries</td><td></td><td></td>
        <td class="num">${fmt$2(rows.reduce((s, e) => s + e.revenue_cents, 0) / 100)}</td><td></td><td></td></tr>` : ''}
    </table></div>`;

    $('#filterform').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      go('entries', { month: f.get('month'), person: f.get('person'), source: f.get('source') });
    });
    $('#csv').addEventListener('click', () => {
      const header = 'Date,Person,Customer,Order #,Lead source,Revenue ex-GST,GP%\n';
      const csvEsc = (v) => (/[",\n\r]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
      const body = rows.map((e) => [e.entry_date, e.person, e.customer, e.order_ref ?? '', resolved(e), (e.revenue_cents / 100).toFixed(2), e.gp_pct == null ? '' : (e.gp_pct * 100).toFixed(2)].map(csvEsc).join(',')).join('\n');
      const blob = new Blob(['﻿' + header + body + '\n'], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `qis-sales-${selMonth}.csv`;
      a.click();
    });
    document.querySelectorAll('.src-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = Number(sel.dataset.id);
        const entry = S.entries.find((e) => e.id === id);
        const val = sel.value || null;
        try {
          await db.updateEntry(id, { lead_source: val }, `web:${entry.person}`);
          entry.lead_source = val;
        } catch (err) { alert(err.message); }
      });
    });
    document.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.del);
        const entry = S.entries.find((e) => e.id === id);
        if (!confirm(`Delete this entry? (${entry.person} — ${entry.customer} — ${fmt$2(entry.revenue_cents / 100)})`)) return;
        try {
          await db.softDelete(id, `web:${entry.person}`);
          S.entries = S.entries.filter((e) => e.id !== id);
          renderEntries(q);
        } catch (err) { alert(err.message); }
      });
    });
  }

  function renderForm(q, editingId = null) {
    const editing = editingId != null;
    const existing = editing ? S.entries.find((e) => e.id === editingId) : null;
    if (editing && !existing) { go('entries'); return; }
    const f = existing ? {
      entry_date: existing.entry_date, person: existing.person, customer: existing.customer,
      order_ref: existing.order_ref ?? '', revenue: (existing.revenue_cents / 100).toFixed(2),
      gp_pct: existing.gp_pct == null ? '' : (existing.gp_pct * 100).toFixed(2),
      lead_source: existing.lead_source ?? '',
    } : {
      entry_date: todayBrisbane(), person: q.get('person') || '', customer: q.get('customer') || '',
      order_ref: q.get('order_ref') || '', revenue: q.get('revenue') || '', gp_pct: q.get('gp') || '',
      lead_source: LEAD_SOURCES.includes(q.get('lead')) ? q.get('lead') : '',
    };
    const fromQuote = !editing && q.get('from_quote') ? Number(q.get('from_quote')) : null;

    $('#app').innerHTML = `${navHtml('new')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>${editing ? 'Edit entry' : 'Log a sale'}</h1></div></header>
    ${fromQuote ? '<div class="flow"><b>Logging a quote win</b> — details are pre-filled from the quote; adjust the final figures if they changed, and saving will mark the quote as won.</div>' : ''}
    <div id="formmsg"></div>
    <form id="entryform">
      <div class="formgrid">
        <div class="field"><label>Date</label><input type="date" name="entry_date" value="${f.entry_date}" required></div>
        <div class="field"><label>Team member</label>
          <select name="person" required>
            <option value="" disabled ${!f.person ? 'selected' : ''}>Choose your name…</option>
            ${S.roster.map((pp) => `<option ${pp === f.person ? 'selected' : ''}>${esc(pp)}</option>`).join('')}
            <option value="${TEAM_WIN}" ${f.person === TEAM_WIN ? 'selected' : ''}>Team Win — general order, not one person</option>
          </select>
          <div class="hint">Pick your name so the sale is credited to you, or “Team Win” for a general order.</div></div>
        <div class="field"><label>Customer</label><input name="customer" value="${esc(f.customer)}" required maxlength="200" placeholder="e.g. Fresh Gro"></div>
        <div class="field"><label>Sales order / quote #</label><input name="order_ref" value="${esc(f.order_ref)}" maxlength="50" placeholder="e.g. 1196 or SQ#565"></div>
        <div class="field"><label>Revenue (AUD, ex-GST)</label><input name="revenue" value="${esc(f.revenue)}" required inputmode="decimal" placeholder="e.g. 2999.00"></div>
        <div class="field"><label>GP%</label><input name="gp_pct" value="${esc(f.gp_pct)}" inputmode="decimal" placeholder="e.g. 40 or 0.40"><div class="hint">Optional — leave blank if not known yet.</div></div>
        <div class="field"><label>Lead source</label>
          <select name="lead_source"><option value="">${PENDING} (set later)</option>
          ${LEAD_SOURCES.map((s) => `<option ${f.lead_source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      </div>
      <div class="actions"><button class="btn accent" type="submit">${editing ? 'Save changes' : 'Save sale'}</button>
        <a class="btn secondary" href="#/entries">Cancel</a></div>
    </form>`;

    let confirmed = false;
    $('#entryform').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const parsed = parseEntryForm(Object.fromEntries(fd.entries()));
      const msg = $('#formmsg');
      if (parsed.errors) {
        msg.innerHTML = `<div class="errors"><b>Fix these before saving:</b><ul>${parsed.errors.map((e2) => `<li>${esc(e2)}</li>`).join('')}</ul></div>`;
        return;
      }
      const dup = parsed.value.order_ref
        ? S.entries.find((e) => e.order_ref === parsed.value.order_ref && e.id !== editingId) : null;
      if (!confirmed && (dup || parsed.warnings.length)) {
        confirmed = true;
        msg.innerHTML = `<div class="warnbox"><b>Check before saving:</b><ul>
          ${dup ? `<li>Order #${esc(parsed.value.order_ref)} is already logged: ${ddmmyyyy(dup.entry_date)} — ${esc(dup.person)} — ${esc(dup.customer)} — ${fmt$2(dup.revenue_cents / 100)}.</li>` : ''}
          ${parsed.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}
        </ul>Press the save button again to record it anyway.</div>`;
        return;
      }
      try {
        if (editing) await db.updateEntry(editingId, parsed.value, `web:${parsed.value.person}`);
        else {
          const newId = await db.createEntry(parsed.value, `web:${parsed.value.person}`);
          if (fromQuote) {
            // the Won flow: the quote is marked won only once the sale is saved
            await db.updateQuote(fromQuote, { status: 'won', status_date: parsed.value.entry_date, won_entry_id: newId, loss_reason: null }, `web:${parsed.value.person}`);
          }
        }
        await reload();
        if (fromQuote) { go('pipeline'); return; }
        go('entries', { month: parsed.value.entry_date.slice(0, 7) });
      } catch (err) {
        msg.innerHTML = `<div class="errors">Could not save: ${esc(err.message)}</div>`;
      }
    });
  }

  // ---------- reporting (lead source) ----------
  function periodRange(period, asOf) {
    const cur = p.monthOf(asOf);
    if (period === 'week') { const { mon, sun } = p.weekBounds(asOf); return { start: mon, end: sun, label: `This week · Mon ${ddmm(mon)} – Sun ${ddmm(sun)}` }; }
    if (period === 'lastmonth') { const lm = p.addMonths(cur, -1); return { start: p.monthStart(lm), end: p.monthEnd(lm), label: `Last month · ${monthLabel(lm)}` }; }
    if (period === 'fytd') { return { start: C.FY_START, end: asOf, label: 'FY to date' }; }
    return { start: p.monthStart(cur), end: asOf, label: `Month to date · ${monthLabel(cur)}` };
  }

  function renderReporting(q) {
    const asOf = todayBrisbane();
    const period = ['week', 'mtd', 'lastmonth', 'fytd'].includes(q.get('period')) ? q.get('period') : 'mtd';
    const personFilter = q.get('person') || '';
    const { start, end, label } = periodRange(period, asOf < C.FY_START ? C.FY_START : asOf);

    let rows = S.entries.filter((e) => e.entry_date >= start && e.entry_date <= end);
    if (personFilter) rows = rows.filter((e) => e.person === personFilter);

    const groups = new Map();
    for (const e of rows) {
      const src = e.lead_source || PENDING;
      const g = groups.get(src) || { src, revenue: 0, orders: 0, gpDollars: 0, revWithGp: 0 };
      const rev = e.revenue_cents / 100;
      g.revenue += rev; g.orders += 1;
      if (e.gp_pct != null) { g.gpDollars += rev * e.gp_pct; g.revWithGp += rev; }
      groups.set(src, g);
    }
    const list = [...groups.values()].map((g) => ({
      ...g, type: sourceType(g.src),
      avgGp: g.revWithGp > 0 ? g.gpDollars / g.revWithGp : null,
      avgDeal: g.orders > 0 ? g.revenue / g.orders : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    const tot = list.reduce((a, g) => ({
      revenue: a.revenue + g.revenue, orders: a.orders + g.orders,
      gpDollars: a.gpDollars + g.gpDollars, revWithGp: a.revWithGp + g.revWithGp,
    }), { revenue: 0, orders: 0, gpDollars: 0, revWithGp: 0 });
    const bucket = (t) => list.filter((g) => g.type === t).reduce((a, g) => ({ revenue: a.revenue + g.revenue, orders: a.orders + g.orders }), { revenue: 0, orders: 0 });
    const inb = bucket('in'); const outb = bucket('out'); const pend = bucket('pend');
    const share = (v) => (tot.revenue > 0 ? (v / tot.revenue * 100).toFixed(0) + '%' : '—');
    const avgGpTot = tot.revWithGp > 0 ? tot.gpDollars / tot.revWithGp : null;
    const maxRev = list.length ? list[0].revenue : 1;
    const people = [...S.roster, TEAM_WIN];
    const segBtn = (val, txt) => `<button data-period="${val}" class="${period === val ? 'on' : ''}">${txt}</button>`;

    $('#app').innerHTML = `${navHtml('reporting')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>Reporting — Lead Source</h1></div>
      <div class="stamp">Where our won revenue comes from<br>Figures AUD ex-GST · as at ${dayLabel(asOf)}</div></header>
    <div class="selectors">
      <div><label>Period</label><span class="seg" id="periodseg">
        ${segBtn('week', 'This week')}${segBtn('mtd', 'Month to date')}${segBtn('lastmonth', 'Last month')}${segBtn('fytd', 'FY to date')}
      </span></div>
      <div><label>Person</label><select id="repperson"><option value="">Everyone</option>
        ${people.map((pp) => `<option ${pp === personFilter ? 'selected' : ''}>${esc(pp)}</option>`).join('')}</select></div>
      <div style="align-self:center;color:var(--ink-soft);font-size:12.5px;padding-top:14px">${esc(label)}</div>
    </div>
    ${tot.orders === 0 ? `<div class="panel" style="margin-top:12px;color:var(--ink-soft)">No won sales in this period${personFilter ? ' for ' + esc(personFilter) : ''} yet.</div>` : `
    <div class="tiles" style="margin-top:12px">
      <div class="tile"><div class="k">Won</div><div class="v num">${fmt$(tot.revenue)}</div><div class="s num">${tot.orders} order${tot.orders === 1 ? '' : 's'}</div></div>
      <div class="tile"><div class="k">Gross profit</div><div class="v num">${fmt$(tot.gpDollars)}</div><div class="s num">${avgGpTot == null ? '—' : (avgGpTot * 100).toFixed(1) + '% avg GP'}</div></div>
      <div class="tile"><div class="k">Inbound</div><div class="v num">${share(inb.revenue)}</div><div class="s num">${fmt$(inb.revenue)} · ${inb.orders} orders</div></div>
      <div class="tile"><div class="k">Outbound (rep-generated)</div><div class="v num">${share(outb.revenue)}</div><div class="s num">${fmt$(outb.revenue)} · ${outb.orders} orders</div></div>
    </div>
    <h2>Revenue by lead source</h2>
    <div class="panel"><div class="bars">
      ${list.map((g) => `<div class="barrow"><span class="lbl">${g.src === PENDING ? 'Pending Source' : esc(g.src)}</span>
        <div class="bartrack"><div class="barfill ${g.type}" style="width:${Math.max(2, g.revenue / maxRev * 100)}%"></div></div>
        <span class="barval">${fmt$(g.revenue)} · ${share(g.revenue)}</span></div>`).join('')}
    </div><p style="margin:14px 0 0;font-size:12px" class="muted"><span class="chip in">Inbound</span> came to us · <span class="chip out">Outbound</span> rep-generated · <span class="chip pend">Pending</span> source not set</p></div>
    <h2>Full breakdown</h2>
    <div class="panel scroll"><table>
      <tr><th class="left">Lead source</th><th>Type</th><th>Revenue</th><th>% of won</th><th>Orders</th><th>GP $</th><th>Avg GP%</th><th>Avg deal</th></tr>
      ${list.map((g) => `<tr><td class="left">${g.src === PENDING ? '<span class="src-pending">Pending Source</span>' : esc(g.src)}</td>
        <td><span class="chip ${g.type}">${g.type === 'in' ? 'Inbound' : g.type === 'out' ? 'Outbound' : '—'}</span></td>
        <td class="num">${fmt$(g.revenue)}</td><td class="num">${share(g.revenue)}</td><td class="num">${g.orders}</td>
        <td class="num">${g.revWithGp > 0 ? fmt$(g.gpDollars) : '—'}</td>
        <td class="num">${g.avgGp == null ? '—' : (g.avgGp * 100).toFixed(1) + '%'}</td>
        <td class="num">${fmt$(g.avgDeal)}</td></tr>`).join('')}
      <tr class="team"><td class="left">TOTAL</td><td></td><td class="num">${fmt$(tot.revenue)}</td><td class="num">100%</td><td class="num">${tot.orders}</td>
        <td class="num">${fmt$(tot.gpDollars)}</td><td class="num">${avgGpTot == null ? '—' : (avgGpTot * 100).toFixed(1) + '%'}</td>
        <td class="num">${fmt$(tot.orders > 0 ? tot.revenue / tot.orders : 0)}</td></tr>
    </table></div>
    ${pend.orders > 0 ? `<div class="note"><b>${pend.orders} win${pend.orders === 1 ? '' : 's'} (${fmt$(pend.revenue)}) still on “Pending Source”.</b>
      <a href="#/entries?month=${p.monthOf(end)}&source=${encodeURIComponent(PENDING)}">Set their source on the Entries tab →</a></div>` : ''}
    `}${(() => {
      // ---- loss analysis (from pipeline quotes, same period) ----
      const lost = (S.quotes || []).filter((x) => x.status === 'lost' && x.status_date && x.status_date >= start && x.status_date <= end && (!personFilter || x.person === personFilter));
      if (!lost.length) return `<h2>Lost quotes — ${esc(label)}</h2><div class="panel" style="color:var(--ink-soft)">No lost quotes recorded in this period. Loss reasons build here as the team marks quotes Lost on the Pipeline tab.</div>`;
      const byR = new Map();
      for (const x of lost) {
        const r2 = x.loss_reason || 'No reason recorded';
        const g = byR.get(r2) || { r: r2, v: 0, n: 0 };
        g.v += x.value_cents / 100; g.n += 1; byR.set(r2, g);
      }
      const lst = [...byR.values()].sort((a, b) => b.v - a.v);
      const mx = lst[0].v || 1;
      const totL = lst.reduce((s, g) => s + g.v, 0);
      return `<h2>Lost quotes — why we lose (${esc(label)})</h2>
      <div class="panel"><div class="bars">${lst.map((g) => `<div class="barrow"><span class="lbl">${esc(g.r)}</span>
        <div class="bartrack"><div class="barfill pend" style="width:${Math.max(2, g.v / mx * 100)}%;background:var(--bad)"></div></div>
        <span class="barval">${fmt$(g.v)} · ${g.n}</span></div>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:12px 0 0">Total lost: ${fmt$(totL)} across ${lost.length} quote${lost.length === 1 ? '' : 's'} · <a class="pname" href="#/pipeline?status=lost">see the lost list →</a></p></div>`;
    })()}`;

    document.querySelectorAll('#periodseg button').forEach((b) => b.addEventListener('click', () => go('reporting', { period: b.dataset.period, person: personFilter })));
    $('#repperson').addEventListener('change', (ev) => go('reporting', { period, person: ev.target.value }));
  }

  // ---------- pipeline ----------
  let lostPendingId = null; // quote id currently showing the loss-reason prompt

  function renderPipeline(q) {
    const asOf = todayBrisbane();
    const status = ['open', 'won', 'lost', 'withdrawn', 'all'].includes(q.get('status')) ? q.get('status') : 'open';
    const personFilter = q.get('person') || '';
    const ageFilter = q.get('age') || '';
    const sort = ['oldest', 'newest', 'value'].includes(q.get('sort')) ? q.get('sort') : 'oldest';
    const search = (q.get('find') || '').trim();
    const monthFilter = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : '';
    const params = (over) => ({ status, person: personFilter, age: ageFilter, sort, find: search, month: monthFilter, ...over });

    if (db.quotesUnavailable()) {
      $('#app').innerHTML = `${navHtml('pipeline')}
        <header class="page"><div><p class="eyebrow">Sales Team</p><h1>Pipeline</h1></div></header>
        <div class="panel" style="color:var(--ink-soft)">The pipeline isn't set up in the database yet — the quotes table is missing. (Liam: run the pipeline SQL in Supabase, then refresh.)</div>`;
      return;
    }

    const open = S.quotes.filter((x) => x.status === 'open');
    const aged = (x) => ageOf(x, asOf);
    const sumV = (list) => list.reduce((s, x) => s + x.value_cents, 0) / 100;
    const buckets = AGE_BUCKETS.map((b) => {
      const inB = open.filter((x) => { const d = aged(x); return d >= b.min && d <= b.max; });
      return { ...b, count: inB.length, value: sumV(inB) };
    });
    const aged60 = buckets[3];
    const avgDays = open.length ? Math.round(open.reduce((s, x) => s + aged(x), 0) / open.length) : 0;
    const fyEnd = p.monthEnd(S.fyMonths[11]);
    const decided = S.quotes.filter((x) => (x.status === 'won' || x.status === 'lost') && x.status_date && x.status_date >= C.FY_START && x.status_date <= fyEnd);
    const wonV = sumV(decided.filter((x) => x.status === 'won'));
    const decV = sumV(decided);
    const winRate = decV > 0 ? (wonV / decV * 100).toFixed(0) + '%' : '—';

    let rows = status === 'all' ? [...S.quotes] : S.quotes.filter((x) => x.status === status);
    if (personFilter) rows = rows.filter((x) => x.person === personFilter);
    if (ageFilter) rows = rows.filter((x) => bucketOf(aged(x)).key === ageFilter);
    if (monthFilter) rows = rows.filter((x) => ((status === 'open' || status === 'all') ? x.quote_date : (x.status_date || x.quote_date)).slice(0, 7) === monthFilter);
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter((x) => [x.customer, x.quote_ref, x.notes, x.person].some((v) => v && v.toLowerCase().includes(s)));
    }
    rows.sort((a, b) => sort === 'value' ? b.value_cents - a.value_cents
      : sort === 'newest' ? b.quote_date.localeCompare(a.quote_date)
      : a.quote_date.localeCompare(b.quote_date));

    const noteCell = (x) => `<td class="left qnote" ${x.notes ? `data-note="${esc(x.notes)}"` : ''}><a class="pname" href="#/quote-edit/${x.id}">${x.notes ? esc(x.notes.slice(0, 46)) + (x.notes.length > 46 ? '…' : '') : '<span class=muted>+ add note</span>'}</a></td>`;
    const ddmmyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
    const isOpenView = status === 'open';

    $('#app').innerHTML = `${navHtml('pipeline')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>Pipeline</h1></div>
      <div><a class="btn accent" href="#/quote-new">+ Add a quote</a></div></header>
    <div class="tiles">
      <div class="tile"><div class="k">Open pipeline</div><div class="v num">${fmt$(sumV(open))}</div><div class="s num">${open.length} quotes</div></div>
      <div class="tile alert"><div class="k">Aged 60+ days</div><div class="v num">${fmt$(aged60.value)}</div><div class="s num">${aged60.count} quotes — needs attention</div></div>
      <div class="tile"><div class="k">Avg days open</div><div class="v num">${avgDays}</div><div class="s">across open quotes</div></div>
      <div class="tile"><div class="k">Win rate (FY)</div><div class="v num">${winRate}</div><div class="s">${decV > 0 ? 'by value, of decided quotes' : 'builds as outcomes are recorded'}</div></div>
    </div>
    <h2>Aging — click a bucket to filter</h2>
    <div class="agerow">${buckets.map((b) => `
      <a class="abucket ${b.cls} ${ageFilter === b.key ? 'onb' : ''}" href="#/pipeline?${new URLSearchParams(params({ age: ageFilter === b.key ? '' : b.key, status: 'open' }))}">
        <div class="lbl">${b.label}</div><div class="amt num">${fmt$(b.value)}</div><div class="ct num">${b.count} quotes</div></a>`).join('')}
    </div>
    <div class="selectors">
      <div><label>Search</label><input id="pf-find" value="${esc(search)}" placeholder="customer, quote #, note…" style="font:inherit;font-size:13.5px;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:#FFFDF8;width:180px"></div>
      <div><label>Status</label><select id="pf-status">${['open', 'won', 'lost', 'withdrawn', 'all'].map((s2) => `<option value="${s2}" ${s2 === status ? 'selected' : ''}>${s2[0].toUpperCase() + s2.slice(1)}</option>`).join('')}</select></div>
      <div><label>Month</label><select id="pf-month"><option value="">All months</option>${S.fyMonths.map((m) => `<option value="${m}" ${m === monthFilter ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select></div>
      <div><label>Person</label><select id="pf-person"><option value="">Everyone</option>${S.roster.map((pp) => `<option ${pp === personFilter ? 'selected' : ''}>${esc(pp)}</option>`).join('')}</select></div>
      <div><label>Sort</label><select id="pf-sort">${[['oldest', 'Oldest first'], ['newest', 'Newest first'], ['value', 'Highest value']].map(([v, t]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <span class="hintline">Filters are yours alone</span>
    </div>
    <h2>${status === 'all' ? 'All quotes' : status[0].toUpperCase() + status.slice(1) + ' quotes'} — ${rows.length}</h2>
    <div class="panel scroll"><table>
      <tr><th class="tight">Quote #</th><th class="tight">Quoted</th><th class="tight">Age</th><th class="left">Customer</th><th class="tight">Person</th><th class="tight">Value</th><th class="tight">Source</th><th class="left">Notes / follow-ups</th>
        ${isOpenView ? '<th class="tight" style="text-align:left">Status</th>' : status === 'lost' ? '<th class="left">Reason</th><th class="tight">Lost on</th><th class="tight">Came back?</th>' : '<th>Status</th><th class="tight">On</th><th class="tight"></th>'}</tr>
      ${rows.map((x) => {
        const d = aged(x); const bk = bucketOf(d);
        const base = `<td class="num left tight">${esc(x.quote_ref ?? '')}</td><td class="num tight">${ddmmyy(x.quote_date)}</td>
          <td class="tight"><span class="age ${bk.chip}">${d} days</span></td><td class="left">${esc(x.customer)}</td><td class="tight">${esc(x.person)}</td>
          <td class="num tight">${fmt$(x.value_cents / 100)}</td>
          <td class="tight"><select class="src-select qsrc" data-id="${x.id}" style="max-width:130px">
            <option value="" ${!x.lead_source ? 'selected' : ''}>—</option>
            ${LEAD_SOURCES.map((s2) => `<option ${x.lead_source === s2 ? 'selected' : ''}>${esc(s2)}</option>`).join('')}
          </select></td>${noteCell(x)}`;
        if (isOpenView) {
          const actions = lostPendingId === x.id
            ? `<div class="reason">Why lost? <select id="lr-${x.id}">${LOSS_REASONS.map((r2) => `<option>${r2}</option>`).join('')}</select>
                <button class="btn lost confirm-lost" data-id="${x.id}" style="background:var(--bad);color:#fff;border:none">Confirm</button>
                <button class="btn wd cancel-lost">Cancel</button></div>`
            : `<select class="src-select qstatus" data-id="${x.id}">
                <option value="" selected>Open</option>
                <option value="won">Won ✓</option>
                <option value="lost">Lost…</option>
                <option value="withdrawn">Withdrawn</option>
                <option value="reissued">Reissued — reset age</option>
              </select>`;
          return `<tr>${base}<td>${actions}</td></tr>`;
        }
        const revive = x.status === 'open' ? '' : `<select class="src-select qrevive" data-id="${x.id}">
          <option value="" selected>—</option><option value="won">Won ✓ — convert it</option><option value="reopen">Reopen to pipeline</option></select>`;
        if (status === 'lost') return `<tr>${base}<td class="left"><select class="src-select qreason" data-id="${x.id}" style="max-width:150px">
          <option value="" ${!x.loss_reason ? 'selected' : ''}>no reason — set one</option>
          ${LOSS_REASONS.map((r2) => `<option ${x.loss_reason === r2 ? 'selected' : ''}>${esc(r2)}</option>`).join('')}
        </select></td><td class="num">${x.status_date ? ddmmyy(x.status_date) : '—'}</td><td>${revive}</td></tr>`;
        return `<tr>${base}<td>${esc(x.status)}</td><td class="num">${x.status_date ? ddmmyy(x.status_date) : '—'}</td><td>${revive}</td></tr>`;
      }).join('')}
      ${rows.length === 0 ? '<tr><td colspan="11" class="left" style="color:var(--ink-soft)">No quotes match this filter.</td></tr>' : ''}
      ${rows.length ? `<tr class="team"><td></td><td>TOTAL</td><td></td><td class="left">${rows.length} quotes</td><td></td><td class="num">${fmt$(sumV(rows))}</td><td></td><td></td>${isOpenView ? '<td></td>' : '<td></td><td></td><td></td>'}</tr>` : ''}
    </table>
    ${isOpenView ? '<div class="flow">Change a quote’s <b>Status</b> from the dropdown: <b>Won</b> opens “Log a sale” pre-filled (marked won when the sale saves) · <b>Lost</b> asks for a reason · <b>Withdrawn</b> = customer cancelled · <b>Reissued</b> resets its age to today.</div>' : ''}
    </div>`;

    const refresh = (over) => go('pipeline', params(over));
    $('#pf-find').addEventListener('change', (ev) => refresh({ find: ev.target.value }));
    $('#pf-find').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); refresh({ find: ev.target.value }); } });
    $('#pf-month').addEventListener('change', (ev) => refresh({ month: ev.target.value }));
    $('#pf-status').addEventListener('change', (ev) => refresh({ status: ev.target.value, age: '' }));
    $('#pf-person').addEventListener('change', (ev) => refresh({ person: ev.target.value }));
    $('#pf-sort').addEventListener('change', (ev) => refresh({ sort: ev.target.value }));
    document.querySelectorAll('.qstatus').forEach((sel) => sel.addEventListener('change', async () => {
      const x = S.quotes.find((z) => z.id === Number(sel.dataset.id));
      const choice = sel.value;
      sel.value = ''; // snap back; real state changes only on confirm
      if (choice === 'won') {
        go('new', { from_quote: x.id, person: S.roster.includes(x.person) ? x.person : '', customer: x.customer,
          order_ref: x.quote_ref ?? '', revenue: (x.value_cents / 100).toFixed(2), gp: x.gp_pct == null ? '' : (x.gp_pct * 100).toFixed(1), lead: x.lead_source ?? '' });
      } else if (choice === 'lost') {
        lostPendingId = x.id; renderPipeline(q);
      } else if (choice === 'withdrawn') {
        if (!confirm(`Mark "${x.customer}" (${fmt$(x.value_cents / 100)}) as withdrawn?`)) return;
        try {
          await db.updateQuote(x.id, { status: 'withdrawn', status_date: asOf }, `web:${x.person}`);
          x.status = 'withdrawn'; x.status_date = asOf; renderPipeline(q);
        } catch (err) { alert(err.message); }
      } else if (choice === 'reissued') {
        if (!confirm(`Reissued "${x.customer}"? This resets its age — quote date becomes today.`)) return;
        const stamp = `Reissued ${asOf.slice(8, 10)}.${asOf.slice(5, 7)}`;
        const notes = x.notes ? `${x.notes} | ${stamp}` : stamp;
        try {
          await db.updateQuote(x.id, { quote_date: asOf, notes }, `web:${x.person}`);
          x.quote_date = asOf; x.notes = notes; renderPipeline(q);
        } catch (err) { alert(err.message); }
      }
    }));
    document.querySelectorAll('.qreason').forEach((sel) => sel.addEventListener('change', async () => {
      const x = S.quotes.find((z) => z.id === Number(sel.dataset.id));
      const val = sel.value || null;
      try { await db.updateQuote(x.id, { loss_reason: val }, `web:${x.person}`); x.loss_reason = val; }
      catch (err) { alert(err.message); sel.value = x.loss_reason ?? ''; }
    }));
    document.querySelectorAll('.qsrc').forEach((sel) => sel.addEventListener('change', async () => {
      const x = S.quotes.find((z) => z.id === Number(sel.dataset.id));
      const val = sel.value || null;
      try { await db.updateQuote(x.id, { lead_source: val }, `web:${x.person}`); x.lead_source = val; }
      catch (err) { alert(err.message); sel.value = x.lead_source ?? ''; }
    }));
    document.querySelectorAll('.cancel-lost').forEach((b) => b.addEventListener('click', () => { lostPendingId = null; renderPipeline(q); }));
    document.querySelectorAll('.qrevive').forEach((sel) => sel.addEventListener('change', async () => {
      const x = S.quotes.find((z) => z.id === Number(sel.dataset.id));
      const choice = sel.value;
      sel.value = '';
      if (choice === 'won') {
        go('new', { from_quote: x.id, person: S.roster.includes(x.person) ? x.person : '', customer: x.customer,
          order_ref: x.quote_ref ?? '', revenue: (x.value_cents / 100).toFixed(2), gp: x.gp_pct == null ? '' : (x.gp_pct * 100).toFixed(1), lead: x.lead_source ?? '' });
      } else if (choice === 'reopen') {
        if (!confirm(`Reopen "${x.customer}" (${fmt$(x.value_cents / 100)})? It returns to the open pipeline with today as its quote date.`)) return;
        const stamp = `Reopened ${asOf.slice(8, 10)}.${asOf.slice(5, 7)}${x.loss_reason ? ` (was lost: ${x.loss_reason})` : x.status === 'withdrawn' ? ' (was withdrawn)' : ''}`;
        const notes = x.notes ? `${x.notes} | ${stamp}` : stamp;
        try {
          await db.updateQuote(x.id, { status: 'open', quote_date: asOf, status_date: null, loss_reason: null, notes }, `web:${x.person}`);
          x.status = 'open'; x.quote_date = asOf; x.status_date = null; x.loss_reason = null; x.notes = notes;
          renderPipeline(q);
        } catch (err) { alert(err.message); }
      }
    }));
    document.querySelectorAll('.confirm-lost').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.id);
      const reason = document.querySelector(`#lr-${id}`).value;
      const x = S.quotes.find((z) => z.id === id);
      try {
        await db.updateQuote(id, { status: 'lost', loss_reason: reason, status_date: asOf }, `web:${x.person}`);
        x.status = 'lost'; x.loss_reason = reason; x.status_date = asOf; lostPendingId = null;
        renderPipeline(q);
      } catch (err) { alert(err.message); }
    }));
  }

  function renderQuoteForm(q, editId = null) {
    const editing = editId != null;
    const existing = editing ? S.quotes.find((x) => x.id === editId) : null;
    if (editing && !existing) { go('pipeline'); return; }
    const f = existing ? {
      quote_ref: existing.quote_ref ?? '', quote_date: existing.quote_date, customer: existing.customer,
      person: existing.person, value: (existing.value_cents / 100).toFixed(2),
      gp_pct: existing.gp_pct == null ? '' : (existing.gp_pct * 100).toFixed(1), notes: existing.notes ?? '',
      lead_source: existing.lead_source ?? '',
    } : { quote_ref: '', quote_date: todayBrisbane(), customer: '', person: '', value: '', gp_pct: '', notes: '', lead_source: '' };

    $('#app').innerHTML = `${navHtml('pipeline')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>${editing ? 'Edit quote' : 'Add a quote'}</h1></div>
      ${editing ? `<button class="btn danger small" id="delquote">Delete quote</button>` : ''}</header>
    <div id="qmsg"></div>
    <form id="quoteform"><div class="formgrid">
      <div class="field"><label>Quote #</label><input name="quote_ref" value="${esc(f.quote_ref)}" maxlength="40" placeholder="e.g. SQ#684"></div>
      <div class="field"><label>Quote date</label><input type="date" name="quote_date" value="${f.quote_date}" required></div>
      <div class="field"><label>Customer</label><input name="customer" value="${esc(f.customer)}" required maxlength="200"></div>
      <div class="field"><label>Salesperson</label><select name="person" required>
        <option value="" disabled ${!f.person ? 'selected' : ''}>Choose…</option>
        ${S.roster.map((pp) => `<option ${pp === f.person ? 'selected' : ''}>${esc(pp)}</option>`).join('')}
        ${f.person && !S.roster.includes(f.person) ? `<option selected>${esc(f.person)}</option>` : ''}
      </select></div>
      <div class="field"><label>Quote value (AUD, ex-GST)</label><input name="value" value="${esc(f.value)}" required inputmode="decimal" placeholder="e.g. 4500.00"></div>
      <div class="field"><label>GP% (optional)</label><input name="gp_pct" value="${esc(f.gp_pct)}" inputmode="decimal" placeholder="e.g. 45"></div>
      <div class="field"><label>Lead source</label><select name="lead_source">
        <option value="" ${!f.lead_source ? 'selected' : ''}>Not set</option>
        ${LEAD_SOURCES.map((s2) => `<option ${f.lead_source === s2 ? 'selected' : ''}>${esc(s2)}</option>`).join('')}
      </select><div class="hint">Carries onto the sale when this quote is won.</div></div>
      <div class="field" style="grid-column:1/-1"><label>Notes / follow-ups</label>
        <textarea name="notes" rows="3" style="font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:5px;background:#FFFDF8">${esc(f.notes)}</textarea>
        <div class="hint">The follow-up log — e.g. "LN 30.07 sent quote | 05.08 followed up".</div></div>
    </div>
    <div class="actions"><button class="btn accent" type="submit">${editing ? 'Save changes' : 'Add quote'}</button>
      <a class="btn secondary" href="#/pipeline">Cancel</a></div></form>`;

    $('#quoteform').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target).entries());
      const errs = [];
      if (!isRealDate(fd.quote_date)) errs.push('A valid quote date is required.');
      if (!String(fd.customer).trim()) errs.push('Customer is required.');
      if (!fd.person) errs.push('Pick a salesperson.');
      const cleaned = String(fd.value).trim().replace(/[$,\s]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) errs.push('Quote value must be a positive amount (ex-GST).');
      const gpS = String(fd.gp_pct ?? '').trim().replace(/%$/, '');
      let gp = null;
      if (gpS !== '') {
        const n = Number(gpS);
        if (!Number.isFinite(n) || n < 0 || n > 100) errs.push('GP% must be between 0 and 100.');
        else gp = n <= 1 ? n : n / 100;
      }
      if (errs.length) { $('#qmsg').innerHTML = `<div class="errors"><ul>${errs.map((e2) => `<li>${esc(e2)}</li>`).join('')}</ul></div>`; return; }
      const fields = {
        quote_ref: String(fd.quote_ref).trim() || null, quote_date: fd.quote_date,
        customer: String(fd.customer).trim(), person: fd.person,
        value_cents: Math.round(parseFloat(cleaned) * 100), gp_pct: gp, notes: String(fd.notes ?? '').trim() || null,
        lead_source: LEAD_SOURCES.includes(fd.lead_source) ? fd.lead_source : null,
      };
      try {
        if (editing) await db.updateQuote(editId, fields, `web:${fields.person}`);
        else await db.createQuote({ ...fields, status: 'open' }, `web:${fields.person}`);
        await reload();
        go('pipeline');
      } catch (err) { $('#qmsg').innerHTML = `<div class="errors">Could not save: ${esc(err.message)}</div>`; }
    });
    if (editing) {
      $('#delquote').addEventListener('click', async () => {
        if (!confirm(`Delete quote "${existing.customer}" entirely? (Use Lost/Withdrawn for real outcomes — delete is for mistakes.)`)) return;
        try { await db.softDeleteQuote(editId, `web:${existing.person}`); await reload(); go('pipeline'); }
        catch (err) { alert(err.message); }
      });
    }
  }

  // ---------- boot ----------
  async function reload() {
    const [data, quotes] = await Promise.all([db.loadAll(), db.loadQuotes()]);
    S = {
      entries: data.entries,
      targets: data.targets,
      roster: data.roster,
      holidaySet: new Set(data.holidays.map((h) => h.date)),
      fyMonths: p.fyMonthsFrom(C.FY_START),
      quotes,
    };
  }

  async function route() {
    if (!S) await reload();
    const { path, q } = hashParts();
    if (path === 'entries') renderEntries(q);
    else if (path === 'reporting') renderReporting(q);
    else if (path === 'pipeline') renderPipeline(q);
    else if (path === 'quote-new') renderQuoteForm(q);
    else if (path.startsWith('quote-edit/')) renderQuoteForm(q, Number(path.slice(11)));
    else if (path === 'new') renderForm(q);
    else if (path.startsWith('edit/')) renderForm(q, Number(path.slice(5)));
    else renderDashboard(q);
    window.scrollTo(0, 0);
  }

  // hover tooltip for full quote notes (fixed-position so table scrolling can't clip it)
  const qtip = document.createElement('div');
  qtip.id = 'qtip';
  document.body.appendChild(qtip);
  document.addEventListener('mouseover', (ev) => {
    const cell = ev.target.closest && ev.target.closest('.qnote[data-note]');
    if (!cell) { qtip.style.display = 'none'; return; }
    qtip.textContent = cell.dataset.note;
    const r = cell.getBoundingClientRect();
    qtip.style.display = 'block';
    qtip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 400))}px`;
    qtip.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 140)}px`;
  });
  document.addEventListener('scroll', () => { qtip.style.display = 'none'; }, true);

  window.addEventListener('hashchange', route);
  route().catch((err) => {
    document.querySelector('#app').innerHTML = `<div class="errors" style="margin:40px">Failed to load: ${esc(err.message)}</div>`;
  });
})();
