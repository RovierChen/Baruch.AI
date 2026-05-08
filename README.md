# Baruch — Deploy

A branched-thinking AI tool. This package deploys as a Vercel project: a static
frontend (`public/index.html`) plus two serverless functions (`api/chat.js`,
`api/auth.js`) that proxy requests to Anthropic's API using your key.

Friends don't need their own API keys. They enter a shared password you set.

---

## What's in this folder

```
baruch-deploy/
├── public/
│   └── index.html      ← Baruch frontend (no API key inside!)
├── api/
│   ├── chat.js         ← Proxy to Anthropic. Adds your key, validates password.
│   ├── auth.js         ← Verifies the shared password.
│   └── _store.js       ← In-memory rate limiter.
├── .env.example        ← Copy to .env for local testing.
├── .gitignore          ← Keeps .env out of git.
├── vercel.json         ← Vercel routing.
├── package.json        ← Node version, ES modules.
└── README.md           ← This file.
```

---

## Step-by-step deploy

### 0. Before you start — REVOKE THE OLD KEY

If at any point you've pasted an API key into a chat or shared it: go to
https://console.anthropic.com/settings/keys and revoke it now. Create a fresh
one for Baruch.

### 1. Install Vercel CLI (one time)

```bash
npm i -g vercel
```

### 2. Push this folder to a GitHub repo

```bash
cd baruch-deploy
git init
git add .
git commit -m "initial baruch deploy"
git branch -M main
# create a repo on github.com first, then:
git remote add origin git@github.com:YOUR_USERNAME/baruch.git
git push -u origin main
```

`.gitignore` keeps `.env` out. Verify by running `git status` — `.env` should not
appear.

### 3. Connect to Vercel

In a browser: go to https://vercel.com/new, sign in with GitHub, "Import" your
new repo. Accept defaults; Vercel detects Node automatically.

### 4. Set environment variables in Vercel

In your Vercel project settings → Environment Variables, add:

| Name                  | Value                                                |
|-----------------------|------------------------------------------------------|
| `ANTHROPIC_API_KEY`   | your fresh `sk-ant-api03-...` key                    |
| `BARUCH_PASSWORD`     | the shared password your friends will type          |
| `DAILY_BUDGET_USD`    | `5` (start here; raise as you learn usage)          |
| `PER_IP_DAILY_TOKENS` | `100000`                                            |

Apply to: Production, Preview, and Development.

Click "Save", then in the Deployments tab click "Redeploy" on the latest build
so the new env vars take effect.

### 5. Visit your site

`https://your-project-name.vercel.app`

Enter the password. Use Baruch.

### 6. Share with friends

Send them:
- The URL
- The password (separately — Signal, iMessage, in person; never email)

---

## Local testing (optional)

```bash
cd baruch-deploy
cp .env.example .env
# edit .env with real values
npx vercel dev
```

This runs the frontend + serverless functions on `http://localhost:3000`. The
`.env` file is local-only.

---

## What's protected and what isn't

**Protected:**
- Your API key never reaches the browser. Friends can't see it in devtools.
- Wrong password = 401, no Anthropic call made.
- Per-IP daily token cap stops one person from running up your bill.
- Global daily $ cap is a hard kill switch.

**NOT protected (limitations to know):**
- Rate limits live in serverless function memory. Vercel may spin up multiple
  instances; counters don't share across them. For your friend group this is
  fine. For real scale, swap in Vercel KV (file `api/_store.js`).
- Anyone with the password and the URL can use Baruch on your dime. Treat the
  password like a house key.
- The shared password is a soft barrier. If someone leaks it, change it via
  the Vercel env var dashboard and all sessions invalidate on next request.

---

## Operating it

**Watching costs**: log into https://console.anthropic.com/usage daily for the
first week. The numbers will tell you whether `DAILY_BUDGET_USD=5` is right.

**Killing it fast**: in Vercel env vars, set `DAILY_BUDGET_USD=0` and redeploy.
All requests will return 429.

**Rotating the password**: change `BARUCH_PASSWORD` in Vercel env vars. Friends
get prompted to re-enter on next request. Tell them the new one out-of-band.

**Updating the code**: `git push` to main → Vercel auto-deploys.

---

## Common issues

**"Server misconfigured"** — env var not set in Vercel. Check Settings → Env Vars.

**"Daily budget reached"** — bump `DAILY_BUDGET_USD` if your usage is legit; if
not, find out who's hitting it (check Vercel logs for the IP).

**Stream cuts off after 60s** — `maxDuration` in `api/chat.js` is 60. If you
need longer responses, raise it (paid Vercel tiers allow up to 300).

**Friend says password is wrong but it's right** — they probably have a stale
`sessionStorage` from a previous wrong attempt. Tell them to refresh the page.