import { neon } from '@neondatabase/serverless';
import {
  ensureSchema, listPlans, loadState, saveState,
  createPlan, duplicatePlan, renamePlan, deletePlan, listRsvpGuests,
} from './_seating.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// Private planner password. Change this string to rotate it.
const PLANNER_PASSWORD = 'seating2027';

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

function authed(req) {
  let given = '';
  try {
    const u = new URL(req.url, 'http://x');
    given = u.searchParams.get('p') || '';
  } catch (_) {}
  if (!given && req.headers && req.headers['x-planner-key']) {
    given = String(req.headers['x-planner-key']);
  }
  if (!given) given = parseBody(req).password || '';
  return String(given) === PLANNER_PASSWORD;
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
      let planId = '';
      try { planId = new URL(req.url, 'http://x').searchParams.get('plan') || ''; } catch (_) {}
      const state = await loadState(sql, planId);
      return res.status(200).json({
        ok: true,
        plans: await listPlans(sql),
        state,
        rsvpGuests: await listRsvpGuests(sql),
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const action = String(body.action || 'save');
      let result;

      if (action === 'save')            result = await saveState(sql, body.planId, body.state || {}, body.rev);
      else if (action === 'createPlan') result = await createPlan(sql, body.name);
      else if (action === 'duplicatePlan') result = await duplicatePlan(sql, body.planId, body.name);
      else if (action === 'renamePlan') result = await renamePlan(sql, body.planId, body.name);
      else if (action === 'deletePlan') result = await deletePlan(sql, body.planId);
      else return res.status(400).json({ error: 'Unknown action' });

      if (!result.ok) return res.status(result.status || 400).json({ error: result.error, rev: result.rev });
      result.plans = await listPlans(sql);
      return res.status(200).json(result);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('seating error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
