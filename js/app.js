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
      ${link('dashboard', 'Dashboard')}${link('entries', 'Entries')}${link('new', 'Log a sale')}
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
    } : { entry_date: todayBrisbane(), person: '', customer: '', order_ref: '', revenue: '', gp_pct: '', lead_source: '' };

    $('#app').innerHTML = `${navHtml('new')}
    <header class="page"><div><p class="eyebrow">Sales Team</p><h1>${editing ? 'Edit entry' : 'Log a sale'}</h1></div></header>
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
        else await db.createEntry(parsed.value, `web:${parsed.value.person}`);
        await reload();
        go('entries', { month: parsed.value.entry_date.slice(0, 7) });
      } catch (err) {
        msg.innerHTML = `<div class="errors">Could not save: ${esc(err.message)}</div>`;
      }
    });
  }

  // ---------- boot ----------
  async function reload() {
    const data = await db.loadAll();
    S = {
      entries: data.entries,
      targets: data.targets,
      roster: data.roster,
      holidaySet: new Set(data.holidays.map((h) => h.date)),
      fyMonths: p.fyMonthsFrom(C.FY_START),
    };
  }

  async function route() {
    if (!S) await reload();
    const { path, q } = hashParts();
    if (path === 'entries') renderEntries(q);
    else if (path === 'new') renderForm(q);
    else if (path.startsWith('edit/')) renderForm(q, Number(path.slice(5)));
    else renderDashboard(q);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  route().catch((err) => {
    document.querySelector('#app').innerHTML = `<div class="errors" style="margin:40px">Failed to load: ${esc(err.message)}</div>`;
  });
})();
