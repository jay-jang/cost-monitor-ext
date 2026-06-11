import { claude } from './claude.js';
import { codex } from './codex.js';
import { antigravity } from './antigravity.js';

// Each provider adapter contract:
// {
//   id, name, color, loginUrl,
//   async fetchUsage() -> {
//     plan: string | null,
//     windows: [{ id, label, usedPct (0-100), resetAt (epoch ms | null) }],
//   }  // On failure, throws ProviderError(type: 'auth'|'network'|'parse'|'unsupported')
// }
export const PROVIDERS = [claude, codex, antigravity];
