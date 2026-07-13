import { store } from '@nimbalyst/runtime/store';
import { syntheticUsageAtom, type SyntheticUsageData } from '../atoms/syntheticUsageAtoms';

export function initSyntheticUsageListeners(): () => void {
  const handleUsageUpdate = (data: SyntheticUsageData) => {
    store.set(syntheticUsageAtom, data);
  };

  const unsubscribe = window.electronAPI.on?.('synthetic-usage:update', handleUsageUpdate) ?? (() => {});

  window.electronAPI.invoke('synthetic-usage:get').then((data: SyntheticUsageData | null) => {
    if (data) store.set(syntheticUsageAtom, data);
  }).catch((error) => {
    console.error('[SyntheticUsageListeners] Failed to get initial usage:', error);
  });

  return unsubscribe;
}

export async function recordSyntheticActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('synthetic-usage:activity');
  } catch (error) {
    console.error('[SyntheticUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshSyntheticUsage(): Promise<SyntheticUsageData | null> {
  try {
    const data = await window.electronAPI.invoke('synthetic-usage:refresh');
    if (data) store.set(syntheticUsageAtom, data);
    return data ?? null;
  } catch (error) {
    console.error('[SyntheticUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
