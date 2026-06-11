import { claude } from './claude.js';
import { codex } from './codex.js';
import { antigravity } from './antigravity.js';

// 각 프로바이더 어댑터 계약:
// {
//   id, name, color, loginUrl,
//   async fetchUsage() -> {
//     plan: string | null,
//     windows: [{ id, label, usedPct (0-100), resetAt (epoch ms | null) }],
//   }  // 실패 시 ProviderError(type: 'auth'|'network'|'parse'|'unsupported') throw
// }
export const PROVIDERS = [claude, codex, antigravity];
