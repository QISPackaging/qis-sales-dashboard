'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../js/pacing');

// FY27 QLD holidays (weekend-dated entries included deliberately — must be inert)
const HOLIDAYS = new Set([
  '2026-08-12', '2026-10-05', '2026-12-25', '2026-12-26', '2026-12-28',
  '2027-01-01', '2027-01-26', '2027-03-26', '2027-03-27', '2027-03-28',
  '2027-03-29', '2027-04-25', '2027-04-26', '2027-05-03',
]);

// FY27 targets straight from the verified workbook
const TEAM = {
  '2026-07': 144867.499, '2026-08': 161272.6325, '2026-09': 221274.865,
  '2026-10': 172124.197, '2026-11': 192373.9615, '2026-12': 138067.7095,
  '2027-01': 154850.2095, '2027-02': 147824.5755, '2027-03': 181403.9605,
  '2027-04': 167918.24836499998, '2027-05': 169272.672835, '2027-06': 155456.90167000002,
};
const fullShare = (m) => TEAM[m] / 4;
const julyHalfShare = (m) => (m === '2026-07' ? TEAM[m] / 8 : 0);
const FY_MONTHS = p.fyMonthsFrom('2026-07-01');

const close = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
const close2dp = (actual, expected) => assert.equal(actual.toFixed(2), expected.toFixed(2));

test('working days per FY27 month match the verified workbook', () => {
  const expected = { '2026-07': 23, '2026-08': 20, '2026-09': 22, '2026-10': 21,
    '2026-11': 21, '2026-12': 21, '2027-01': 19, '2027-02': 20, '2027-03': 21,
    '2027-04': 21, '2027-05': 20, '2027-06': 22 };
  for (const [month, wd] of Object.entries(expected)) {
    assert.equal(p.workingDaysInMonth(month, HOLIDAYS), wd, month);
  }
});

test('weekend-dated holidays are inert', () => {
  const withoutWeekendHols = new Set([...HOLIDAYS].filter((d) => p.dow(d) < 5));
  for (const m of FY_MONTHS) {
    assert.equal(p.workingDaysInMonth(m, HOLIDAYS), p.workingDaysInMonth(m, withoutWeekendHols));
  }
});

test('straddle week Mon 31/08 – Fri 04/09, full-share person', () => {
  close(p.weeklyTarget(fullShare, '2026-08-31', HOLIDAYS), 12073.856315340909);
});

test('upcomingFriday', () => {
  assert.equal(p.upcomingFriday('2026-07-05'), '2026-07-10'); // Sunday rolls forward
  assert.equal(p.upcomingFriday('2026-07-08'), '2026-07-10'); // Wednesday
  assert.equal(p.upcomingFriday('2026-07-11'), '2026-07-17'); // Saturday rolls forward
  assert.equal(p.upcomingFriday('2026-07-10'), '2026-07-10'); // Friday is its own Friday
});

test('needToCloseThisWeek as at Sun 05/07/2026', () => {
  close2dp(p.needToCloseThisWeek(TEAM['2026-07'], '2026-07', '2026-07-05', 16199.93, HOLIDAYS), 34188.77);
});

test('snapshot as at Sun 05/07/2026 — pace and required/day', () => {
  assert.equal(p.elapsedWD('2026-07', '2026-07-05', HOLIDAYS), 3);
  close2dp(p.monthPace(TEAM['2026-07'], '2026-07', '2026-07-05', HOLIDAYS), 18895.76);
  close2dp(p.monthPace(fullShare('2026-07'), '2026-07', '2026-07-05', HOLIDAYS), 4723.94);
  close2dp(p.monthPace(TEAM['2026-07'] / 8, '2026-07', '2026-07-05', HOLIDAYS), 2361.97);
  const rem = 23 - 3;
  close2dp(p.requiredPerDay(36216.874749999995, 3766.58, rem), 1622.51);
  close2dp(p.requiredPerDay(36216.874749999995, 5469.31, rem), 1537.38);
  close2dp(p.requiredPerDay(36216.874749999995, 4566.04, rem), 1582.54);
  close2dp(p.requiredPerDay(18108.437374999998, 0, rem), 905.42);
  close2dp(p.requiredPerDay(18108.437374999998, 2398.0, rem), 785.52);
  close2dp(p.requiredPerDay(TEAM['2026-07'], 16199.93, rem), 6433.38);
});

test('daily targets: working day, weekend, Ekka', () => {
  const teamFor = (m) => TEAM[m] ?? 0;
  close2dp(p.dailyTarget(teamFor, '2026-07-03', HOLIDAYS), 6298.59);
  assert.equal(p.dailyTarget(teamFor, '2026-07-04', HOLIDAYS), 0); // Saturday
  assert.equal(p.dailyTarget(teamFor, '2026-08-12', HOLIDAYS), 0); // Ekka
  assert.equal(p.dailyTarget(teamFor, '2027-08-02', HOLIDAYS), 0); // outside FY -> no target
});

test('weighted GP: verified July figure, null-GP exclusion', () => {
  const july = [
    { revenue: 1420.32, gp: 0.4039 }, { revenue: 1095, gp: 0.55 },
    { revenue: 1908.7, gp: 0.597 }, { revenue: 2999, gp: 0.384 },
    { revenue: 950, gp: 0.521 }, { revenue: 792, gp: 0.4165 },
    { revenue: 561.61, gp: 0.547 }, { revenue: 228.05, gp: 0.7986 },
    { revenue: 1292.5, gp: 0.541 }, { revenue: 55.56, gp: 0.47 },
    { revenue: 2095.49, gp: 0.553 }, { revenue: 1195.7, gp: 0.4372 },
    { revenue: 1606, gp: 0.63 },
  ];
  close(p.weightedGp(july), 0.5062, 5e-5);
  close(p.weightedGp([...july, { revenue: 99999, gp: null }]), p.weightedGp(july));
  assert.equal(p.weightedGp([{ revenue: 100, gp: null }]), null);
});

test('YTD pro-rata as at 05/07: only July partially elapsed', () => {
  close2dp(p.ytdProRata(fullShare, FY_MONTHS, '2026-07-05', HOLIDAYS), 4723.94);
  close2dp(p.ytdProRata(julyHalfShare, FY_MONTHS, '2026-07-05', HOLIDAYS), 2361.97);
});

test('week bounds', () => {
  assert.deepEqual(p.weekBounds('2026-07-05'), { mon: '2026-06-29', fri: '2026-07-03', sun: '2026-07-05' });
  assert.deepEqual(p.weekBounds('2026-07-06'), { mon: '2026-07-06', fri: '2026-07-10', sun: '2026-07-12' });
});

test('month pace clamps: past month full, future month zero', () => {
  close(p.monthPace(100, '2026-07', '2026-09-15', HOLIDAYS), 100);
  assert.equal(p.monthPace(100, '2026-08', '2026-07-05', HOLIDAYS), 0);
});
