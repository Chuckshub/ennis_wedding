# Mandy & Charlie — Wedding Site + Seating Planner

## Push these files (keep the folder layout)

```
index.html          the public wedding site (no password)
planner.html        private seating planner (password: seating2027)
budget.html         private budget tracker (passphrase: Ennis-LeVine!Ledger#2027)
package.json        dependency for the database functions
api/_db.js          RSVP data layer + auto-migration
api/rsvp.js         POST /api/rsvp   saves an RSVP
api/stats.js        GET  /api/stats  city list for the site
api/_seating.js     seating data layer + auto-migration
api/seating.js      GET/POST /api/seating  the planner's backend
api/_budget.js      budget data layer + auto-migration
api/budget.js       GET/POST /api/budget   the budget's backend
```

`package.json` and the `api/` folder must sit at the SAME level as `index.html`.
Keep your existing `vercel.json` as is.

Reference only, not required at runtime:
`schema.sql`, `migration.sql`, `seating-schema.sql`.

## No SQL to run

Both APIs create and upgrade their own tables on first request, using
`CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. Just push and
redeploy. Existing data is preserved.

- RSVPs live in the public `rsvps` table.
- The planner lives in its own `planning` schema (plans, tables, guests) and
  never touches `rsvps`.
- The budget lives in its own `budget` schema (settings, groups, items, payments).

## Passwords
- Planner: `seating2027` — in `api/seating.js`, `PLANNER_PASSWORD`
- Budget: `Ennis-LeVine!Ledger#2027` — in `api/budget.js`, `BUDGET_PASSPHRASE`.
  Sent only as a request header, never in the URL, so it stays out of history and logs.

## Checking data in the Neon SQL editor

```sql
-- RSVPs, newest first
SELECT first_name, last_name, attending, guests, note, song, from_city, created_at
FROM rsvps ORDER BY created_at DESC;

-- Private memories collected for the slideshow
SELECT first_name, last_name, memory FROM rsvps WHERE memory <> '';

-- Seating, one version
SELECT p.name AS version, t.label, t.nickname, g.first_name, g.last_name
FROM planning.guests g
JOIN planning.plans p ON p.id = g.plan_id
LEFT JOIN planning.tables t ON t.id = g.table_id
ORDER BY p.name, t.label, g.seat_index;
```

## Budget data in the Neon SQL editor
```sql
SELECT g.name AS "group", i.name AS item, i.vendor, i.status, i.estimate, i.actual,
       COALESCE(SUM(p.amount) FILTER (WHERE p.paid_on IS NOT NULL),0) AS paid
FROM budget.items i
JOIN budget.groups g ON g.id = i.group_id
LEFT JOIN budget.payments p ON p.item_id = i.id
GROUP BY g.sort, g.name, i.sort, i.name, i.vendor, i.status, i.estimate, i.actual
ORDER BY g.sort, i.sort;
```
