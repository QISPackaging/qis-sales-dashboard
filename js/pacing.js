'use strict';
// Ported verbatim from the portal's verified engine (15 test fixtures).
// Pure pacing engine. No dependencies, no clock, no database — every function
// takes dates/holidays explicitly. Dates are 'YYYY-MM-DD' strings (lexicographic
// order == chronological order), months are 'YYYY-MM'. Holidays is a Set of
// 'YYYY-MM-DD'; weekend-dated holidays are harmless (weekends are never working
// days). All figures reproduce the FY27 Excel workbook exactly (see test/).

function dow(iso) {
  // 0=Mon .. 6=Sun
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

function monthOf(iso) {
  return iso.slice(0, 7);
}

function monthStart(month) {
  return `${month}-01`;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

function isWorkingDay(iso, holidays) {
  return dow(iso) < 5 && !holidays.has(iso);
}

function workingDaysBetween(startIso, endIso, holidays) {
  // inclusive; end before start -> 0
  let n = 0;
  for (let d = startIso; d <= endIso; d = addDays(d, 1)) {
    if (isWorkingDay(d, holidays)) n += 1;
  }
  return n;
}

function workingDaysInMonth(month, holidays) {
  return workingDaysBetween(monthStart(month), monthEnd(month), holidays);
}

function elapsedWD(month, asOf, holidays) {
  // working days from the 1st through min(asOf, month end); 0 for future months
  if (asOf < monthStart(month)) return 0;
  const end = asOf < monthEnd(month) ? asOf : monthEnd(month);
  return workingDaysBetween(monthStart(month), end, holidays);
}

function monthPace(target, month, asOf, holidays) {
  const total = workingDaysInMonth(month, holidays);
  if (total === 0) return 0;
  return (target * elapsedWD(month, asOf, holidays)) / total;
}

function dailyTarget(targetForMonth, dateIso, holidays) {
  // targetForMonth: (month) => number (0 when no target, e.g. outside the FY)
  if (!isWorkingDay(dateIso, holidays)) return 0;
  const month = monthOf(dateIso);
  const total = workingDaysInMonth(month, holidays);
  if (total === 0) return 0;
  return targetForMonth(month) / total;
}

function weekBounds(dateIso) {
  const mon = addDays(dateIso, -dow(dateIso));
  return { mon, fri: addDays(mon, 4), sun: addDays(mon, 6) };
}

function weeklyTarget(targetForMonth, monIso, holidays) {
  // sum of Mon..Fri daily targets; straddles months correctly because each
  // day is priced against its own month's target and working-day count
  let sum = 0;
  for (let i = 0; i < 5; i += 1) {
    sum += dailyTarget(targetForMonth, addDays(monIso, i), holidays);
  }
  return sum;
}

function upcomingFriday(asOf) {
  const w = dow(asOf);
  return addDays(asOf, w <= 4 ? 4 - w : 4 - w + 7);
}

function needToCloseThisWeek(teamMonthTarget, month, asOf, teamMTD, holidays) {
  // shortfall vs the on-track line + this week's run: what the team must bank
  // by close of the coming Friday (capped at month end) to be back on track
  const total = workingDaysInMonth(month, holidays);
  if (total === 0) return 0;
  const fri = upcomingFriday(asOf);
  const capped = fri < monthEnd(month) ? fri : monthEnd(month);
  const wdTo = workingDaysBetween(monthStart(month), capped, holidays);
  return Math.max(0, (teamMonthTarget * wdTo) / total - teamMTD);
}

function requiredPerDay(target, actual, remainingWD) {
  if (remainingWD <= 0) return null;
  return Math.max(0, target - actual) / remainingWD;
}

function weightedGp(entries) {
  // revenue-weighted; entries with null/undefined GP are excluded from BOTH
  // sides (an unknown margin should not drag the average toward zero)
  let rev = 0;
  let gpDollars = 0;
  for (const e of entries) {
    if (e.gp == null) continue;
    rev += e.revenue;
    gpDollars += e.revenue * e.gp;
  }
  return rev > 0 ? gpDollars / rev : null;
}

function ytdProRata(targetForMonth, fyMonths, asOf, holidays) {
  let sum = 0;
  for (const month of fyMonths) {
    const total = workingDaysInMonth(month, holidays);
    if (total === 0) continue;
    sum += (targetForMonth(month) * elapsedWD(month, asOf, holidays)) / total;
  }
  return sum;
}

function fyMonthsFrom(fyStartIso) {
  const first = monthOf(fyStartIso);
  return Array.from({ length: 12 }, (_, i) => addMonths(first, i));
}

const __exports = {
  dow,
  addDays,
  monthOf,
  monthStart,
  monthEnd,
  addMonths,
  isWorkingDay,
  workingDaysBetween,
  workingDaysInMonth,
  elapsedWD,
  monthPace,
  dailyTarget,
  weekBounds,
  weeklyTarget,
  upcomingFriday,
  needToCloseThisWeek,
  requiredPerDay,
  weightedGp,
  ytdProRata,
  fyMonthsFrom,
};

if (typeof module !== 'undefined') module.exports = __exports;
if (typeof window !== 'undefined') window.QIS_PACING = __exports;
