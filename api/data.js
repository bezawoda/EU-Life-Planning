// api/data.js
// Handles GET /api/data  — fetch all dashboard state from Supabase
// Handles POST /api/data — save ratings and guardrail fields to Supabase
//
// Environment variables required (set in Vercel dashboard):
//   SUPABASE_URL         — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY — service role key

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...options.headers,
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : [];

  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── GET /api/data ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const [ratingsRows, guardrailsRows, reviewsRows] = await Promise.all([
        supabase('/ratings?select=*'),
        supabase('/guardrails?select=*'),
        supabase('/reviews?select=*&order=saved.desc'),
      ]);

      const state = {};

      for (const row of ratingsRows) {
        state[`cat_${row.key}`]  = row.status || 'unrated';
        state[`note_${row.key}`] = row.note   || '';
      }

      for (const row of guardrailsRows) {
        if (row.value === 'true')       state[row.key] = true;
        else if (row.value === 'false') state[row.key] = false;
        else                            state[row.key] = row.value;
      }

      if (reviewsRows.length > 0) {
        state.saved_reviews = reviewsRows.map(r => {
          try { return JSON.parse(r.data); } catch { return r.data; }
        });
      }

      return res.status(200).json(state);
    } catch (err) {
      console.error('GET /api/data failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST /api/data ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const state = req.body;
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }

      // Build ratings rows — collect cat_ and note_ keys into a map first
      // so every row has identical keys (key, status, note) — Supabase requires this
      const ratingsMap = {};
      for (const [key, value] of Object.entries(state)) {
        if (key.startsWith('cat_')) {
          const catId = key.slice(4);
          ratingsMap[catId] = ratingsMap[catId] || {};
          ratingsMap[catId].status = value;
        }
        if (key.startsWith('note_')) {
          const catId = key.slice(5);
          ratingsMap[catId] = ratingsMap[catId] || {};
          ratingsMap[catId].note = value;
        }
      }
      const ratingUpserts = Object.entries(ratingsMap).map(([catId, fields]) => ({
        key:    catId,
        status: fields.status || 'unrated',
        note:   fields.note   || '',
      }));

      // Build guardrails rows — everything else except saved_reviews
      const guardrailUpserts = [];
      for (const [key, value] of Object.entries(state)) {
        if (key.startsWith('cat_') || key.startsWith('note_')) continue;
        if (key === 'saved_reviews') continue;
        guardrailUpserts.push({ key, value: String(value) });
      }

      const ops = [];

      if (ratingUpserts.length > 0) {
        ops.push(
          supabase('/ratings', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(ratingUpserts),
          })
        );
      }

      if (guardrailUpserts.length > 0) {
        ops.push(
          supabase('/guardrails', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(guardrailUpserts),
          })
        );
      }

      await Promise.all(ops);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('POST /api/data failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
