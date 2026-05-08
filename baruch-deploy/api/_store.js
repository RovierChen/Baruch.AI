// api/_store.js
// In-memory rate limiting + budget tracker.
//
// IMPORTANT CAVEAT: Vercel serverless functions are stateless across cold starts.
// This store works PER INSTANCE — if Vercel spins up a new instance, the counters
// reset. In practice, for low-volume use (your friends), the same warm instance
// usually serves consecutive requests, so the limiter is a meaningful soft cap.
//
// For HARD enforcement at higher scale, swap the in-memory Map for an external
// store (Vercel KV, Upstash Redis, etc.). Marked TODO below.

const ipUsage = new Map();      // ip -> { day: 'YYYY-MM-DD', tokens: number }
const globalUsage = { day: null, spentUsd: 0 };

function todayUtc() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function rolloverIfNeeded() {
  const today = todayUtc();
  if (globalUsage.day !== today) {
    globalUsage.day = today;
    globalUsage.spentUsd = 0;
    // also clear stale per-IP entries; cheap because Map is small
    for (const [ip, entry] of ipUsage.entries()) {
      if (entry.day !== today) ipUsage.delete(ip);
    }
  }
}

export function checkBudget(dailyBudgetUsd) {
  rolloverIfNeeded();
  if (globalUsage.spentUsd >= dailyBudgetUsd) {
    return { ok: false, spentUsd: globalUsage.spentUsd };
  }
  return { ok: true, spentUsd: globalUsage.spentUsd };
}

export function checkIp(ip, perIpDailyTokens) {
  rolloverIfNeeded();
  const entry = ipUsage.get(ip);
  const today = todayUtc();
  const used = entry && entry.day === today ? entry.tokens : 0;
  if (used >= perIpDailyTokens) {
    return { ok: false, usedTokens: used };
  }
  return { ok: true, usedTokens: used };
}

export function recordTokens(ip, tokens, costUsd) {
  rolloverIfNeeded();
  const today = todayUtc();
  const entry = ipUsage.get(ip);
  if (!entry || entry.day !== today) {
    ipUsage.set(ip, { day: today, tokens });
  } else {
    entry.tokens += tokens;
  }
  globalUsage.spentUsd += costUsd;
}

// TODO: For multi-instance hard enforcement, replace these functions with
// calls to Vercel KV (`@vercel/kv`) or Upstash Redis. The interface stays the
// same; only the implementation changes.
