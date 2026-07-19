import React, { RefObject, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { syntheticUsageAtom, type SyntheticQuotaCategory, type SyntheticUsageBucket } from '../../store/atoms/syntheticUsageAtoms';
import { useSetSetting } from '../../hooks/useSetting';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';

interface SyntheticUsagePopoverProps {
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

export const SyntheticUsagePopover: React.FC<SyntheticUsagePopoverProps> = ({ anchorRef, onClose, onRefresh }) => {
  const usage = useAtomValue(syntheticUsageAtom);
  const setEnabled = useSetSetting('ai.showSyntheticUsageIndicator');
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const menu = useFloatingMenu({ placement: 'right-end', open: true, onOpenChange: (open) => { if (!open) onClose(); } });

  useEffect(() => { if (anchorRef.current) menu.refs.setReference(anchorRef.current); }, [anchorRef, menu.refs]);
  if (!usage) return null;

  const refresh = async () => { setIsRefreshing(true); try { await onRefresh(); } finally { setIsRefreshing(false); } };

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="w-64 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-y-auto"
        data-testid="synthetic-usage-popover"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            <ProviderIcon provider="synthetic" size={18} />
            <span className="text-[14px] font-semibold text-nim">Synthetic Usage</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={refresh} disabled={isRefreshing} className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim disabled:opacity-50" aria-label="Refresh usage estimate">
              <MaterialSymbol icon="refresh" size={14} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim" aria-label="Close">
              <MaterialSymbol icon="close" size={14} />
            </button>
          </div>
        </div>
        <div className="px-4 py-3">
          {usage.error ? <div className="text-[13px] text-nim-error">{usage.error}</div> : (
            <div className="space-y-3">
              {usage.quota.available ? (
                <div className="space-y-2">
                  <div className="text-[12px] text-nim-muted">Official Synthetic.new quota status for your configured API key.</div>
                  {usage.quota.subscription && <QuotaRow quota={usage.quota.subscription} />}
                  {usage.quota.searchHourly && <QuotaRow quota={usage.quota.searchHourly} />}
                  {usage.quota.toolCalls && <QuotaRow quota={usage.quota.toolCalls} />}
                  {usage.quota.weeklyTokens && (
                    <div>
                      <div className="flex items-baseline justify-between">
                        <span className="text-[13px] font-semibold text-nim">Mana (token)</span>
                        <span className="text-[13px] font-semibold text-nim">{usage.quota.weeklyTokens.percentRemaining.toFixed(1)}% left</span>
                      </div>
                      <div className="h-1.5 rounded bg-nim-tertiary overflow-hidden mt-1">
                        <div className="h-full bg-green-500" style={{ width: `${usage.quota.weeklyTokens.percentRemaining}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[12px] text-nim-muted">{usage.quota.error || 'Official Synthetic quota data is unavailable.'}</div>
              )}
              <div className="pt-2 border-t border-nim space-y-2">
                <div className="text-[12px] text-nim-muted">Local Nimbalyst spend estimate from recorded tokens and live model pricing.</div>
                {!usage.pricingAvailable && <div className="text-[12px] text-nim-muted">Token usage detected, but live Synthetic pricing is unavailable. Cost estimates show as $0 until pricing refreshes.</div>}
                <Bucket title="Today" bucket={usage.today} />
                <Bucket title="Last 7 days" bucket={usage.sevenDay} />
                <Bucket title="All time" bucket={usage.allTime} />
              </div>
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t border-nim flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-nim-faint">Updated {formatLastUpdated(usage.lastUpdated)}</span>
            <button onClick={() => { setEnabled(false); onClose(); }} className="text-[11px] text-nim-muted hover:text-nim">Disable</button>
          </div>
          <button onClick={() => window.electronAPI.openExternal('https://synthetic.new/pricing')} className="flex items-center gap-1 text-[11px] text-nim-muted hover:text-nim">
            <MaterialSymbol icon="open_in_new" size={12} /><span>Synthetic Pricing</span>
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
};

const QuotaRow: React.FC<{ quota: SyntheticQuotaCategory }> = ({ quota }) => (
  <div>
    <div className="flex items-baseline justify-between">
      <span className="text-[13px] font-semibold text-nim">{quota.label}</span>
      <span className="text-[13px] font-semibold text-nim">{quota.remaining.toLocaleString()} left</span>
    </div>
    <div className="h-1.5 rounded bg-nim-tertiary overflow-hidden mt-1">
      <div className={quota.percentUsed >= 90 ? 'h-full bg-red-500' : quota.percentUsed >= 80 ? 'h-full bg-yellow-500' : 'h-full bg-green-500'} style={{ width: `${Math.max(0, Math.min(100, quota.percentUsed))}%` }} />
    </div>
    <div className="text-[11px] text-nim-muted mt-0.5">
      {quota.used.toLocaleString()} / {quota.limit.toLocaleString()} used ({quota.percentUsed.toFixed(1)}%)
      {quota.renewsAt ? ` · resets ${formatResetTime(quota.renewsAt)}` : ''}
    </div>
  </div>
);

const Bucket: React.FC<{ title: string; bucket: SyntheticUsageBucket }> = ({ title, bucket }) => (
  <div>
    <div className="flex items-baseline justify-between">
      <span className="text-[13px] font-semibold text-nim">{title}</span>
      <span className="text-[16px] font-semibold text-green-500">≈{formatCurrency(bucket.costUSD)}</span>
    </div>
    <div className="text-[11px] text-nim-muted">
      {bucket.totalTokens.toLocaleString()} tokens · {bucket.inputTokens.toLocaleString()} in / {bucket.outputTokens.toLocaleString()} out
    </div>
  </div>
);

function formatCurrency(value: number): string { return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`; }
function formatResetTime(raw: string): string {
  const ts = new Date(raw).getTime();
  if (!Number.isFinite(ts)) return 'unknown';
  const diffMinutes = Math.max(0, Math.floor((ts - Date.now()) / 60000));
  if (diffMinutes < 60) return `in ${diffMinutes}m`;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return `in ${hours}h${minutes ? ` ${minutes}m` : ''}`;
}
function formatLastUpdated(timestamp: number): string {
  const diffMinutes = Math.floor((Date.now() - timestamp) / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(diffMinutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
