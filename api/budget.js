import { neon } from '@neondatabase/serverless';
import { ensureSchema, loadState, saveState } from './_budget.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// Budget passphrase. Longer and mixed on purpose; change this string to rotate it.
// It is only ever accepted from a request header, never from the URL, so it does
// not end up in browser history, server logs, or shared links.
const BUDGET_PASSPHRASE = 'Ennis-LeVine!Ledger#2027';

function authed(req) {
  const given = req.headers && (req.headers['x-budget-key'] || req.headers['X-Budget-Key']);
  if (!given) return false;
  // constant-time-ish compare to avoid trivially timing the passphrase
  const a = String(given), b = BUDGET_PASSPHRASE;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (!authed(req)) return res.status(401).json({ error: 'Not authorized' });
  if (!connectionString) return res.status(500).json({ error: 'Database is not configured' });

  const sql = neon(connectionString);
  try {
    await ensureSchema(sql);

    if (req.method === 'GET') {
      return res.status(200).json(await loadState(sql));
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      const result = await saveState(sql, body.state || {}, body.rev);
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error, rev: result.rev });
      return res.status(200).json(result);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('budget error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
