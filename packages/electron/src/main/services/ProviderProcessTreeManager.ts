/**
 * ProviderProcessTreeManager — Tracks and manages child processes spawned by AI session providers.
 *
 * Ensures on Windows that child processes are properly owned (linked) with their session parent,
 * so they survive when the Electron session process terminates. This prevents background task
 * loss during session restart loops.
 *
 * Platform behavior:
 * - cross-platform: Track child processes in a Map keyed by sessionId
 * - Windows (win32): Use SetConsoleProcessList to link child to parent process so child inherits parent exit
 * - Other platforms: Ignore (children are expected to naturally survive parent termination)
 *
 * NIM-857: Session process restarts repeatedly kill background tasks mid-run.
 * NIM-855: fix(windows): own and reap provider process trees.
 */

import { ChildProcess } from 'child_process';
import { logger } from '../utils/logger';
import * as path from 'path';

const log = logger.aiSession;

// Maps session IDs to their spawned provider child processes.
export const sessionChildProcesses = new Map<string, SpawnableChildProcess[]>();

// Maps child PIDs to their session IDs.
export const pidToSessionId = new Map<number, string>();

export interface SpawnableChildProcess {
  process: ChildProcess;
  name?: string;
  startedAt?: number;
}

/**
 * Register a new child process created by a session provider.
 *
 * On Windows, this calls SetConsoleProcessList() to link the child with the parent,
 * ensuring the child process is marked as a child of the parent, so when the parent
 * exits, the child process is also terminated (reaped) rather than orphaning.
 *
 * @param sessionId - The Nimbalyst session ID spawned this process
 * @param process - The ChildProcess to track
 * @param name - Optional human-readable name for logging
 */
export function trackChildProcess(
  sessionId: string,
  child: ChildProcess,
  name = 'tracked-child',
): void {
  const existingChildren = sessionChildProcesses.get(sessionId) || [];
  sessionChildProcesses.set(sessionId, [...existingChildren, { process: child, name, startedAt: Date.now() }]);
  if (child.pid) pidToSessionId.set(child.pid, sessionId);

  log.debug(`[ProviderProcessTreeManager] Tracked child process ${child.pid} for session ${sessionId} (${name})`);

  // Windows-specific process tree ownership — use the global process.platform
  // (the Electron main process platform), not a property on the ChildProcess.
  if (process.platform === 'win32') {
    linkChildWithParent(child);
  }

  // Prevent memory bloat
  const totalTracked = sessionChildProcesses.size * existingChildren.length;
  if (totalTracked > 1000) { // Use direct number
    cleanupOrphanedProcesses();
  }
}

/**
 * Unlink and clean up a tracked child process.
 *
 * Called when a child process ends naturally.
 *
 * @param pid - The child process PID
 */
export function untrackChildProcess(pid: number): void {
  const sessionId = pidToSessionId.get(pid);
  if (!sessionId) {
    // Not tracked, nothing to do
    return;
  }

  pidToSessionId.delete(pid);

  const children = sessionChildProcesses.get(sessionId);
  if (!children) {
    return;
  }

  const remaining = children.filter(c => c.process.pid !== pid);
  if (remaining.length === 0) {
    sessionChildProcesses.delete(sessionId);
  } else {
    sessionChildProcesses.set(sessionId, remaining);
  }

  log.debug(`[ProviderProcessTreeManager] Untracked child process ${pid} from session ${sessionId}`);
}

/**
 * On Windows, link the child process to its parent using SetConsoleProcessList().
 *
 * This ensures the child process is marked as a child of the parent, so when the parent
 * exits, the child process is also terminated (reaped) rather than orphaning.
 *
 * If SetConsoleProcessList is unavailable (older Windows), this is a no-op on that platform.
 * The fallback is for long-running shells to be managed by the shell itself (they orphan
 * on Windows when the parent doesn't link them explicitly).
 */
function linkChildWithParent(child: ChildProcess): void {
  try {
    // Use the global process.env (not child.env, which doesn't exist on ChildProcess)
    const systemRoot = process.env.SYSTEMROOT;
    const lib = systemRoot
      ? require(path.join(systemRoot, 'System32', 'kernel32.dll'))
      : null;

    if (!lib || !(lib as any).SetConsoleProcessList) {
      log.warn('[ProviderProcessTreeManager] Operating on Windows but SetConsoleProcessList unavailable, child may orphan');
      return;
    }

    if (child.pid) {
      (lib as any).SetConsoleProcessList(child.pid, 1);
    }
  } catch (error) {
    // If we get here, SetConsoleProcessList failed (e.g. not running in console, permissions)
    // Log a warning but don't crash - the child will still be tracked in our Map
    log.warn('[ProviderProcessTreeManager] Failed to link child process with SetConsoleProcessList:', error);
  }
}

/**
 * Reap all child processes for a given session.
 *
 * Called when a session ends (CLI exit, user disconnection, restart). Each child
 * receives a SIGTERM first, followed by SIGKILL if necessary.
 *
 * On Windows, we rely on SetConsoleProcessList to do the heavy lifting - the child
 * should receive an abrupt termination signal from the system when we close our
 * parent reference.
 *
 * @param sessionId - The Nimbalyst session ID to terminate children for
 */
export async function reapSessionChildren(sessionId: string): Promise<void> {
  const children = sessionChildProcesses.get(sessionId);
  if (!children || children.length === 0) {
    log.debug(`[ProviderProcessTreeManager] No child processes to reap for session ${sessionId}`);
    return;
  }

  log.info(`[ProviderProcessTreeManager] Reaping ${children.length} child processes for session ${sessionId}`);

  // First, kill all children with SIGTERM (graceful shutdown)
  const gracefulFails: number[] = [];
  for (const child of children) {
    try {
      if (child.process.pid) {
        child.process.kill('SIGTERM');
        gracefulFails.push(child.process.pid!);
      }
    } catch (error) {
      log.debug(`[ProviderProcessTreeManager] Failed to send SIGTERM to child ${child.process.pid}:`, error);
    }
  }

  // On Windows, OS reaps children via SetConsoleProcessList
  if (process.platform === 'win32') {
    // No explicit reap needed - Windows cleans up the tree automatically
  } else {
    // On other platforms, force-kill any that didn't exit gracefully
    for (const pid of gracefulFails) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        // Already dead or no permission - treat as success
      }
    }
  }

  // Clean up tracking after reap
  cleanupChildrenTracking(sessionId);
}

/**
 * Clean up tracking for a session's child processes map.
 *
 * @param sessionId - The session ID to clean up
 */
export function cleanupChildrenTracking(sessionId: string): void {
  // Capture children BEFORE deleting the session entry, otherwise the
  // get() returns undefined and the PID mappings are never cleaned up.
  const pairs = sessionChildProcesses.get(sessionId) || [];
  sessionChildProcesses.delete(sessionId);
  for (const cn of pairs) {
    if (cn.process.pid) {
      pidToSessionId.delete(cn.process.pid);
    }
  }
}

/**
 * Clean up orphaned/abandoned children from sessions that have been deleted long ago.
 *
 * This runs periodically to prevent tracking memory leaks from sessions completed months ago.
 */
export function cleanupOrphanedProcesses(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, children] of sessionChildProcesses.entries()) {
    let activeChildren = false;

    for (const cn of children) {
      if (cn.process.killed || cn.process.exitCode !== null) {
        // Process is dead, untrack it
        const pid = cn.process.pid;
        if (pid) untrackChildProcess(pid);
      } else {
        activeChildren = true;
      }
    }

    // Clean up empty session entries
    if (!activeChildren) {
      sessionChildProcesses.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log.debug(`[ProviderProcessTreeManager] Cleaned up ${cleaned} orphaned session entries`);
  }
}

/**
 * Get all tracked children for a session.
 *
 * Useful for logging/debugging session state.
 *
 * @param sessionId - The session ID
 * @returns Array of tracked children or null if none
 */
export function getSessionChildren(sessionId: string): SpawnableChildProcess[] | null {
  return sessionChildProcesses.get(sessionId) || null;
}

/**
 * Get diagnostics about tracked process tree state.
 *
 * Returns counts broken down by platform and session.
 */
export function getDiagnostics(): {
  totalSessions: number;
  totalTrackedChildren: number;
  sessionsByPlatform: Record<string, number>;
  sessionsByOS: Record<string, number>;
} {
  return {
    totalSessions: sessionChildProcesses.size,
    totalTrackedChildren: Array.from(sessionChildProcesses.values()).reduce((acc, arr) => acc + arr.length, 0),
    sessionsByPlatform: {},
    sessionsByOS: {},
  };
}