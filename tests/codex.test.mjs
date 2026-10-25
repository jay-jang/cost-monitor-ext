import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodexUsage } from '../src/providers/codex.js';

const quota = (used = 25, seconds = 18000) => ({
  used_percent: used, limit_window_seconds: seconds, reset_at: 1793513537,
});

test('weekly-only accounts do not acquire a synthetic five-hour window', () => {
  const result = parseCodexUsage({ plan_type: 'prolite', rate_limit: {
    primary_window: quota(1, 604800), secondary_window: null,
  } });
  assert.equal(result.plan, 'Pro');
  assert.deepEqual(result.windows, [{ id: 'primary', label: 'Weekly', usedPct: 1, resetAt: 1793513537000 }]);
});

test('null reset_at uses the relative reset rather than epoch zero', () => {
  const before = Date.now();
  const result = parseCodexUsage({ rate_limit: { primary_window: {
    ...quota(0), reset_at: null, reset_after_seconds: 3600,
  } } });
  const [w] = result.windows;
  assert.equal(w.usedPct, 0);
  assert.ok(w.resetAt >= before + 3600_000 && w.resetAt <= Date.now() + 3600_000);
  const missing = parseCodexUsage({ rate_limit: { primary_window: { used_percent: '10', reset_at: '' } } });
  assert.equal(missing.windows[0].resetAt, null);
});

test('unknown readings never become zero usage or no active limits', () => {
  for (const used of [null, undefined, '', ' ', false, [], {}, 'NaN', 'Infinity']) {
    const result = parseCodexUsage({ rate_limit: { primary_window: { ...quota(), used_percent: used } } });
    assert.deepEqual(result.windows, []);
    assert.equal(result.noActiveLimits, false);
    assert.match(result.usageNote, /unavailable/i);
  }
});

test('code review and feature-specific quotas retain independent stable IDs', () => {
  const data = { rate_limit: { primary_window: quota() },
    code_review_rate_limit: { primary_window: quota(90, 604800) },
    additional_rate_limits: [
      { limit_name: 'Model A', metered_feature: 'model-a', rate_limit: { primary_window: quota(50, 900) } },
      { limit_name: 'Model B', metered_feature: 'model-b', rate_limit: { secondary_window: quota(75, 604800) } },
    ],
  };
  const result = parseCodexUsage(data);
  assert.deepEqual(result.windows.map(w => [w.id, w.label, w.usedPct]), [
    ['primary', 'Session (5h)', 25],
    ['code-review:primary', 'GitHub Code Review · Weekly', 90],
    ['additional:model-a:primary', 'Model A · Session (15m)', 50],
    ['additional:model-b:secondary', 'Model B · Weekly', 75],
  ]);
  data.additional_rate_limits.reverse();
  assert.deepEqual(parseCodexUsage(data).windows.map(w => w.id).sort(), result.windows.map(w => w.id).sort());
});

test('credits, spend controls and earned resets are details, not percentage windows', () => {
  const result = parseCodexUsage({ rate_limit: null,
    credits: { balance: '12.50', unlimited: false, has_credits: true, overage_limit_reached: true },
    spend_control: { reached: true, individual_limit: null },
    rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
  });
  assert.deepEqual(result.windows, []);
  assert.equal(result.noActiveLimits, true);
  assert.deepEqual(result.details.map(d => [d.id, d.value]), [
    ['credits', '12.5'], ['overage', 'Limit reached'], ['spend-control', 'Limit reached'],
    ['reset-credits', '2 available · 0 usable now'],
  ]);
  assert.equal(parseCodexUsage({ credits: { unlimited: true } }).details[0].value, 'Unlimited');
  assert.equal(parseCodexUsage({ credits: { balance: '0' } }).details[0].value, '0');
  assert.equal(parseCodexUsage({ credits: { has_credits: false } }).noActiveLimits, false);
});

test('unrecognized payloads fail parsing; explicit empty quotas are accepted', () => {
  for (const payload of [null, [], {}, { error: 'unexpected' }, { plan_type: 'pro' }, { rate_limit: {} }]) {
    assert.throws(() => parseCodexUsage(payload), e => e.type === 'parse');
  }
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } }).noActiveLimits, true);
});

test('malformed additional pools do not hide readable base limits or look fully successful', () => {
  const parsed = parseCodexUsage({ rate_limit: { primary_window: quota() }, additional_rate_limits: [
    { metered_feature: 'changed-shape', rate_limit: { unexpected: 30 } },
  ] });
  assert.equal(parsed.windows.length, 1);
  assert.match(parsed.usageNote, /unavailable/i);
  assert.equal(parsed.noActiveLimits, false);
});
