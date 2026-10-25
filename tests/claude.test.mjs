import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { claude, parseClaudeUsage } from '../src/providers/claude.js';

// limits[] field names/units are from the installed Claude Code 2.1.310 schema.
const scoped = (name = 'Fable') => ({ kind: 'weekly_scoped', group: 'weekly', percent: 62,
  scope: { model: { display_name: name } }, resets_at: '2026-11-01T00:00:00Z',
  severity: 'warning', is_active: true,
});

test('server-defined meters include Fable and future models without duplicating legacy totals', () => {
  const data = { five_hour: { utilization: 99 }, limits: [
    { kind: 'session', group: 'session', percent: 25, resets_at: null },
    { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: 'invalid' },
    scoped(), scoped('Future Model'),
  ] };
  const result = parseClaudeUsage(data);
  assert.deepEqual(result.windows.map(w => [w.label, w.usedPct]), [
    ['Session', 25], ['Weekly (Total)', 40], ['Weekly (Fable)', 62], ['Weekly (Future Model)', 62],
  ]);
  assert.equal(result.windows[0].resetAt, null);
  assert.equal(result.windows[1].resetAt, null);
  assert.equal(result.windows[2].resetAt, Date.parse('2026-11-01T00:00:00Z'));
  data.limits.reverse();
  assert.deepEqual(parseClaudeUsage(data).windows.map(w => w.id).sort(), result.windows.map(w => w.id).sort());
});

test('legacy windows remain supported, including previously unknown model suffixes', () => {
  const result = parseClaudeUsage({ limits: null, five_hour: { utilization: 0 },
    seven_day: null, seven_day_opus: { utilization: '12.5' }, seven_day_fable: { utilization_pct: 30 },
  });
  assert.deepEqual(result.windows.map(w => [w.id, w.label, w.usedPct]), [
    ['five_hour', 'Session (5h)', 0], ['seven_day_opus', 'Weekly (Opus)', 12.5],
    ['seven_day_fable', 'Weekly (Fable)', 30],
  ]);
});

test('extra usage minor units are formatted as money, including disabled and missing spend', () => {
  const result = parseClaudeUsage({ limits: [], extra_usage: {
    is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD',
  } });
  assert.equal(result.noActiveLimits, true);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.details.map(d => d.value), ['Enabled', '$12.34 / $50.00']);
  const disabled = parseClaudeUsage({ extra_usage: {
    is_enabled: false, used_credits: 0, monthly_limit: null,
  } });
  assert.deepEqual(disabled.details.map(d => d.value), ['Disabled', '$0.00 / limit unavailable']);
  assert.equal(disabled.noActiveLimits, false);
  const missing = parseClaudeUsage({ extra_usage: { is_enabled: true, used_credits: null, monthly_limit: 1000 } });
  assert.equal(missing.details[1].value, 'Unavailable / $10.00');
});

test('current typed spend takes precedence over legacy extra_usage and honors explicit money exponents', () => {
  const result = parseClaudeUsage({ limits: [scoped()],
    extra_usage: { is_enabled: true, used_credits: 99999, monthly_limit: 99999 },
    spend: { enabled: false, used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 50000, currency: 'USD', exponent: 3 } },
  });
  assert.deepEqual(result.details.map(d => d.value), ['Disabled', '$12.34 / $50.00']);
  const emptySpend = parseClaudeUsage({ spend: { enabled: false,
    used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null } });
  assert.deepEqual(emptySpend.details.map(d => d.value), ['Disabled', '$0.00 / limit unavailable']);
  assert.equal(emptySpend.noActiveLimits, false);
});

test('only explicit empty responses mean no active limits; incomplete rows remain visible as unavailable', () => {
  for (const data of [{ limits: [] }, { five_hour: null, seven_day: null }]) {
    assert.equal(parseClaudeUsage(data).noActiveLimits, true);
  }
  for (const data of [{ limits: [{ ...scoped(), percent: null }] }, { five_hour: {} },
    { limits: [scoped(), null] }, { limits: [scoped()], extra_usage: {} }]) {
    const result = parseClaudeUsage(data);
    assert.equal(result.noActiveLimits, false);
    assert.match(result.usageNote, /unavailable/i);
  }
  for (const data of [{}, [], null, { unexpected: true }, { limits: {} }]) {
    assert.throws(() => parseClaudeUsage(data), e => e.type === 'parse');
  }
});

const originals = { fetch: globalThis.fetch, chrome: globalThis.chrome };
afterEach(() => {
  globalThis.fetch = originals.fetch;
  if (originals.chrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originals.chrome;
});

test('an organization switch invalidates otherwise fresh metadata before the usage request', async () => {
  const stored = { claudeOrg: { uuid: 'old-org', plan: 'Pro', at: Date.now() } };
  const requests = [];
  globalThis.chrome = {
    cookies: { async get() { return { value: 'new-org' }; } },
    storage: { local: {
      async get() { return stored; }, async set(values) { Object.assign(stored, values); },
    } },
  };
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith('/organizations')) return Response.json([
      { uuid: 'old-org', capabilities: ['chat'], rate_limit_tier: 'pro' },
      { uuid: 'new-org', capabilities: ['chat'], rate_limit_tier: 'team' },
    ]);
    return Response.json({ limits: [scoped()] });
  };
  const result = await claude.fetchUsage();
  assert.equal(result.plan, 'Team');
  assert.equal(stored.claudeOrg.uuid, 'new-org');
  assert.deepEqual(requests, ['https://claude.ai/api/organizations', 'https://claude.ai/api/organizations/new-org/usage']);
});

test('unchanged organization uses the cache; a missing cookie permission does not break it', async () => {
  for (const denied of [false, true]) {
    globalThis.chrome = {
      cookies: { async get() { if (denied) throw new Error('permission'); return { value: 'current-org' }; } },
      storage: { local: { async get() { return { claudeOrg: { uuid: 'current-org', at: Date.now() } }; } } },
    };
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://claude.ai/api/organizations/current-org/usage');
      return Response.json({ limits: [] });
    };
    assert.equal((await claude.fetchUsage()).noActiveLimits, true);
  }
});

test('a selected unavailable workspace does not silently fall back to another account', async () => {
  globalThis.chrome = {
    cookies: { async get() { return { value: 'missing-org' }; } },
    storage: { local: { async get() { return {}; } } },
  };
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://claude.ai/api/organizations');
    return Response.json([{ uuid: 'other-org', capabilities: ['chat'] }]);
  };
  await assert.rejects(claude.fetchUsage(), e => e.type === 'unsupported');
});

test('a removed organization triggers one rediscovery and uses the new active workspace', async () => {
  let selected = 'old-org';
  let discovery = 0;
  globalThis.chrome = {
    cookies: { async get() { return { value: selected }; } },
    storage: { local: {
      async get() { return { claudeOrg: { uuid: 'old-org', at: Date.now() } }; }, async set() {},
    } },
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith('/old-org/usage')) { selected = 'new-org'; return new Response('', { status: 404 }); }
    if (url.endsWith('/organizations')) {
      discovery++;
      return Response.json([{ uuid: 'new-org', capabilities: ['chat'] }]);
    }
    assert.ok(url.endsWith('/new-org/usage'));
    return Response.json({ limits: [] });
  };
  assert.equal((await claude.fetchUsage()).noActiveLimits, true);
  assert.equal(discovery, 1);
});
