import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  callRetrieveUserQuotaSummary,
  createQuotaClient,
  normalizeQuotaSummary,
  parseLsAddress,
} from '../sidecars/agy_monitor/backend/quota.mjs';

const OFFICIAL_SAMPLE_PAYLOAD = {
  response: {
    groups: [
      {
        displayName: 'Gemini 4 Argon',
        description: 'For paid Pro plans, Argon quota is separate.',
        buckets: [
          {
            bucketId: 'gemini-argon-wtu-weekly',
            displayName: 'Gemini 4 Argon Weekly Limit',
            description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 11 hours.',
            window: 'weekly',
            remainingFraction: 0.99977106,
            resetTime: '2026-11-28T12:23:36Z',
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit Remaining',
            description: 'You have used some of your weekly limit, it will fully refresh in 3 days, 2 hours.',
            window: 'weekly',
            remainingFraction: 0.2681544,
            resetTime: '2026-11-25T02:43:23Z',
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-11-22T05:38:07Z',
          },
        ],
      },
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 8 hours.',
            window: 'weekly',
            remainingFraction: 0.6098353,
            resetTime: '2026-11-28T08:51:12Z',
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            description: 'You have used some of your 5-hour limit, it will fully refresh in 4 hours, 51 minutes.',
            window: '5h',
            remainingFraction: 0.91942465,
            resetTime: '2026-11-22T05:29:46Z',
          },
        ],
      },
    ],
    description: 'Within each group, models share a weekly limit and a 5-hour limit.',
  },
};

test('parseLsAddress accepts loopback forms and rejects non-loopback hosts', () => {
  assert.deepEqual(parseLsAddress('localhost:61464'), {
    protocol: 'http',
    hostname: 'localhost',
    port: 61464,
  });
  assert.deepEqual(parseLsAddress('https://127.0.0.1:61463'), {
    protocol: 'https',
    hostname: '127.0.0.1',
    port: 61463,
  });
  assert.deepEqual(parseLsAddress('http://[::1]:55123'), {
    protocol: 'http',
    hostname: '::1',
    port: 55123,
  });

  // SSRF / non-loopback rejection
  assert.equal(parseLsAddress('https://evil.example.com:443'), null);
  assert.equal(parseLsAddress('192.168.1.10:61464'), null);
  assert.equal(parseLsAddress('ftp://127.0.0.1:61464'), null);
  assert.equal(parseLsAddress(''), null);
});

test('normalizeQuotaSummary orders Gemini -> GPT&Claude, drops legacy Argon pool, and preserves bucket semantics', () => {
  const nowMs = Date.parse('2026-11-22T00:38:31Z');
  const res = normalizeQuotaSummary(OFFICIAL_SAMPLE_PAYLOAD, nowMs);

  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.deepEqual(
    res.groups.map((g) => g.label),
    ['Gemini', 'GPT&Claude'],
  );

  const [gemini, gptClaude] = res.groups;
  assert.equal(gemini.fiveHour.remainingPct, 92);
  assert.equal(gemini.fiveHour.isFull, false);
  assert.equal(gemini.weekly.remainingPct, 61);
  assert.equal(gemini.weekly.isFull, false);

  assert.equal(gptClaude.fiveHour.remainingPct, 100);
  assert.equal(gptClaude.fiveHour.isFull, true);
  assert.equal(gptClaude.weekly.remainingPct, 27);
  assert.equal(gptClaude.weekly.isFull, false);
});

test('callRetrieveUserQuotaSummary and createQuotaClient handle live HTTP, caching, and stale fallback', async (t) => {
  let reqCount = 0;
  let shouldFail = false;
  let lastHeaderToken = '';
  let lastPath = '';

  const server = http.createServer((req, res) => {
    reqCount += 1;
    lastHeaderToken = String(req.headers['x-codeium-csrf-token'] || '');
    lastPath = String(req.url || '');
    if (shouldFail) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'unavailable', message: 'backend unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(OFFICIAL_SAMPLE_PAYLOAD));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  let fakeNow = Date.parse('2026-11-22T00:38:31Z');
  const client = createQuotaClient({
    env: {
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-secret-test',
    },
    ttlMs: 30_000,
    minForceIntervalMs: 2_500,
    fetcher: callRetrieveUserQuotaSummary,
    now: () => fakeNow,
  });

  const first = await client.getQuotaSummary();
  assert.equal(first.ok, true);
  assert.equal(first.stale, false);
  assert.equal(reqCount, 1);
  assert.equal(lastHeaderToken, 'csrf-secret-test');
  assert.equal(lastPath, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');

  // Within TTL -> returns cache without hitting server
  fakeNow += 10_000;
  const second = await client.getQuotaSummary();
  assert.equal(reqCount, 1);
  assert.equal(second.groups.length, 2);

  // Force refresh after minForceIntervalMs hits server and handles failure via stale cache
  shouldFail = true;
  fakeNow += 5_000;
  const staleRes = await client.getQuotaSummary({ force: true });
  assert.equal(reqCount, 2);
  assert.equal(staleRes.ok, true);
  assert.equal(staleRes.stale, true);
  assert.equal(staleRes.groups.length, 2);

  // Missing env degrades cleanly without throwing
  const emptyClient = createQuotaClient({ env: {} });
  const unavail = await emptyClient.getQuotaSummary();
  assert.equal(unavail.ok, false);
  assert.equal(unavail.available, false);
  assert.equal(unavail.code, 'env_unavailable');
});
