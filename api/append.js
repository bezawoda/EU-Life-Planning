// api/append.js
// POST /api/append — add a comment, save a review, or update a reaction
//
// Body shapes:
//   { type: 'comment', name: 'Alice', text: 'Great progress!' }
//   { type: 'review', data: { ...reviewSnapshot } }
//   { type: 'reaction', milestone_idx: 0, emoji: '🎉', count: 3 }

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
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${text}`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  if (!body || !body.type) return res.status(400).json({ error: 'Body must include a "type" field' });

  try {
    // ── New comment ──────────────────────────────────────────────────
    if (body.type === 'comment') {
      if (!body.text) return res.status(400).json({ error: 'Comment requires a "text" field' });
      const row = {
        name:      (body.name || 'Anonymous').trim(),
        text:      body.text.trim(),
        timestamp: new Date().toISOString(),
      };
      const result = await supabase('/comments', { method: 'POST', body: JSON.stringify(row) });
      return res.status(201).json({ ok: true, comment: result[0] || row });
    }

    // ── Save quarterly review ────────────────────────────────────────
    if (body.type === 'review') {
      if (!body.data) return res.status(400).json({ error: 'Review requires a "data" object' });
      const row = {
        data:  JSON.stringify(body.data),
        saved: body.data.saved || new Date().toISOString(),
      };
      const result = await supabase('/reviews', { method: 'POST', body: JSON.stringify(row) });
      return res.status(201).json({ ok: true, review: result[0] || row });
    }

    // ── Reaction upsert ──────────────────────────────────────────────
    if (body.type === 'reaction') {
      const { milestone_idx, emoji, count } = body;
      if (milestone_idx === undefined || !emoji) return res.status(400).json({ error: 'Reaction requires milestone_idx and emoji' });
      const row = { milestone_idx: Number(milestone_idx), emoji, count: Number(count) || 1 };
      await supabase('/reactions', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown type: ${body.type}` });
  } catch (err) {
    console.error('POST /api/append failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
