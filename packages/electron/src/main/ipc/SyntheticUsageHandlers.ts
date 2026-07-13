/** IPC handlers for Synthetic.new usage tracking. */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { syntheticUsageService, type SyntheticUsageData } from '../services/SyntheticUsageService';

export function registerSyntheticUsageHandlers(): void {
  safeHandle('synthetic-usage:get', async (): Promise<SyntheticUsageData | null> => {
    try {
      return syntheticUsageService.getCachedUsage() ?? await syntheticUsageService.refresh();
    } catch (error) {
      logger.main.error('[SyntheticUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('synthetic-usage:refresh', async (): Promise<SyntheticUsageData> => {
    try {
      return await syntheticUsageService.refresh();
    } catch (error) {
      logger.main.error('[SyntheticUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('synthetic-usage:activity', async (): Promise<void> => {
    try {
      await syntheticUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[SyntheticUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[SyntheticUsageHandlers] Synthetic usage IPC handlers registered');
}
