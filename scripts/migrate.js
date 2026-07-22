'use strict';
// One-time migration: pushes data/export.json into Supabase (run AFTER Luke has
// created the sd_ tables). Safe to re-run: skips if sd_entries already has rows.
// Run: node scripts/migrate.js
const fs = require('fs');
const path = require('path');

const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
const URL_ = cfgSrc.match(/SUPABASE_URL: '([^']+)'/)[1];
const KEY = cfgSrc.match(/SUPABASE_ANON_KEY: '([^']+)'/)[1];
const H = { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` };

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'export.json'), 'utf8'));

async function sb(pathname, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${pathname}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const existing = await sb('sd_entries?select=id&limit=1');
  if (existing.length > 0) {
    console.log('sd_entries already has data — refusing to double-migrate. (Empty the tables to re-run.)');
    return;
  }
  await sb('sd_roster', { method: 'POST', body: JSON.stringify(data.roster.map((p, i) => ({ person: p, sort_order: i, active: true }))) });
  await sb('sd_roster', { method: 'POST', body: JSON.stringify([{ person: 'Team Win', sort_order: 99, active: false }]) });
  await sb('sd_holidays', { method: 'POST', body: JSON.stringify(data.holidays) });
  await sb('sd_targets', { method: 'POST', body: JSON.stringify(data.targets) });
  const rows = data.entries.map(({ id, ...e }) => e); // let Supabase assign ids
  for (let i = 0; i < rows.length; i += 200) {
    await sb('sd_entries', { method: 'POST', body: JSON.stringify(rows.slice(i, i + 200)) });
  }
  const check = await sb('sd_entries?select=revenue_cents');
  const total = check.reduce((s, r) => s + Number(r.revenue_cents), 0) / 100;
  console.log(`migrated: ${check.length} entries, total $${total.toFixed(2)} — compare against the export line above.`);
})().catch((err) => { console.error('MIGRATION FAILED:', err.message); process.exit(1); });
