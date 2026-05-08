// api/auth.js
// Lightweight password check. The frontend uses this to decide whether to show
// the chat UI or the password gate. The /api/chat endpoint independently
// re-validates the password on every request — this endpoint is just for UX.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.BARUCH_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: 'Server misconfigured: BARUCH_PASSWORD not set' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }
  }
  if (!body || typeof body.password !== 'string') {
    return res.status(400).json({ error: 'Missing password' });
  }
  if (body.password !== expected) {
    return res.status(401).json({ ok: false });
  }
  return res.status(200).json({ ok: true });
}
