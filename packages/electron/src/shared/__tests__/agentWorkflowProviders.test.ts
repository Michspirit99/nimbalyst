import { describe, expect, it } from 'vitest';
import {
  supportsWorkspaceSlashWorkflowProvider,
  usesCodexStyleAgentWorkflows,
} from '../agentWorkflowProviders';

describe('agentWorkflowProviders', () => {
  it('supports workspace slash workflows for OpenCode and Synthetic sessions', () => {
    expect(supportsWorkspaceSlashWorkflowProvider('opencode')).toBe(true);
    expect(usesCodexStyleAgentWorkflows('opencode')).toBe(true);
    expect(supportsWorkspaceSlashWorkflowProvider('synthetic')).toBe(true);
    expect(usesCodexStyleAgentWorkflows('synthetic')).toBe(true);
  });

  it('keeps Claude Agent on the Claude-style workflow path', () => {
    expect(supportsWorkspaceSlashWorkflowProvider('claude-code')).toBe(true);
    expect(usesCodexStyleAgentWorkflows('claude-code')).toBe(false);
  });
});
