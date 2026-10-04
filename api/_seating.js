// Seating planner data layer. Lives in its own Postgres schema ("planning")
// so it never touches the rsvps table.
//
// Supports multiple named versions ("plans"). Each plan has its own room
// dimensions, tables, and guest assignments.
//
// SECURITY: every user value goes through the neon `sql` tagged template,
// which sends them as bound parameters. No user input is concatenated
// into SQL text.

const MAX_TABLES = 200;
const MAX_GUESTS = 1000;
const MAX_PLANS = 25;

function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}
function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function int(v, min, max, fallback) {
  return Math.round(num(v, min, max, fallback));
}
function toRev(v) {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function normalizeState(raw) {
  const s = raw || {};
  const room = s.room || {};

  const tables = (Array.isArray(s.tables) ? s.tables : [])
    .slice(0, MAX_TABLES)
    .map((t) => {
      const sRaw = String((t && t.shape) || 'round');
      const shape = sRaw === 'rect' ? 'rect' : sRaw === 'fixture' ? 'fixture' : sRaw === 'door' ? 'door' : 'round';
      return {
      id: str(t && t.id, 40),
      label: str(t && t.label, 60),
      nickname: str(t && t.nickname, 80),
      shape,
      seats: (shape === 'fixture' || shape === 'door') ? 0 : int(t && t.seats, 0, 40, 8),
      x: num(t && t.x, -500, 5000, 0),
      y: num(t && t.y, -500, 5000, 0),
      w: num(t && t.w, 0.5, 200, 5),
      h: num(t && t.h, 0.5, 200, 5),
      flip: !!(t && t.flip),
      };
    })
    .filter((t) => t.id);

  const tableIds = new Set(tables.map((t) => t.id));
  const taken = {};   // tableId -> Set of used seat indexes

  const guests = (Array.isArray(s.guests) ? s.guests : [])
    .slice(0, MAX_GUESTS)
    .map((g) => {
      const tableId = str(g && g.tableId, 40);
      const assigned = tableId && tableIds.has(tableId) ? tableId : null;
      let seatIndex = null;
      if (assigned) {
        // Keep the seat the client chose when it is a sane, unused integer;
        // otherwise hand out the next free seat.
        const used = taken[assigned] || (taken[assigned] = new Set());
        const wanted = Number(g && g.seatIndex);
        if (Number.isInteger(wanted) && wanted >= 0 && wanted < 200 && !used.has(wanted)) {
          seatIndex = wanted;
        } else {
          let i = 0; while (used.has(i)) i++;
          seatIndex = i;
        }
        used.add(seatIndex);
      }
      return {
        id: str(g && g.id, 40),
        firstName: str(g && g.firstName, 100),
        lastName: str(g && g.lastName, 100),
        party: str(g && g.party, 80),
        notes: str(g && g.notes, 500),
        tableId: assigned,
        seatIndex,
        plusOneOf: str(g && g.plusOneOf, 40) || null,
        isChild: !!(g && g.isChild),
      };
    })
    .filter((g) => g.id && (g.firstName || g.lastName));

  // a plus-one must point at a real guest in this plan
  const guestIds = new Set(guests.map((g) => g.id));
  guests.forEach((g) => { if (g.plusOneOf && !guestIds.has(g.plusOneOf)) g.plusOneOf = null; });

  return {
    room: {
      widthFt: num(room.widthFt, 5, 500, 60),
      heightFt: num(room.heightFt, 5, 500, 40),
      name: str(room.name, 120) || 'Reception Room',
    },
    tables,
    guests,
  };
}

export async function ensureSchema(sql) {
  await sql`CREATE SCHEMA IF NOT EXISTS planning`;

  await sql`
    CREATE TABLE IF NOT EXISTS planning.plans (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      room_name  TEXT,
      width_ft   NUMERIC NOT NULL DEFAULT 60,
      height_ft  NUMERIC NOT NULL DEFAULT 40,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS planning.tables (
      id         TEXT PRIMARY KEY,
      plan_id    TEXT,
      label      TEXT,
      nickname   TEXT,
      shape      TEXT NOT NULL DEFAULT 'round',
      seats      INT  NOT NULL DEFAULT 8,
      x          NUMERIC NOT NULL DEFAULT 0,
      y          NUMERIC NOT NULL DEFAULT 0,
      w          NUMERIC NOT NULL DEFAULT 5,
      h          NUMERIC NOT NULL DEFAULT 5,
      flip       BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS planning.guests (
      id         TEXT PRIMARY KEY,
      plan_id    TEXT,
      first_name TEXT,
      last_name  TEXT,
      party      TEXT,
      notes      TEXT,
      table_id   TEXT,
      seat_index INT,
      plus_one_of TEXT,
      is_child   BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  // Upgrade path for anything created before versioning existed.
  await sql`ALTER TABLE planning.tables ADD COLUMN IF NOT EXISTS plan_id TEXT`;
  await sql`ALTER TABLE planning.tables ADD COLUMN IF NOT EXISTS nickname TEXT`;
  await sql`ALTER TABLE planning.tables ADD COLUMN IF NOT EXISTS flip BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE planning.guests ADD COLUMN IF NOT EXISTS plus_one_of TEXT`;
  await sql`ALTER TABLE planning.guests ADD COLUMN IF NOT EXISTS is_child BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE planning.guests ADD COLUMN IF NOT EXISTS plan_id TEXT`;

  const existing = await sql`SELECT count(*)::int AS n FROM planning.plans`;
  if (!existing[0] || existing[0].n === 0) {
    let roomName = 'Reception Room', w = 60, h = 40;
    try {
      const old = await sql`SELECT name, width_ft, height_ft FROM planning.room WHERE id = 1`;
      if (old[0]) {
        roomName = old[0].name || roomName;
        w = Number(old[0].width_ft) || w;
        h = Number(old[0].height_ft) || h;
      }
    } catch (_) { /* planning.room may not exist; fine */ }

    await sql`
      INSERT INTO planning.plans (id, name, room_name, width_ft, height_ft)
      VALUES ('default', 'Version 1', ${roomName}, ${w}, ${h})
      ON CONFLICT (id) DO NOTHING`;
  }

  const orphanHome = await sql`SELECT id FROM planning.plans ORDER BY created_at ASC LIMIT 1`;
  if (orphanHome[0]) {
    const home = orphanHome[0].id;
    await sql`UPDATE planning.tables SET plan_id = ${home} WHERE plan_id IS NULL`;
    await sql`UPDATE planning.guests SET plan_id = ${home} WHERE plan_id IS NULL`;
  }
}

export async function listPlans(sql) {
  const rows = await sql`
    SELECT p.id, p.name,
           (SELECT count(*)::int FROM planning.tables t WHERE t.plan_id = p.id) AS table_count,
           (SELECT count(*)::int FROM planning.guests g WHERE g.plan_id = p.id) AS guest_count,
           (SELECT count(*)::int FROM planning.guests g WHERE g.plan_id = p.id AND g.table_id IS NOT NULL) AS seated_count
    FROM planning.plans p
    ORDER BY p.created_at ASC`;
  return rows.map((r) => ({
    id: r.id, name: r.name,
    tables: r.table_count, guests: r.guest_count, seated: r.seated_count,
  }));
}

export async function loadState(sql, planId) {
  const pid = str(planId, 40);
  const plans = pid
    ? await sql`SELECT id, name, room_name, width_ft, height_ft, updated_at FROM planning.plans WHERE id = ${pid}`
    : await sql`SELECT id, name, room_name, width_ft, height_ft, updated_at FROM planning.plans ORDER BY created_at ASC LIMIT 1`;

  const p = plans[0];
  if (!p) return null;

  const tables = await sql`
    SELECT id, label, nickname, shape, seats, x, y, w, h, flip
    FROM planning.tables WHERE plan_id = ${p.id} ORDER BY label ASC, id ASC`;
  const guests = await sql`
    SELECT id, first_name, last_name, party, notes, table_id, seat_index, plus_one_of, is_child
    FROM planning.guests WHERE plan_id = ${p.id}
    ORDER BY table_id NULLS FIRST, seat_index ASC NULLS LAST, last_name ASC, first_name ASC`;

  return {
    planId: p.id,
    planName: p.name,
    rev: toRev(p.updated_at),
    room: {
      name: p.room_name || 'Reception Room',
      widthFt: Number(p.width_ft),
      heightFt: Number(p.height_ft),
    },
    tables: tables.map((t) => ({
      id: t.id, label: t.label || '', nickname: t.nickname || '', shape: t.shape, seats: Number(t.seats),
      x: Number(t.x), y: Number(t.y), w: Number(t.w), h: Number(t.h), flip: !!t.flip,
    })),
    guests: guests.map((g) => ({
      id: g.id, firstName: g.first_name || '', lastName: g.last_name || '',
      party: g.party || '', notes: g.notes || '', tableId: g.table_id,
      seatIndex: g.seat_index === null || g.seat_index === undefined ? null : Number(g.seat_index),
      plusOneOf: g.plus_one_of || null,
      isChild: !!g.is_child,
    })),
  };
}

export async function saveState(sql, planId, rawState, expectedRev) {
  const pid = str(planId, 40);
  if (!pid) return { ok: false, status: 400, error: 'Missing plan' };

  const found = await sql`SELECT id, updated_at FROM planning.plans WHERE id = ${pid}`;
  if (!found[0]) return { ok: false, status: 404, error: 'Plan not found' };

  // Optimistic concurrency: if the client last saw a different revision,
  // someone else saved in between. Refuse rather than overwrite their work.
  const currentRev = toRev(found[0].updated_at);
  const wanted = toRev(expectedRev);
  if (wanted !== null && currentRev !== null && wanted !== currentRev) {
    return { ok: false, status: 409, error: 'This version was changed by someone else', rev: currentRev };
  }

  const state = normalizeState(rawState);

  await sql`
    UPDATE planning.plans SET
      room_name = ${state.room.name},
      width_ft = ${state.room.widthFt},
      height_ft = ${state.room.heightFt},
      updated_at = now()
    WHERE id = ${pid}`;

  const guestIds = state.guests.map((g) => g.id);
  await sql`DELETE FROM planning.guests WHERE plan_id = ${pid} AND id <> ALL(${guestIds}::text[])`;

  const tableIds = state.tables.map((t) => t.id);
  await sql`DELETE FROM planning.tables WHERE plan_id = ${pid} AND id <> ALL(${tableIds}::text[])`;

  for (const t of state.tables) {
    await sql`
      INSERT INTO planning.tables (id, plan_id, label, nickname, shape, seats, x, y, w, h, flip, updated_at)
      VALUES (${t.id}, ${pid}, ${t.label}, ${t.nickname}, ${t.shape}, ${t.seats}, ${t.x}, ${t.y}, ${t.w}, ${t.h}, ${t.flip}, now())
      ON CONFLICT (id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id, label = EXCLUDED.label,
        nickname = EXCLUDED.nickname, shape = EXCLUDED.shape,
        seats = EXCLUDED.seats, x = EXCLUDED.x, y = EXCLUDED.y,
        w = EXCLUDED.w, h = EXCLUDED.h, flip = EXCLUDED.flip, updated_at = now()`;
  }

  for (const g of state.guests) {
    await sql`
      INSERT INTO planning.guests (id, plan_id, first_name, last_name, party, notes, table_id, seat_index, plus_one_of, is_child, updated_at)
      VALUES (${g.id}, ${pid}, ${g.firstName}, ${g.lastName}, ${g.party}, ${g.notes}, ${g.tableId}, ${g.seatIndex}, ${g.plusOneOf}, ${g.isChild}, now())
      ON CONFLICT (id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id, first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name, party = EXCLUDED.party, notes = EXCLUDED.notes,
        table_id = EXCLUDED.table_id, seat_index = EXCLUDED.seat_index,
        plus_one_of = EXCLUDED.plus_one_of, is_child = EXCLUDED.is_child, updated_at = now()`;
  }

  const after = await sql`SELECT updated_at FROM planning.plans WHERE id = ${pid}`;
  const rev = toRev(after[0] && after[0].updated_at);
  return { ok: true, tables: state.tables.length, guests: state.guests.length, rev };
}

export async function createPlan(sql, name) {
  const count = await sql`SELECT count(*)::int AS n FROM planning.plans`;
  if (count[0] && count[0].n >= MAX_PLANS) {
    return { ok: false, status: 400, error: 'Too many versions' };
  }
  const id = newId();
  const nm = str(name, 80) || 'New version';
  await sql`INSERT INTO planning.plans (id, name, room_name, width_ft, height_ft) VALUES (${id}, ${nm}, 'Reception Room', 60, 40)`;
  return { ok: true, planId: id };
}

export async function duplicatePlan(sql, srcId, name) {
  const count = await sql`SELECT count(*)::int AS n FROM planning.plans`;
  if (count[0] && count[0].n >= MAX_PLANS) {
    return { ok: false, status: 400, error: 'Too many versions' };
  }
  const src = await loadState(sql, srcId);
  if (!src) return { ok: false, status: 404, error: 'Plan not found' };

  const id = newId();
  const nm = str(name, 80) || (src.planName + ' copy');
  await sql`
    INSERT INTO planning.plans (id, name, room_name, width_ft, height_ft)
    VALUES (${id}, ${nm}, ${src.room.name}, ${src.room.widthFt}, ${src.room.heightFt})`;

  const map = {};
  const tables = src.tables.map((t) => {
    const nid = newId();
    map[t.id] = nid;
    return Object.assign({}, t, { id: nid });
  });
  const gmap = {};
  src.guests.forEach((g) => { gmap[g.id] = newId(); });
  const guests = src.guests.map((g) => Object.assign({}, g, {
    id: gmap[g.id],
    tableId: g.tableId ? (map[g.tableId] || null) : null,
    plusOneOf: g.plusOneOf ? (gmap[g.plusOneOf] || null) : null,
  }));

  await saveState(sql, id, { room: src.room, tables, guests });
  return { ok: true, planId: id };
}

export async function renamePlan(sql, planId, name) {
  const pid = str(planId, 40);
  const nm = str(name, 80);
  if (!pid || !nm) return { ok: false, status: 400, error: 'Missing name' };
  await sql`UPDATE planning.plans SET name = ${nm} WHERE id = ${pid}`;
  return { ok: true };
}

export async function deletePlan(sql, planId) {
  const pid = str(planId, 40);
  if (!pid) return { ok: false, status: 400, error: 'Missing plan' };
  const count = await sql`SELECT count(*)::int AS n FROM planning.plans`;
  if (count[0] && count[0].n <= 1) {
    return { ok: false, status: 400, error: 'Cannot delete the only version' };
  }
  await sql`DELETE FROM planning.guests WHERE plan_id = ${pid}`;
  await sql`DELETE FROM planning.tables WHERE plan_id = ${pid}`;
  await sql`DELETE FROM planning.plans  WHERE id = ${pid}`;
  return { ok: true };
}

export async function listRsvpGuests(sql) {
  try {
    const rows = await sql`
      SELECT first_name, last_name, name, guests, note, attending
      FROM rsvps
      ORDER BY last_name ASC, first_name ASC`;
    return rows.map((r) => {
      let first = r.first_name || '', last = r.last_name || '';
      if (!first && !last && r.name) { const bits = String(r.name).trim().split(/\s+/); first = bits.shift() || ''; last = bits.join(' '); }
      return {
        firstName: first,
        lastName: last,
        partySize: Number(r.guests) || 1,
        note: r.note || '',
        attending: r.attending === 'declined' ? 'declined' : 'accepted',
      };
    });
  } catch (err) {
    return [];
  }
}
