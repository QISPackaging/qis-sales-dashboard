'use strict';
// Data layer: Supabase PostgREST with a read-only fixture fallback so the app
// still renders (banner shown) if the tables aren't reachable yet.
(function () {
  const C = window.QIS_CONFIG;
  const BASE = `${C.SUPABASE_URL}/rest/v1/`;
  const P = C.TABLE_PREFIX;
  const HEADERS = {
    'Content-Type': 'application/json',
    apikey: C.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${C.SUPABASE_ANON_KEY}`,
  };

  let demoMode = false;

  async function sb(path, opts = {}) {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { ...HEADERS, Prefer: 'return=representation', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
    if (res.status === 204) return null;
    return res.json();
  }

  const centsFromRow = (r) => ({
    id: r.id,
    entry_date: r.entry_date,
    person: r.person,
    customer: r.customer,
    order_ref: r.order_ref,
    revenue_cents: Number(r.revenue_cents),
    gp_pct: r.gp_pct == null ? null : Number(r.gp_pct),
    lead_source: r.lead_source ?? null,
    created_by: r.created_by,
  });

  async function loadAll() {
    try {
      const [entries, targets, holidays, roster] = await Promise.all([
        sb(`${P}entries?deleted_at=is.null&order=entry_date.asc,id.asc&select=*`),
        sb(`${P}targets?select=*`),
        sb(`${P}holidays?select=*`),
        sb(`${P}roster?select=*&order=sort_order.asc`),
      ]);
      demoMode = false;
      return {
        entries: entries.map(centsFromRow),
        targets,
        holidays,
        roster: roster.filter((r) => r.active).map((r) => r.person).filter((p) => p !== 'Team Win'),
      };
    } catch (err) {
      console.warn('Supabase unavailable, using bundled preview data:', err.message);
      demoMode = true;
      const F = window.QIS_FIXTURE;
      return {
        entries: F.entries.map(centsFromRow),
        targets: F.targets,
        holidays: F.holidays,
        roster: F.roster,
      };
    }
  }

  function guardWrite() {
    if (demoMode) throw new Error('Preview data only — the live database isn’t reachable, so saving is off.');
  }

  async function audit(action, entityId, actor, detail) {
    try {
      await sb(`${P}audit`, {
        method: 'POST',
        body: JSON.stringify({ entity: 'sd_entries', entity_id: entityId, action, actor, detail }),
      });
    } catch { /* best effort */ }
  }

  async function createEntry(fields, actor) {
    guardWrite();
    const rows = await sb(`${P}entries`, {
      method: 'POST',
      body: JSON.stringify({ ...fields, created_by: actor }),
    });
    audit('create', rows[0].id, actor, fields);
    return rows[0].id;
  }

  async function updateEntry(id, fields, actor) {
    guardWrite();
    await sb(`${P}entries?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...fields, updated_by: actor, updated_at: new Date().toISOString() }),
    });
    audit('update', id, actor, fields);
  }

  async function softDelete(id, actor) {
    guardWrite();
    await sb(`${P}entries?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ deleted_by: actor, deleted_at: new Date().toISOString() }),
    });
    audit('delete', id, actor, null);
  }

  // ---- pipeline quotes (sd_quotes) ----
  let quotesUnavailable = false;
  async function loadQuotes() {
    try {
      const rows = await sb(`${P}quotes?deleted_at=is.null&order=quote_date.asc,id.asc&select=*`);
      quotesUnavailable = false;
      return rows.map((r) => ({
        id: r.id, quote_ref: r.quote_ref, quote_date: r.quote_date, customer: r.customer,
        person: r.person, value_cents: Number(r.value_cents),
        gp_pct: r.gp_pct == null ? null : Number(r.gp_pct),
        status: r.status, loss_reason: r.loss_reason, status_date: r.status_date,
        notes: r.notes ?? '', won_entry_id: r.won_entry_id,
      }));
    } catch (err) {
      console.warn('quotes unavailable:', err.message);
      quotesUnavailable = true;
      return [];
    }
  }
  async function quoteAudit(action, id, actor, detail) {
    try {
      await sb(`${P}audit`, { method: 'POST', body: JSON.stringify({ entity: 'sd_quotes', entity_id: id, action, actor, detail }) });
    } catch { /* best effort */ }
  }
  async function createQuote(fields, actor) {
    guardWrite();
    const rows = await sb(`${P}quotes`, { method: 'POST', body: JSON.stringify({ ...fields, created_by: actor }) });
    quoteAudit('create', rows[0].id, actor, fields);
    return rows[0].id;
  }
  async function updateQuote(id, fields, actor) {
    guardWrite();
    await sb(`${P}quotes?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...fields, updated_by: actor, updated_at: new Date().toISOString() }),
    });
    quoteAudit('update', id, actor, fields);
  }
  async function softDeleteQuote(id, actor) {
    guardWrite();
    await sb(`${P}quotes?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ deleted_by: actor, deleted_at: new Date().toISOString() }),
    });
    quoteAudit('delete', id, actor, null);
  }

  window.QIS_DB = {
    loadAll, createEntry, updateEntry, softDelete,
    loadQuotes, createQuote, updateQuote, softDeleteQuote,
    quotesUnavailable: () => quotesUnavailable,
    isDemo: () => demoMode,
  };
})();
