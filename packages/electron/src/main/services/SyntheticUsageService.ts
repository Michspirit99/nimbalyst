/**
 * SyntheticUsageService - Tracks Synthetic.new quotas plus local spend estimates.
 *
 * Synthetic exposes official quota usage at /v2/quotas and per-model pricing at
 * /openai/v1/models. Quotas are authoritative for the configured API key; spend
 * remains an estimate computed from Nimbalyst's persisted token usage.
 */

import { BrowserWindow } from 'electron';
import { getDatabase } from '../database/initialize';
import { logger } from '../utils/logger';
import { getProviderApiKeyFromSettings } from '../utils/store';

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
  today: { costUSD: number; inputTokens: number; outputTokens: number; totalTokens: number };
  sevenDay: { costUSD: number; inputTokens: number; outputTokens: number; totalTokens: number };
  allTime: { costUSD: number; inputTokens: number; outputTokens: number; totalTokens: number };
  quota: SyntheticQuotaData;
  pricingAvailable: boolean;
  modelCount: number;
  lastUpdated: number;
  error?: string;
}

interface Price { inputPerToken: number; outputPerToken: number }
interface UsageRow { model: string | null; created_at: unknown; metadata: unknown }

const MODELS_URL = 'https://api.synthetic.new/openai/v1/models';
const QUOTAS_URL = 'https://api.synthetic.new/v2/quotas';
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

class SyntheticUsageServiceImpl {
  private cachedUsage: SyntheticUsageData | null = null;
  private pricing = new Map<string, Price>();
  private pricingFetchedAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime = 0;
  private isPolling = false;
  private isSleeping = true;

  initialize(): void {
    logger.main.info('[SyntheticUsageService] Initialized (sleeping until activity detected)');
  }

  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();
    if (this.isSleeping) {
      this.isSleeping = false;
      this.startPolling();
      await this.refresh();
    }
  }

  getCachedUsage(): SyntheticUsageData | null { return this.cachedUsage; }

  async refresh(): Promise<SyntheticUsageData> {
    try {
      const quota = await this.fetchQuotaBestEffort();
      await this.refreshPricingBestEffort();
      const rows = await this.loadSyntheticSessionRows();
      const data = this.aggregate(rows, quota);
      this.cachedUsage = data;
      this.broadcastUpdate();
      return data;
    } catch (error) {
      logger.main.error('[SyntheticUsageService] Error refreshing usage:', error);
      const data: SyntheticUsageData = {
        today: emptyBucket(), sevenDay: emptyBucket(), allTime: emptyBucket(),
        quota: { available: false },
        pricingAvailable: this.pricing.size > 0,
        modelCount: this.pricing.size,
        lastUpdated: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error reading Synthetic usage',
      };
      this.cachedUsage = data;
      this.broadcastUpdate();
      return data;
    }
  }

  stop(): void {
    this.stopPolling();
    logger.main.info('[SyntheticUsageService] Stopped');
  }

  private async fetchQuotaBestEffort(): Promise<SyntheticQuotaData> {
    const apiKey = getProviderApiKeyFromSettings('synthetic');
    if (!apiKey) return { available: false, error: 'Synthetic.new API key not configured' };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(QUOTAS_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return { available: false, error: 'Synthetic.new API key was rejected' };
        throw new Error(`Synthetic quotas returned ${response.status}`);
      }
      const json = await response.json();
      return parseQuotaResponse(json);
    } catch (error) {
      logger.main.warn('[SyntheticUsageService] Failed to refresh quotas:', error instanceof Error ? error.message : String(error));
      return { available: false, error: 'Synthetic quota data unavailable' };
    }
  }

  private async refreshPricingBestEffort(): Promise<void> {
    if (this.pricing.size > 0 && Date.now() - this.pricingFetchedAt < 6 * 60 * 60 * 1000) return;
    try {
      const response = await fetch(MODELS_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Synthetic models returned ${response.status}`);
      const json = await response.json();
      const next = new Map<string, Price>();
      for (const model of Array.isArray(json?.data) ? json.data : []) {
        const input = parseUsdPerToken(model?.pricing?.prompt);
        const output = parseUsdPerToken(model?.pricing?.completion);
        if (input == null || output == null) continue;
        for (const key of [model.id, model.name, model.hugging_face_id, model.openrouter?.slug]) {
          if (typeof key === 'string' && key) next.set(normalizeModelId(key), { inputPerToken: input, outputPerToken: output });
        }
      }
      if (next.size > 0) {
        this.pricing = next;
        this.pricingFetchedAt = Date.now();
      }
    } catch (error) {
      logger.main.warn('[SyntheticUsageService] Failed to refresh pricing:', error instanceof Error ? error.message : String(error));
    }
  }

  private async loadSyntheticSessionRows(): Promise<UsageRow[]> {
    const db = getDatabase();
    const result = await db.query<UsageRow>(
      `SELECT model, created_at, metadata
       FROM ai_sessions
       WHERE provider = 'synthetic'
         AND metadata IS NOT NULL
       ORDER BY created_at ASC`,
      []
    );
    return result.rows;
  }

  private aggregate(rows: UsageRow[], quota: SyntheticQuotaData): SyntheticUsageData {
    const now = Date.now();
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const sevenDayStart = now - 7 * 24 * 60 * 60 * 1000;
    const today = emptyBucket();
    const sevenDay = emptyBucket();
    const allTime = emptyBucket();

    for (const row of rows) {
      const tokenUsage = readTokenUsage(row.metadata);
      if (!tokenUsage) continue;
      const createdAt = toEpochMs(row.created_at);
      const price = this.findPrice(row.model);
      const costUSD = price
        ? tokenUsage.inputTokens * price.inputPerToken + tokenUsage.outputTokens * price.outputPerToken
        : 0;
      add(allTime, tokenUsage, costUSD);
      if (createdAt >= sevenDayStart) add(sevenDay, tokenUsage, costUSD);
      if (createdAt >= dayStart.getTime()) add(today, tokenUsage, costUSD);
    }

    return { today, sevenDay, allTime, quota, pricingAvailable: this.pricing.size > 0, modelCount: this.pricing.size, lastUpdated: Date.now() };
  }

  private findPrice(model: string | null): Price | null {
    if (!model) return null;
    const normalized = normalizeModelId(model);
    return this.pricing.get(normalized) ?? this.pricing.get(normalized.replace(/^synthetic:/, '')) ?? null;
  }

  private startPolling(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.pollTimer = setInterval(() => this.pollTick(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isPolling = false;
  }

  private async pollTick(): Promise<void> {
    if (Date.now() - this.lastActivityTime > IDLE_TIMEOUT_MS) {
      this.isSleeping = true;
      this.stopPolling();
      return;
    }
    await this.refresh();
  }

  private broadcastUpdate(): void {
    if (!this.cachedUsage) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('synthetic-usage:update', this.cachedUsage);
    }
  }
}

function parseQuotaResponse(raw: any): SyntheticQuotaData {
  const toolCalls = raw?.freeToolCalls ?? raw?.toolCallDiscounts;
  return {
    available: true,
    subscription: parseQuotaCategory('Energy', raw?.subscription),
    searchHourly: parseQuotaCategory('Guidance (hourly)', raw?.search?.hourly),
    toolCalls: parseQuotaCategory('Tool calls', toolCalls),
    weeklyTokens: parseWeeklyTokens(raw?.weeklyTokenLimit),
  };
}

function parseQuotaCategory(label: string, raw: any): SyntheticQuotaCategory | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const limit = finiteNumber(raw.limit ?? raw.maxBalance);
  if (limit == null) return undefined;
  const used = finiteNumber(raw.requests) ?? (
    finiteNumber(raw.balance) != null && finiteNumber(raw.maxBalance) != null
      ? Math.max(0, Number(raw.maxBalance) - Number(raw.balance))
      : 0
  );
  const remaining = Math.max(0, limit - used);
  const percentUsed = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
  const renewsAt = typeof raw.renewsAt === 'string' ? raw.renewsAt : (
    finiteNumber(raw.nextRegen) != null && Number(raw.nextRegen) > 0
      ? new Date(Date.now() + Number(raw.nextRegen) * 1000).toISOString()
      : undefined
  );
  return { label, limit, used, remaining, percentUsed: Math.round(percentUsed * 10) / 10, renewsAt };
}

function parseWeeklyTokens(raw: any): SyntheticWeeklyTokenQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const percentRemaining = finiteNumber(raw.percentRemaining);
  if (percentRemaining != null) {
    const clamped = Math.max(0, Math.min(100, percentRemaining));
    return {
      percentRemaining: Math.round(clamped * 10) / 10,
      percentUsed: Math.round((100 - clamped) * 10) / 10,
      nextRegenAt: typeof raw.nextRegenAt === 'string' ? raw.nextRegenAt : typeof raw.renewsAt === 'string' ? raw.renewsAt : undefined,
    };
  }
  const inputCurrent = finiteNumber(raw.input?.current);
  const inputLimit = finiteNumber(raw.input?.limit);
  if (inputCurrent != null && inputLimit != null && inputLimit > 0) {
    const used = Math.max(0, Math.min(100, (inputCurrent / inputLimit) * 100));
    return {
      percentRemaining: Math.round((100 - used) * 10) / 10,
      percentUsed: Math.round(used * 10) / 10,
      nextRegenAt: typeof raw.renewsAt === 'string' ? raw.renewsAt : undefined,
    };
  }
  return undefined;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyBucket() { return { costUSD: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
function add(bucket: ReturnType<typeof emptyBucket>, usage: { inputTokens: number; outputTokens: number; totalTokens: number }, costUSD: number): void {
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.totalTokens += usage.totalTokens;
  bucket.costUSD += costUSD;
}
function parseUsdPerToken(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function normalizeModelId(model: string): string { return model.replace(/^synthetic:/, '').replace(/^hf:/, '').toLowerCase(); }
function toEpochMs(raw: unknown): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') return new Date(raw).getTime();
  return 0;
}
function parseJsonRecord(raw: unknown): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
  return typeof raw === 'object' ? raw as Record<string, any> : null;
}
function readTokenUsage(rawMetadata: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  const usage = parseJsonRecord(rawMetadata)?.tokenUsage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.inputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  const totalTokens = Number(usage.totalTokens ?? inputTokens + outputTokens);
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return null;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

export const syntheticUsageService = new SyntheticUsageServiceImpl();
