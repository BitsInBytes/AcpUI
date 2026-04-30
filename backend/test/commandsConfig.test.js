import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(() => true),
}));

vi.mock('fs', () => ({
  default: { 
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync
  },
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

describe('commandsConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
  });

  it('loads commands from JSON config file', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      commands: [
        { name: 'test', description: 'A test command' },
        { name: 'deploy', description: 'Deploy app' },
      ]
    }));

    const { loadCommands } = await import('../services/commandsConfig.js');
    const result = loadCommands();

    expect(result).toEqual([
      { name: 'test', description: 'A test command' },
      { name: 'deploy', description: 'Deploy app' },
    ]);
  });

  it('returns empty array when config file does not exist', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const { loadCommands } = await import('../services/commandsConfig.js');
    const result = loadCommands();

    expect(result).toEqual([]);
  });

  it('filters out entries without name or description', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      commands: [
        { name: 'good', description: 'Valid command' },
        { name: '', description: 'No name' },
        { name: 'No desc' },
        { description: 'No name either' },
      ]
    }));

    const { loadCommands } = await import('../services/commandsConfig.js');
    const result = loadCommands();

    expect(result).toEqual([{ name: 'good', description: 'Valid command' }]);
  });
});
