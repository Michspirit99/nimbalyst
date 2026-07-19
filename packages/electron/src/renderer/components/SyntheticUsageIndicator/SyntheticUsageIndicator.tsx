import React, { useCallback, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  syntheticPrimaryQuotaAtom,
  syntheticUsageAtom,
  syntheticUsageAvailableAtom,
  syntheticUsagePrimaryColorAtom,
  formatResetTime,
} from '../../store/atoms/syntheticUsageAtoms';
import { useSetting } from '../../hooks/useSetting';
import { refreshSyntheticUsage } from '../../store/listeners/syntheticUsageListeners';
import { SyntheticUsagePopover } from './SyntheticUsagePopover';

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface SyntheticUsageIndicatorProps { className?: string }

export const SyntheticUsageIndicator: React.FC<SyntheticUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(syntheticUsageAtom);
  const primaryQuota = useAtomValue(syntheticPrimaryQuotaAtom);
  const isAvailable = useAtomValue(syntheticUsageAvailableAtom);
  const isEnabled = useSetting('ai.showSyntheticUsageIndicator');
  const primaryColor = useAtomValue(syntheticUsagePrimaryColorAtom);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const handleRefresh = useCallback(async () => { await refreshSyntheticUsage(); }, []);

  if (!isEnabled || !isAvailable) return null;

  const hasLoadError = Boolean(usage?.error);
  const utilization = hasLoadError ? 0 : primaryQuota?.percentUsed ?? 0;
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - utilization / 100);
  const colorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };
  const strokeColor = colorClasses[hasLoadError ? 'muted' : primaryColor] || colorClasses.muted;

  const tooltip = usage?.error
    ? `Synthetic usage unavailable: ${usage.error}`
    : usage?.quota.available && usage.quota.weeklyTokens
      ? `Mana (token): ${Math.round(usage.quota.weeklyTokens.percentRemaining)}% left (${Math.round(utilization)}% used${usage.quota.weeklyTokens.nextRegenAt ? `, regen ${formatResetTime(usage.quota.weeklyTokens.nextRegenAt)}` : ''})`
      : usage?.quota.available && usage.quota.subscription
        ? `Energy: ${Math.round(utilization)}% (resets ${formatResetTime(usage.quota.subscription.renewsAt)})`
        : `Estimated Synthetic spend today: ≈${formatCurrency(usage?.today.costUSD ?? 0)}`;

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={() => setIsPopoverOpen((v) => !v)}
        title={tooltip}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Synthetic Usage"
        data-testid="synthetic-usage-indicator"
      >
        <svg width="32" height="32" viewBox="0 0 32 32" className="transform -rotate-90">
          <circle cx="16" cy="16" r={RING_RADIUS} fill="none" className="stroke-nim-tertiary" strokeWidth="3" />
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            className={strokeColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-nim">
          {hasLoadError ? '--' : `${Math.round(utilization)}%`}
        </span>
      </button>
      {isPopoverOpen && (
        <SyntheticUsagePopover anchorRef={buttonRef} onClose={() => setIsPopoverOpen(false)} onRefresh={handleRefresh} />
      )}
    </div>
  );
};

function formatCurrency(value: number): string {
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
