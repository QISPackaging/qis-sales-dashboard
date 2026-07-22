# QIS Sales Dashboard

Static team sales dashboard: GitHub Pages front-end + Supabase data (same pattern
and same Supabase project as the quoting tool). Log sales, see live monthly /
weekly / daily pacing per person against targets.

- `index.html` + `js/app.js` — the whole app (no build step)
- `js/pacing.js` — working-day pacing engine (ported from the verified portal; `npm test`)
- `js/db.js` — Supabase (PostgREST) data layer; falls back to bundled read-only
  preview data (`js/fixture.js`) if the tables are unreachable
- `scripts/export-from-portal.js` — regenerate fixture + migration payload from the old portal DB
- `scripts/migrate.js` — one-time data migration into Supabase (after tables exist)

Tables (prefix `sd_`, created via the SQL in the setup handoff): sd_entries,
sd_targets, sd_holidays, sd_roster, sd_audit. Access model matches the quoting
tool: anon key in the page, open read/write — treat the URL as internal.
