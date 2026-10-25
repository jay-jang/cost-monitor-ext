export function formatReset(resetAt) {
  if (!resetAt) return '';
  const diff = resetAt - Date.now();
  if (diff <= 0) return 'Resets soon';
  const totalMin = Math.ceil(diff / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `Resets in ${d}d ${h}h`;
  if (h > 0) return `Resets in ${h}h ${m}m`;
  return `Resets in ${m}m`;
}

export function formatAgo(at) {
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60000) return 'Just now';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ago`;
}

export function clampPct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

// Claude extra_usage amounts use the currency's minor units, not whole dollars.
export function formatMinorCurrency(amount, currency = 'USD', exponent = null) {
  let formatter;
  try {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  } catch {
    return `${amount} minor units (${currency})`;
  }
  const digits = Number.isInteger(exponent) && exponent >= 0 && exponent <= 9
    ? exponent : formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(amount / (10 ** digits));
}
