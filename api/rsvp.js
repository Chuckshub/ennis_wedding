import { neon } from '@neondatabase/serverless';
import { ensureRsvpSchema, saveRsvp } from './_db.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!connectionString) {
    console.error('No DATABASE_URL / POSTGRES_URL is set');
    return res.status(500).json({ error: 'Database is not configured' });
  }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const sql = neon(connectionString);
    await ensureRsvpSchema(sql);
    const result = await saveRsvp(sql, body || {});
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Bad request' });
    return res.status(200).json({ ok: true, updated: result.updated });
  } catch (err) {
    console.error('RSVP save failed:', err);
    return res.status(500).json({ error: 'Could not save RSVP' });
  }
}
