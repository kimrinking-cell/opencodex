import { pickLowestUsageCodexAccount, setActiveCodexAccount } from "../codex/routing";
import { clearProviderQuotaCache } from "../providers/quota";
import { getAccountSet, markAccountNeedsReauth, setActiveAccount } from "../oauth/store";
import type { OcxConfig } from "../types";

export function isAccountRetryableComboFailure(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export function rotateCodexComboAccount(
  config: OcxConfig,
  currentAccountId: string,
  attemptedAccountIds: Set<string>,
): string | null {
  attemptedAccountIds.add(currentAccountId);
  const next = pickLowestUsageCodexAccount(config, currentAccountId);
  if (!next || attemptedAccountIds.has(next)) return null;
  setActiveCodexAccount(config, next);
  return next;
}

export async function rotateOAuthComboAccount(
  provider: string,
  currentAccountId: string,
  attemptedAccountIds: Set<string>,
  status: number,
): Promise<string | null> {
  attemptedAccountIds.add(currentAccountId);
  if (status === 401) await markAccountNeedsReauth(provider, currentAccountId, true);

  const set = getAccountSet(provider);
  if (!set || set.accounts.length < 2) return null;
  const currentIndex = set.accounts.findIndex(account => account.id === currentAccountId);
  for (let offset = 1; offset <= set.accounts.length; offset += 1) {
    const index = (Math.max(currentIndex, 0) + offset) % set.accounts.length;
    const candidate = set.accounts[index]!;
    if (candidate.needsReauth || attemptedAccountIds.has(candidate.id)) continue;
    if (!await setActiveAccount(provider, candidate.id)) continue;
    clearProviderQuotaCache();
    return candidate.id;
  }
  return null;
}
