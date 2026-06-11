export function formatReset(resetAt) {
  if (!resetAt) return '';
  const diff = resetAt - Date.now();
  if (diff <= 0) return '곧 리셋';
  const totalMin = Math.ceil(diff / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}일 ${h}시간 후 리셋`;
  if (h > 0) return `${h}시간 ${m}분 후 리셋`;
  return `${m}분 후 리셋`;
}

export function formatAgo(at) {
  if (!at) return '';
  const diff = Date.now() - at;
  if (diff < 60000) return '방금 전';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return `${h}시간 전`;
}

export function clampPct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}
