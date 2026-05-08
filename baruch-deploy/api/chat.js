// api/chat.js
// Serverless proxy: validates a shared password, enforces rate limits,
// forwards the request to Anthropic, and streams the response back.
//
// Environment variables required:
//   ANTHROPIC_API_KEY   — your Anthropic key
//   BARUCH_PASSWORD     — shared password your friends type to unlock the app
//   DAILY_BUDGET_USD    — global kill-switch budget (default 5)
//   PER_IP_DAILY_TOKENS — per-IP daily token cap (default 100000)

import { recordTokens, checkBudget, checkIp } from './_store.js';

// Rough Opus 4.7 pricing as of mid-2026 (per million tokens).
// Update if Anthropic changes pricing.
const PRICE_INPUT_PER_M = 15;
const PRICE_OUTPUT_PER_M = 75;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // === 1. PASSWORD CHECK ===
  const expectedPassword = process.env.BARUCH_PASSWORD;
  if (!expectedPassword) {
    return res.status(500).json({ error: 'Server misconfigured: BARUCH_PASSWORD not set' });
  }

  const authHeader = req.headers['authorization'] || '';
  const providedPassword = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (providedPassword !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // === 2. RATE LIMITS ===

  // 2a. Global daily budget kill-switch
  const dailyBudgetUsd = parseFloat(process.env.DAILY_BUDGET_USD || '5');
  const budgetStatus = checkBudget(dailyBudgetUsd);
  if (!budgetStatus.ok) {
    return res.status(429).json({
      error: `Daily budget reached ($${budgetStatus.spentUsd.toFixed(2)} of $${dailyBudgetUsd}). Resets at midnight UTC.`,
    });
  }

  // 2b. Per-IP daily token cap
  const perIpDailyTokens = parseInt(process.env.PER_IP_DAILY_TOKENS || '100000', 10);
  const ip = getClientIp(req);
  const ipStatus = checkIp(ip, perIpDailyTokens);
  if (!ipStatus.ok) {
    return res.status(429).json({
      error: `Daily token cap reached for your IP (${ipStatus.usedTokens.toLocaleString()} / ${perIpDailyTokens.toLocaleString()}). Resets at midnight UTC.`,
    });
  }

  // === 3. FORWARD TO ANTHROPIC ===
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });
  }

  // Body must already be the shape Anthropic expects, with stream: true.
  // Force stream: true server-side to avoid clients disabling it.
  let body;
  try {
    body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (!body || !body.messages) {
    return res.status(400).json({ error: 'Missing messages' });
  }
  const isStreaming = body.stream === true;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Anthropic: ' + e.message });
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return res.status(upstream.status).json({
      error: 'Anthropic error: ' + errText.slice(0, 500),
    });
  }

  let inputTokens = 0;
  let outputTokens = 0;

  // === 4a. NON-STREAMING: pass through JSON, then account tokens ===
  if (!isStreaming) {
    let json;
    try {
      json = await upstream.json();
    } catch (e) {
      return res.status(502).json({ error: 'Bad upstream JSON' });
    }
    if (json.usage) {
      inputTokens = json.usage.input_tokens || 0;
      outputTokens = json.usage.output_tokens || 0;
    }
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(json);
    if (inputTokens > 0 || outputTokens > 0) {
      const cost =
        (inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
        (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
      recordTokens(ip, inputTokens + outputTokens, cost);
    }
    return;
  }

  // === 4b. STREAMING: pass through SSE bytes, parse out usage in parallel ===
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tell any proxy not to buffer

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Pass through to client immediately
      res.write(chunk);

      // Also parse to capture usage info from message_start / message_delta events
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const ev of events) {
        const dataLine = ev.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const obj = JSON.parse(dataLine.slice(6));
          if (obj.type === 'message_start' && obj.message?.usage) {
            inputTokens = obj.message.usage.input_tokens || 0;
            outputTokens = obj.message.usage.output_tokens || 0;
          } else if (obj.type === 'message_delta' && obj.usage) {
            // message_delta carries the FINAL output_tokens count
            if (typeof obj.usage.output_tokens === 'number') {
              outputTokens = obj.usage.output_tokens;
            }
          }
        } catch (_) { /* ignore parse errors on partial chunks */ }
      }
    }
  } catch (e) {
    // upstream broke mid-stream; just end
    console.error('Stream error:', e.message);
  }

  res.end();

  // Account tokens after the response is closed.
  if (inputTokens > 0 || outputTokens > 0) {
    const cost =
      (inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
      (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
    recordTokens(ip, inputTokens + outputTokens, cost);
  }
}

function getClientIp(req) {
  // Vercel sets x-forwarded-for; first entry is the real client.
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Tell Vercel this is a streaming function with a longer max duration.
// Default Hobby tier max duration is 10s — for streaming Opus we need more.
export const config = {
  maxDuration: 60,
};
