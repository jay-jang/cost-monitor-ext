import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMinorCurrency } from '../src/common/format.js';

test('minor currency amounts respect the currency exponent instead of assuming dollars', () => {
  assert.equal(formatMinorCurrency(1234), '$12.34');
  assert.equal(formatMinorCurrency(1000, 'USD', 3), '$1.00');
  assert.equal(formatMinorCurrency(1234, 'JPY'), '¥1,234');
  assert.match(formatMinorCurrency(1234, 'KWD'), /1\.234/);
  assert.equal(formatMinorCurrency(1234, 'invalid'), '1234 minor units (invalid)');
});
