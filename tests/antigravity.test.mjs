import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { antigravity } from '../src/providers/antigravity.js';

// Sanitized shape observed on both Cloud Code backends on 2026-10-25.
const summary = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95045567,
          resetTime: '2026-10-26T00:11:14Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1,
          resetTime: '2026-10-25T11:31:40Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1,
          resetTime: '2026-11-01T06:31:40Z' },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1,
          resetTime: '2026-10-25T11:31:40Z' },
      ],
    },
    {
      displayName: 'Gemini 4 Argon',
      buckets: [
        { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 1,
          resetTime: '2026-10-31T18:30:31Z' },
      ],
    },
  ],
};

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
const originalSelf = globalThis.self;
let stored;
let requests;
let uaRule;
let backgroundImport = 0;

beforeEach(async () => {
  stored = {
    agTokens: { accessToken: 'test-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600_000 },
    agProject: { project: 'test-project', tier: 'Pro', at: Date.now() },
  };
  requests = [];
  const event = () => ({ addListener() {} });
  globalThis.self = { navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } };
  globalThis.chrome = {
    declarativeNetRequest: { async updateDynamicRules({ removeRuleIds, addRules }) {
      assert.ok(removeRuleIds.includes(1), 'replace the persisted rule on existing installs');
      [uaRule] = addRules;
    } },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
    alarms: { onAlarm: event() },
    tabs: { onUpdated: event() },
    storage: { local: {
      async get(key) { return { [key]: stored[key] }; },
      async set(values) { Object.assign(stored, values); },
    }, onChanged: event() },
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith(':loadCodeAssist')) {
      return Response.json({ cloudaicompanionProject: 'test-project', paidTier: { id: 'g1-pro-tier' } });
    }
    if (url.endsWith(':retrieveUserQuotaSummary')) {
      // Reproduce the live version gate using the actual rule registered by background.js.
      const ua = uaRule.action.requestHeaders.find(h => h.header === 'user-agent').value;
      const version = ua.match(/^antigravity\/(\S+) /)?.[1];
      assert.ok(['2.0.4', '2.11.0', 'cli/1.4.7'].includes(version), 'use a verified response fixture');
      const groups = version === 'cli/1.4.7' ? summary.groups
        : version === '2.11.0' ? summary.groups.slice(0, 2) : [summary.groups[1]];
      return Response.json({ groups });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  // Re-evaluate service-worker startup so the provider tests use the registered header rule.
  await import(`../src/background.js?test=${++backgroundImport}`);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
});

test('startup replaces the persisted User-Agent rule for both quota backends', () => {
  assert.equal(uaRule.id, 1);
  assert.equal(uaRule.action.type, 'modifyHeaders');
  assert.deepEqual(uaRule.condition.resourceTypes, ['xmlhttprequest']);
  const filter = uaRule.condition.urlFilter;
  for (const host of ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com']) {
    assert.ok(`https://${host}/v1internal:retrieveUserQuotaSummary`.includes(filter));
  }
  assert.equal(uaRule.action.requestHeaders[0].operation, 'set');
});

for (const cached of [true, false]) {
  test(`Gemini and separate Argon quotas survive a ${cached ? 'cached' : 'fresh'} project lookup`, async () => {
    if (!cached) delete stored.agProject;
    const result = await antigravity.fetchUsage();
    assert.equal(result.plan, 'Pro');
    assert.deepEqual(result.windows.map(w => w.id), [
      'gemini-weekly', 'gemini-5h', '3p-weekly', '3p-5h', 'gemini-argon-wtu-weekly',
    ]);
    const gemini = result.windows[0];
    assert.equal(gemini.label, 'Gemini · Weekly');
    assert.ok(Math.abs(gemini.usedPct - 4.954433) < 0.000001);
    assert.equal(gemini.resetAt, Date.parse('2026-10-26T00:11:14Z'));
    assert.equal(result.windows[1].label, 'Gemini · 5h');
    assert.equal(result.windows[1].usedPct, 0);
    assert.deepEqual(result.windows[4], {
      id: 'gemini-argon-wtu-weekly', label: 'Gemini 4 Argon · Weekly', usedPct: 0,
      resetAt: Date.parse('2026-10-31T18:30:31Z'),
    });
    const quotaRequests = requests.filter(r => r.url.endsWith(':retrieveUserQuotaSummary'));
    assert.deepEqual(quotaRequests.map(r => new URL(r.url).hostname).sort(), [
      'cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com',
    ]);
    for (const r of quotaRequests) assert.deepEqual(r.body, { project: 'test-project' });
  });
}

test('Argon buckets merge across backends without replacing Gemini, including exhaustion', async () => {
  globalThis.fetch = async (url) => {
    const data = structuredClone(summary);
    const bucket = data.groups[2].buckets[0];
    if (url.includes('daily-cloudcode-pa')) delete bucket.remainingFraction;
    else bucket.remainingFraction = 0.6;
    return Response.json(data);
  };
  const result = await antigravity.fetchUsage();
  assert.equal(result.windows.length, 5);
  assert.equal(result.windows.find(w => w.id === 'gemini-argon-wtu-weekly').usedPct, 100);
  assert.ok(result.windows.find(w => w.id === 'gemini-weekly').usedPct < 5);
});

test('plans without a separate server-reported Argon bucket do not get a synthetic limit', async () => {
  stored.agProject.tier = 'Ultra';
  globalThis.fetch = async () => Response.json({ groups: summary.groups.slice(0, 2) });
  const result = await antigravity.fetchUsage();
  assert.equal(result.plan, 'Ultra');
  assert.equal(result.windows.length, 4);
  assert.ok(result.windows.every(w => !w.id.includes('argon')));
});

test('legacy model fallback still receives its project when summaries are unavailable', async () => {
  globalThis.fetch = async (url, init) => {
    if (url.endsWith(':retrieveUserQuotaSummary')) return new Response('', { status: 503 });
    assert.ok(url.endsWith(':fetchAvailableModels'));
    assert.deepEqual(JSON.parse(init.body), { project: 'test-project' });
    return Response.json({ models: {
      'gemini-3-flash': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: {
        resetTime: '2026-10-25T11:31:40Z',
      } },
    } });
  };
  const result = await antigravity.fetchUsage();
  assert.deepEqual(result.windows, [{
    id: 'gemini', label: 'Gemini', usedPct: 100,
    resetAt: Date.parse('2026-10-25T11:31:40Z'),
  }]);
});

for (const array of [false, true]) {
  test(`model fallback keeps Argon's Google-provider quota separate (${array ? 'array' : 'map'})`, async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith(':retrieveUserQuotaSummary')) return new Response('', { status: 503 });
      const models = {
        'gemini-3.8-flash': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.9 } },
        'gemini-4-argon-medium': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: {
          remainingFraction: 0.5, resetTime: '2026-10-31T18:30:31Z',
        } },
        'gemini-4-argon-high': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: {
          resetTime: '2026-10-31T18:30:31Z',
        } },
      };
      return Response.json({ models: array ? Object.entries(models).map(([id, m]) => ({ id, ...m })) : models });
    };
    const result = await antigravity.fetchUsage();
    assert.deepEqual(result.windows.map(w => w.id), ['gemini', 'argon']);
    assert.ok(result.windows[0].usedPct < 11);
    assert.deepEqual(result.windows[1], {
      id: 'argon', label: 'Gemini 4 Argon', usedPct: 100,
      resetAt: Date.parse('2026-10-31T18:30:31Z'),
    });
  });
}

test('an unrecognized model fallback is a parse error rather than no active limits', async () => {
  globalThis.fetch = async (url) => url.endsWith(':retrieveUserQuotaSummary')
    ? new Response('', { status: 503 }) : Response.json({ unexpected: true });
  await assert.rejects(antigravity.fetchUsage(), e => e.type === 'parse');
});
