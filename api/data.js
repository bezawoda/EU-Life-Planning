// api/data.js
// Handles GET /api/data  — fetch all dashboard state from Supabase
// Handles POST /api/data — save ratings and guardrail fields to Supabase
//
// Supabase tables used:
//   ratings    — one row per category, stores status + note
//   guardrails — one row per field (consumer_debt, roth_used, cash_used,
//                milestone_score_*, milestone_band_*, milestone_signal_*,
//                banner_sealed_dismissed_*, check_*, rev_cat_*, rev_note_*,
//                rev_win, rev_concern, rev_change)
//
// Environment variables required (set in Vercel dashboard):
//   SUPABASE_URL         — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY — service role key (keeps writes server-side only)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Small helper: make an authenticated request to Supabase REST API
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
  // Allow requests from any origin (the dashboard is served from Vercel itself)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── GET /api/data ──────────────────────────────────────────────────────
  // Returns the full dashboard state as a single flat object, identical
  // in shape to what getData() returns from localStorage.
  if (req.method === 'GET') {
    try {
      // Fetch all rows from both tables in parallel
      const [ratingsRows, guardrailsRows, reviewsRows] = await Promise.all([
        supabase('/ratings?select=*'),
        supabase('/guardrails?select=*'),
        supabase('/reviews?select=*&order=saved.desc'),
      ]);

      // Build the flat state object the dashboard expects
      const state = {};

      // ratings rows: each row has { key, status, note }
      // key is the category id (e.g. "financial", "mental")
      for (const row of ratingsRows) {
        state[`cat_${row.key}`]  = row.status || 'unrated';
        state[`note_${row.key}`] = row.note   || '';
      }

      // guardrails rows: each row has { key, value }
      // covers consumer_debt, roth_used, cash_used, check_*, rev_*, etc.
      for (const row of guardrailsRows) {
        // Booleans are stored as the string "true"/"false" — parse them back
        if (row.value === 'true')       state[row.key] = true;
        else if (row.value === 'false') state[row.key] = false;
        else                            state[row.key] = row.value;
      }

      // saved_reviews is an array stored separately in the reviews table
      // each row is a complete review snapshot stored as JSON
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
  // Saves the full state object. The body is the same flat object that
  // setData() would write to localStorage.
  if (req.method === 'POST') {
    try {
      const state = req.body;
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }

      const ratingUpserts   = [];
      const guardrailUpserts = [];

      for (const [key, value] of Object.entries(state)) {
        // Category status: keys like "cat_financial", "cat_mental"
        if (key.startsWith('cat_')) {
          const catId = key.slice(4); // strip "cat_"
          ratingUpserts.push({
            key:    catId,
            status: value,
            // note may come in a separate key; we handle it below
          });
          continue;
        }

        // Category notes: keys like "note_financial"
        // We merge these into the ratings upsert below
        if (key.startsWith('note_')) {
          const catId = key.slice(5); // strip "note_"
          // Find existing entry or create one
          const existing = ratingUpserts.find(r => r.key === catId);
          if (existing) {
            existing.note = value;
          } else {
            ratingUpserts.push({ key: catId, note: value });
          }
          continue;
        }

        // saved_reviews goes to its own table (handled by /api/append)
        if (key === 'saved_reviews') continue;

        // Everything else goes to the guardrails table as a key/value pair
        // Booleans are converted to strings so Supabase stores them cleanly
        guardrailUpserts.push({
          key:   key,
          value: String(value),
        });
      }

      // Send upserts to Supabase (insert or update based on primary key "key")
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
