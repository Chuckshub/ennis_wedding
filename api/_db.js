// Shared database logic for RSVP save + stats.
// SECURITY: every user value is interpolated through the neon `sql` tagged
// template, which sends them as bound query parameters ($1, $2, ...). No user
// input is ever concatenated into SQL text, so values cannot alter the query.

export function clean(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

// Save or update an RSVP. Re-RSVPing with the same first+last name (case /
// space-insensitive) updates the existing row instead of adding a duplicate.
// Creates the rsvps table if missing and adds any newer columns.
// Safe to run on every request; all statements are IF NOT EXISTS.
export async function ensureRsvpSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS rsvps (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      attending   TEXT        NOT NULL,
      guests      INTEGER     NOT NULL DEFAULT 1,
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS first_name TEXT`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS last_name  TEXT`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS song       TEXT`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS from_city  TEXT`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS memory     TEXT`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`;
}

export async function saveRsvp(sql, body) {
  const b = body || {};
  const first = clean(b.first_name, 100);
  const last  = clean(b.last_name, 100);
  const full  = (clean(b.name, 200) || [first, last].filter(Boolean).join(' ')).slice(0, 200);
  if (!full) return { ok: false, status: 400, error: 'Name is required' };

  const status = String(b.attending || '').toLowerCase().includes('decline') ? 'declined' : 'accepted';
  const note   = clean(b.note, 2000);
  const song   = clean(b.song, 300);
  const city   = clean(b.from_city, 200);
  const memory = clean(b.memory, 4000);

  // guests: null means "not provided" -> keep existing on update, default 1 on insert
  const guestsGiven = b.guests !== undefined && b.guests !== null && String(b.guests).trim() !== '';
  const guests = guestsGiven ? Math.max(1, Math.min(20, parseInt(b.guests, 10) || 1)) : null;

  if (first && last) {
    const existing = await sql`
      SELECT id FROM rsvps
      WHERE lower(first_name) = lower(${first}) AND lower(last_name) = lower(${last})
      ORDER BY id ASC LIMIT 1
    `;
    if (existing.length) {
      // Only overwrite what was actually provided. Blank fields keep their
      // current value (COALESCE + NULLIF), so re-RSVPing never wipes old data.
      await sql`
        UPDATE rsvps SET
          name       = ${full},
          attending  = ${status},
          guests     = COALESCE(${guests}, guests),
          note       = COALESCE(NULLIF(${note}, ''), note),
          song       = COALESCE(NULLIF(${song}, ''), song),
          from_city  = COALESCE(NULLIF(${city}, ''), from_city),
          memory     = COALESCE(NULLIF(${memory}, ''), memory),
          updated_at = now()
        WHERE id = ${existing[0].id}
      `;
      return { ok: true, updated: true };
    }
  }

  await sql`
    INSERT INTO rsvps (name, first_name, last_name, attending, guests, note, song, from_city, memory)
    VALUES (${full}, ${first}, ${last}, ${status}, ${guests ?? 1}, ${note}, ${song}, ${city}, ${memory})
  `;
  return { ok: true, updated: false };
}

export async function getStats(sql) {
  const cities = await sql`
    SELECT min(btrim(from_city)) AS city, count(*)::int AS n
    FROM rsvps
    WHERE from_city IS NOT NULL AND btrim(from_city) <> ''
    GROUP BY lower(btrim(from_city))
    ORDER BY n DESC, min(created_at) ASC
    LIMIT 100
  `;
  return { ok: true, cities: cities.map(r => ({ city: r.city, n: r.n })) };
}
