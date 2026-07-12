import { atom } from 'jotai';

export interface SyntheticUsageBucket {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SyntheticQuotaCategory {
  label: string;
  limit: number;
  used: number;
  remaining: number;
  percentUsed: number;
  renewsAt?: string;
}

export interface SyntheticWeeklyTokenQuota {
  percentRemaining: number;
  percentUsed: number;
  nextRegenAt?: string;
}

export interface SyntheticQuotaData {
  subscription?: SyntheticQuotaCategory;
  searchHourly?: SyntheticQuotaCategory;
  toolCalls?: SyntheticQuotaCategory;
  weeklyTokens?: SyntheticWeeklyTokenQuota;
  available: boolean;
  error?: string;
}

export interface SyntheticUsageData {
  today: SyntheticUsageBucket;
  sevenDay: SyntheticUsageBucket;
  allTime: SyntheticUsageBucket;
  quota: SyntheticQuotaData;
  pricingAvailable: boolean;
  modelCount: number;
  lastUpdated: number;
  error?: string;
}

export const syntheticUsageAtom = atom<SyntheticUsageData | null>(null);

export const syntheticUsageAvailableAtom = atom((get) => {
  const usage = get(syntheticUsageAtom);
  if (!usage) return false;
  if (usage.error) return true;
  return usage.quota.available || usage.allTime.totalTokens > 0 || usage.allTime.costUSD > 0;
});

export const syntheticPrimaryQuotaAtom = atom((get) => {
  const usage = get(syntheticUsageAtom);
  // Match the gutter tracker to Synthetic's token-based quota when available.
  // The subscription/Energy quota is request/usage based; Mana is the closest
  // equivalent to Claude's token usage ring.
  return usage?.quota.weeklyTokens ?? usage?.quota.subscription ?? null;
});

export const syntheticUsagePrimaryColorAtom = atom((get) => {
  const primary = get(syntheticPrimaryQuotaAtom);
  if (!primary) return 'muted';
  const percentUsed = primary.percentUsed;
  if (percentUsed >= 80) return 'red';
  if (percentUsed >= 50) return 'yellow';
  return 'green';
});

export function formatResetTime(resetsAt: string | null | undefined): string {
  if (!resetsAt) return 'Unknown';
  const resetDate = new Date(resetsAt);
  const diffMs = resetDate.getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return 'Unknown';
  if (diffMs < 0) return 'Now';
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
  if (diffHours > 0) return `${diffHours}h ${diffMinutes % 60}m`;
  return `${diffMinutes}m`;
}
