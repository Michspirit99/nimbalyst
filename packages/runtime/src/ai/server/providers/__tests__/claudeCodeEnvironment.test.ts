import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApp = {
  isPackaged: false,
  getAppPath: vi.fn(() => '/repo/packages/electron'),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

describe('claudeCodeEnvironment', () => {
  const originalNodePath = process.env.NODE_PATH;
  const customModulesPath = path.resolve('/custom/modules');
  const repoRootPath = path.resolve('/repo');
  const electronAppPath = path.join(repoRootPath, 'packages', 'electron');
  const runtimeNodeModulesPath = path.join(repoRootPath, 'packages', 'runtime', 'node_modules');
  const repoNodeModulesPath = path.join(repoRootPath, 'node_modules');
  const packagedAppPath = path.resolve('/Applications/Nimbalyst.app/Contents/Resources/app.asar');
  const packagedNodeModulesPath = path.resolve('/Applications/Nimbalyst.app/Contents/Resources/app.asar.unpacked/node_modules');

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockApp.isPackaged = false;
    mockApp.getAppPath.mockReturnValue(electronAppPath);
    process.env.NODE_PATH = customModulesPath;
  });

  afterEach(() => {
    if (originalNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = originalNodePath;
    }
  });

  it('adds hoisted workspace node_modules paths in development mode', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      return [
        customModulesPath,
        repoNodeModulesPath,
        runtimeNodeModulesPath,
      ].includes(path.normalize(String(candidate)));
    });

    const { setupClaudeCodeEnvironment } = await import('../../../../electron/claudeCodeEnvironment');
    const env = setupClaudeCodeEnvironment();
    const nodePaths = env.NODE_PATH?.split(path.delimiter) ?? [];

    expect(nodePaths).toEqual([
      customModulesPath,
      repoNodeModulesPath,
      runtimeNodeModulesPath,
    ]);
  });

  it('uses unpacked node_modules in packaged mode', async () => {
    mockApp.isPackaged = true;
    mockApp.getAppPath.mockReturnValue(packagedAppPath);

    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => (
      path.normalize(String(candidate)) === packagedNodeModulesPath
    ));

    const { setupClaudeCodeEnvironment } = await import('../../../../electron/claudeCodeEnvironment');
    const env = setupClaudeCodeEnvironment();

    expect(env.NODE_PATH).toBe(packagedNodeModulesPath);
  });
});
