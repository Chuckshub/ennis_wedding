// Budget data layer. Lives in its own Postgres schema ("budget"), separate
// from rsvps and the seating planner.
//
// SECURITY: every user value goes through the neon `sql` tagged template,
// which sends them as bound parameters. No user input is concatenated
// into SQL text.

const MAX_GROUPS = 50;
const MAX_ITEMS = 500;
const MAX_PAYMENTS = 3000;
const MAX_MONEY = 100000000; // $100M cap, just to bound bad input

function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(MAX_MONEY, Math.max(0, n)) * 100) / 100;
}
function int(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}
function isoDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : s;
}
function toRev(v) {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const STATUSES = new Set(['booked', 'pending', 'idea']);

export function normalizeState(raw) {
  const s = raw || {};

  const groups = (Array.isArray(s.groups) ? s.groups : [])
    .slice(0, MAX_GROUPS)
    .map((g, i) => ({
      id: str(g && g.id, 40),
      name: str(g && g.name, 80) || 'Untitled group',
      sort: int(g && g.sort, 0, 10000, i),
    }))
    .filter((g) => g.id);
  const groupIds = new Set(groups.map((g) => g.id));

  const items = (Array.isArray(s.items) ? s.items : [])
    .slice(0, MAX_ITEMS)
    .map((it, i) => {
      const status = String((it && it.status) || 'pending').toLowerCase();
      return {
        id: str(it && it.id, 40),
        groupId: groupIds.has(str(it && it.groupId, 40)) ? str(it.groupId, 40) : (groups[0] ? groups[0].id : null),
        name: str(it && it.name, 120) || 'Untitled item',
        vendor: str(it && it.vendor, 120),
        status: STATUSES.has(status) ? status : 'pending',
        estimate: money(it && it.estimate),
        actual: money(it && it.actual),
        notes: str(it && it.notes, 1000),
        sort: int(it && it.sort, 0, 10000, i),
      };
    })
    .filter((it) => it.id && it.groupId);
  const itemIds = new Set(items.map((it) => it.id));

  const payments = (Array.isArray(s.payments) ? s.payments : [])
    .slice(0, MAX_PAYMENTS)
    .map((p) => ({
      id: str(p && p.id, 40),
      itemId: str(p && p.itemId, 40),
      amount: money(p && p.amount),
      paidOn: isoDate(p && p.paidOn),
      dueOn: isoDate(p && p.dueOn),
      note: str(p && p.note, 200),
    }))
    .filter((p) => p.id && itemIds.has(p.itemId));

  return {
    totalBudget: money(s.totalBudget),
    groups,
    items,
    payments,
  };
}

export async function ensureSchema(sql) {
  await sql`CREATE SCHEMA IF NOT EXISTS budget`;
  await sql`
    CREATE TABLE IF NOT EXISTS budget.settings (
      id           INT PRIMARY KEY,
      total_budget NUMERIC NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS budget.groups (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort INT  NOT NULL DEFAULT 0
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS budget.items (
      id         TEXT PRIMARY KEY,
      group_id   TEXT,
      name       TEXT NOT NULL,
      vendor     TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      estimate   NUMERIC NOT NULL DEFAULT 0,
      actual     NUMERIC NOT NULL DEFAULT 0,
      notes      TEXT,
      sort       INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS budget.payments (
      id       TEXT PRIMARY KEY,
      item_id  TEXT,
      amount   NUMERIC NOT NULL DEFAULT 0,
      paid_on  DATE,
      due_on   DATE,
      note     TEXT
    )`;
  await sql`INSERT INTO budget.settings (id, total_budget) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;

  // First run: seed the same kind of groups Zola uses, so the page isn't empty.
  const g = await sql`SELECT count(*)::int AS n FROM budget.groups`;
  if (g[0] && g[0].n === 0) {
    const defaults = ['Venue and vendors', 'Attire and beauty', 'Stationery and decor', 'Music and entertainment', 'Rings, gifts and favors', 'Other'];
    for (let i = 0; i < defaults.length; i++) {
      await sql`INSERT INTO budget.groups (id, name, sort) VALUES (${newId()}, ${defaults[i]}, ${i})`;
    }
  }
}

function dateOut(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export async function loadState(sql) {
  const settings = await sql`SELECT total_budget, updated_at FROM budget.settings WHERE id = 1`;
  const groups = await sql`SELECT id, name, sort FROM budget.groups ORDER BY sort ASC, name ASC`;
  const items = await sql`
    SELECT id, group_id, name, vendor, status, estimate, actual, notes, sort
    FROM budget.items ORDER BY sort ASC, name ASC`;
  const payments = await sql`
    SELECT id, item_id, amount, paid_on, due_on, note
    FROM budget.payments ORDER BY COALESCE(paid_on, due_on) ASC NULLS LAST, id ASC`;

  const st = settings[0] || {};
  return {
    ok: true,
    rev: toRev(st.updated_at),
    totalBudget: Number(st.total_budget) || 0,
    groups: groups.map((g) => ({ id: g.id, name: g.name, sort: Number(g.sort) })),
    items: items.map((it) => ({
      id: it.id, groupId: it.group_id, name: it.name, vendor: it.vendor || '',
      status: it.status, estimate: Number(it.estimate) || 0, actual: Number(it.actual) || 0,
      notes: it.notes || '', sort: Number(it.sort),
    })),
    payments: payments.map((p) => ({
      id: p.id, itemId: p.item_id, amount: Number(p.amount) || 0,
      paidOn: dateOut(p.paid_on), dueOn: dateOut(p.due_on), note: p.note || '',
    })),
  };
}

export async function saveState(sql, rawState, expectedRev) {
  const cur = await sql`SELECT updated_at FROM budget.settings WHERE id = 1`;
  const currentRev = toRev(cur[0] && cur[0].updated_at);
  const wanted = toRev(expectedRev);
  if (wanted !== null && currentRev !== null && wanted !== currentRev) {
    return { ok: false, status: 409, error: 'The budget was changed by someone else', rev: currentRev };
  }

  const state = normalizeState(rawState);

  await sql`UPDATE budget.settings SET total_budget = ${state.totalBudget}, updated_at = now() WHERE id = 1`;

  // Prune children first, then parents.
  const payIds = state.payments.map((p) => p.id);
  await sql`DELETE FROM budget.payments WHERE id <> ALL(${payIds}::text[])`;
  const itemIds = state.items.map((it) => it.id);
  await sql`DELETE FROM budget.items WHERE id <> ALL(${itemIds}::text[])`;
  const groupIds = state.groups.map((g) => g.id);
  await sql`DELETE FROM budget.groups WHERE id <> ALL(${groupIds}::text[])`;

  for (const g of state.groups) {
    await sql`
      INSERT INTO budget.groups (id, name, sort) VALUES (${g.id}, ${g.name}, ${g.sort})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort`;
  }
  for (const it of state.items) {
    await sql`
      INSERT INTO budget.items (id, group_id, name, vendor, status, estimate, actual, notes, sort, updated_at)
      VALUES (${it.id}, ${it.groupId}, ${it.name}, ${it.vendor}, ${it.status}, ${it.estimate}, ${it.actual}, ${it.notes}, ${it.sort}, now())
      ON CONFLICT (id) DO UPDATE SET
        group_id = EXCLUDED.group_id, name = EXCLUDED.name, vendor = EXCLUDED.vendor,
        status = EXCLUDED.status, estimate = EXCLUDED.estimate, actual = EXCLUDED.actual,
        notes = EXCLUDED.notes, sort = EXCLUDED.sort, updated_at = now()`;
  }
  for (const p of state.payments) {
    await sql`
      INSERT INTO budget.payments (id, item_id, amount, paid_on, due_on, note)
      VALUES (${p.id}, ${p.itemId}, ${p.amount}, ${p.paidOn}, ${p.dueOn}, ${p.note})
      ON CONFLICT (id) DO UPDATE SET
        item_id = EXCLUDED.item_id, amount = EXCLUDED.amount,
        paid_on = EXCLUDED.paid_on, due_on = EXCLUDED.due_on, note = EXCLUDED.note`;
  }

  const after = await sql`SELECT updated_at FROM budget.settings WHERE id = 1`;
  return { ok: true, rev: toRev(after[0] && after[0].updated_at), items: state.items.length, payments: state.payments.length };
}
