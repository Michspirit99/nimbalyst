import {
  trackChildProcess,
  untrackChildProcess,
  reapSessionChildren,
  getSessionChildren,
  getDiagnostics,
  sessionChildProcesses,
  pidToSessionId,
} from '../ProviderProcessTreeManager';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ProviderProcessTreeManager', () => {
  beforeEach(() => {
    sessionChildProcesses.clear();
    pidToSessionId.clear();
  });

  describe('trackChildProcess', () => {
    it('should track a child process for a session', () => {
      const sessionId = 'test-session-1';
      const proc = { pid: 12345, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, proc, 'test-shell');

      const children = getSessionChildren(sessionId);
      expect(children).not.toBeNull();
      expect(children).toHaveLength(1);
      expect(children![0].name).toBe('test-shell');
    });

    it('should track multiple children for the same session', () => {
      const sessionId = 'test-session-2';
      const p1 = { pid: 12346, kill: vi.fn(), platform: 'darwin' } as any;
      const p2 = { pid: 12347, kill: vi.fn(), platform: 'darwin' } as any;
      const p3 = { pid: 12348, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, p1, 'shell-1');
      trackChildProcess(sessionId, p2, 'shell-2');
      trackChildProcess(sessionId, p3, 'shell-3');

      const children = getSessionChildren(sessionId);
      expect(children).not.toBeNull();
      expect(children).toHaveLength(3);
    });

    it('should populate pidToSessionId on track', () => {
      const sessionId = 'test-session-pid';
      const proc = { pid: 12349, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, proc, 'test');

      expect(pidToSessionId.get(12349)).toBe(sessionId);
    });

    it('should not throw on Windows when SetConsoleProcessList is unavailable', () => {
      const sessionId = 'test-session-windows';
      const proc = { pid: 12350, kill: vi.fn(), platform: 'win32' } as any;

      expect(() => trackChildProcess(sessionId, proc, 'windows-shell')).not.toThrow();

      const children = getSessionChildren(sessionId);
      expect(children).not.toBeNull();
      expect(children).toHaveLength(1);
    });
  });

  describe('untrackChildProcess', () => {
    it('should remove a tracked child process', () => {
      const sessionId = 'test-session-3';
      const proc = { pid: 12351, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, proc);
      expect(getSessionChildren(sessionId)).not.toBeNull();
      expect(getSessionChildren(sessionId)!.length).toBe(1);

      untrackChildProcess(12351);
      expect(getSessionChildren(sessionId)).toBeNull();
    });

    it('should handle untracking a non-tracked PID gracefully', () => {
      expect(() => untrackChildProcess(99999)).not.toThrow();
      expect(pidToSessionId.get(99999)).toBeUndefined();
    });

    it('should remove pidToSessionId mapping on untrack', () => {
      const sessionId = 'test-session-4';
      const proc = { pid: 12352, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, proc);
      expect(pidToSessionId.get(12352)).toBe(sessionId);

      untrackChildProcess(12352);
      expect(pidToSessionId.get(12352)).toBeUndefined();
    });
  });

  describe('reapSessionChildren', () => {
    it('should reap all children of a session', async () => {
      const sessionId = 'test-session-5';
      const p1 = { pid: 12353, kill: vi.fn(), platform: 'darwin' } as any;
      const p2 = { pid: 12354, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, p1, 'shell-1');
      trackChildProcess(sessionId, p2, 'shell-2');

      await reapSessionChildren(sessionId);

      expect(getSessionChildren(sessionId)).toBeNull();
      expect(pidToSessionId.get(12353)).toBeUndefined();
      expect(pidToSessionId.get(12354)).toBeUndefined();
    });

    it('should handle reap with no children gracefully', async () => {
      const sessionId = 'test-session-6';
      await reapSessionChildren(sessionId);
      expect(getSessionChildren(sessionId)).toBeNull();
    });

    it('should send SIGTERM to children', async () => {
      const sessionId = 'test-session-7';
      const p1 = { pid: 12355, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, p1);
      await reapSessionChildren(sessionId);

      expect(p1.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('getSessionChildren', () => {
    it('should return null for sessions with no children', () => {
      expect(getSessionChildren('nonexistent-session')).toBeNull();
    });

    it('should return tracked children for a session', () => {
      const sessionId = 'test-session-empty';
      const proc = { pid: 12356, kill: vi.fn(), platform: 'darwin' } as any;
      trackChildProcess(sessionId, proc);
      const result = getSessionChildren(sessionId);
      expect(result).toHaveLength(1);
    });
  });

  describe('getDiagnostics', () => {
    it('should return correct diagnostics counts', () => {
      const sessionId = 'test-diag-session';
      const p1 = { pid: 12357, kill: vi.fn(), platform: 'darwin' } as any;
      const p2 = { pid: 12358, kill: vi.fn(), platform: 'darwin' } as any;

      trackChildProcess(sessionId, p1);
      trackChildProcess(sessionId, p2);

      const diag = getDiagnostics();

      expect(diag.totalSessions).toBe(1);
      expect(diag.totalTrackedChildren).toBe(2);
    });
  });
});
