import { neon } from '@neondatabase/serverless';
import { ensureRsvpSchema, getStats } from './_db.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!connectionString) return res.status(200).json({ ok: false });
  try {
    const sql = neon(connectionString);
    await ensureRsvpSchema(sql);
    return res.status(200).json(await getStats(sql));
  } catch (err) {
    console.error('stats failed:', err);
    return res.status(200).json({ ok: false });
  }
}
