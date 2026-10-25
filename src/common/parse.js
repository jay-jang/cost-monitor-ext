// Number(null), Number(''), and Number(false) are zero, but none is a usage reading.
export function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resetTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}
