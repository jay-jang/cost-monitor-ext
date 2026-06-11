export const DEFAULT_OPTIONS = {
  providers: { claude: true, codex: true, antigravity: true },
  pollMinutes: 5,
  warnPct: 75,
  critPct: 90,
  notify: true,
  themeMode: 'dark',
  themeDark: 'midnight',
  themeLight: 'classic',
  badgeMode: 'remaining', // 'remaining' or 'used'
};

export async function getOptions() {
  const { options } = await chrome.storage.sync.get('options');
  return {
    ...DEFAULT_OPTIONS,
    ...(options || {}),
    providers: { ...DEFAULT_OPTIONS.providers, ...(options?.providers || {}) },
  };
}

export async function setOptions(options) {
  await chrome.storage.sync.set({ options });
}
