import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { readFileSync: mockReadFileSync },
  readFileSync: mockReadFileSync,
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

describe('workspaceConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockReadFileSync.mockReset();
  });

  it('loads workspaces from JSON config file', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      workspaces: [
        { label: 'Project-A', path: '/repos/project-a', agent: 'agent-dev', pinned: true },
        { label: 'TS', path: '/repos/project-b' },
      ]
    }));

    const { loadWorkspaces } = await import('../services/workspaceConfig.js');
    const result = loadWorkspaces();

    expect(result).toEqual([
      { label: 'Project-A', path: '/repos/project-a', agent: 'agent-dev', pinned: true },
      { label: 'TS', path: '/repos/project-b', agent: '', pinned: false },
    ]);
  });

  it('falls back to env vars when config file does not exist', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    vi.stubEnv('DEFAULT_WORKSPACE_CWD', '/repos/project-a');
    vi.stubEnv('DEFAULT_WORKSPACE_AGENT', 'agent-dev');
    vi.stubEnv('WORKSPACE_B_CWD', '/repos/project-b');
    vi.stubEnv('WORKSPACE_B_AGENT', 'agent-b');

    const { loadWorkspaces } = await import('../services/workspaceConfig.js');
    const result = loadWorkspaces();

    expect(result).toEqual([
      { label: 'Project-A', path: '/repos/project-a', agent: 'agent-dev', pinned: true },
      { label: 'Project-B', path: '/repos/project-b', agent: 'agent-b', pinned: true },
    ]);
  });

  it('filters out entries without label or path', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      workspaces: [
        { label: 'Good', path: '/good' },
        { label: '', path: '/no-label' },
        { label: 'No Path' },
        { path: '/no-label-2' },
      ]
    }));

    const { loadWorkspaces } = await import('../services/workspaceConfig.js');
    const result = loadWorkspaces();

    expect(result).toEqual([{ label: 'Good', path: '/good', agent: '', pinned: false }]);
  });

  it('defaults pinned to false', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      workspaces: [{ label: 'Test', path: '/test' }]
    }));

    const { loadWorkspaces } = await import('../services/workspaceConfig.js');
    const result = loadWorkspaces();

    expect(result[0].pinned).toBe(false);
  });

  it('resolves WORKSPACES_CONFIG relative to project root, not CWD', async () => {
    vi.stubEnv('WORKSPACES_CONFIG', 'custom/config.json');
    mockReadFileSync.mockReturnValue(JSON.stringify({
      workspaces: [{ label: 'Custom', path: '/custom' }]
    }));

    const { loadWorkspaces } = await import('../services/workspaceConfig.js');
    loadWorkspaces();

    const calledPath = mockReadFileSync.mock.calls[0][0];
    // The module lives at backend/services/workspaceConfig.js
    // It resolves ../../custom/config.json from __dirname, landing at project root
    // If it used CWD, the path would depend on where tests run from
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const moduleDir = path.default.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.default.resolve(moduleDir, '..');
    const expectedPath = path.default.resolve(projectRoot, '..', 'custom/config.json');
    expect(calledPath).toBe(expectedPath);
  });
});
