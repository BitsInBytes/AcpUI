import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';
import fs from 'fs';
import registerSystemSettingsHandlers from '../sockets/systemSettingsHandlers.js';

// Hoist Mocks
const { mockFs } = vi.hoisted(() => ({
    mockFs: {
        readFileSync: vi.fn().mockReturnValue(''),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(true)
    }
}));

vi.mock('fs', () => ({ default: mockFs, readFileSync: (...args) => mockFs.readFileSync(...args), writeFileSync: (...args) => mockFs.writeFileSync(...args), existsSync: (...args) => mockFs.existsSync(...args) }));
vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn().mockReturnValue({ id: 'provider-a', config: { branding: {} } })
}));

describe('systemSettingsHandlers', () => {
  let mockIo, mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = new EventEmitter();
    mockSocket = new EventEmitter();
    registerSystemSettingsHandlers(mockIo, mockSocket);
  });

  it('handles get_env and error', async () => {
    mockFs.readFileSync.mockReturnValue('KEY=VAL');
    const callback = vi.fn();
    await mockSocket.emit('get_env', callback);
    expect(callback).toHaveBeenCalledWith({ vars: { KEY: 'VAL' } });

    mockFs.readFileSync.mockImplementation(() => { throw new Error('fail'); });
    await mockSocket.emit('get_env', callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: 'fail' }));
  });

  it('handles update_env and error', async () => {
    mockFs.readFileSync.mockReturnValue('KEY=OLD');
    const callback = vi.fn();
    await mockSocket.emit('update_env', { key: 'KEY', value: 'NEW' }, callback);
    expect(mockFs.writeFileSync).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ success: true });

    mockFs.readFileSync.mockImplementation(() => { throw new Error('fail'); });
    await mockSocket.emit('update_env', { key: 'K', value: 'V' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: 'fail' }));
  });

  it('handles workspaces_config and error', async () => {
    mockFs.readFileSync.mockReturnValue('{"workspaces":[]}');
    const callback = vi.fn();
    await mockSocket.emit('get_workspaces_config', callback);
    expect(callback).toHaveBeenCalledWith({ content: '{"workspaces":[]}' });

    await mockSocket.emit('save_workspaces_config', { content: '{"workspaces":[]}' }, callback);
    expect(mockFs.writeFileSync).toHaveBeenCalled();

    mockFs.readFileSync.mockImplementation(() => { throw new Error('fail'); });
    await mockSocket.emit('get_workspaces_config', callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: 'fail' }));

    await mockSocket.emit('save_workspaces_config', { content: 'bad' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('handles commands_config and error', async () => {
    mockFs.readFileSync.mockReturnValue('{"commands":[]}');
    const callback = vi.fn();
    await mockSocket.emit('get_commands_config', callback);
    expect(callback).toHaveBeenCalledWith({ content: '{"commands":[]}' });

    await mockSocket.emit('save_commands_config', { content: '{"commands":[]}' }, callback);
    expect(mockFs.writeFileSync).toHaveBeenCalled();

    mockFs.readFileSync.mockImplementation(() => { throw new Error('fail'); });
    await mockSocket.emit('get_commands_config', callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: 'fail' }));
  });

  it('save_commands_config errors on invalid JSON', async () => {
    const callback = vi.fn();
    await mockSocket.emit('save_commands_config', { content: 'not json' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('get_provider_config falls back to example file when user.json missing', async () => {
    mockFs.existsSync.mockImplementation((p) => p.includes('.example'));
    mockFs.readFileSync.mockReturnValue('{"example":true}');
    const callback = vi.fn();
    await mockSocket.emit('get_provider_config', callback);
    expect(callback).toHaveBeenCalledWith({ content: '{"example":true}' });
  });

  it('save_provider_config errors on invalid JSON', async () => {
    const callback = vi.fn();
    await mockSocket.emit('save_provider_config', { content: 'bad json' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('handles provider_config and error', async () => {
    mockFs.readFileSync.mockReturnValue('{"name":"P"}');
    const callback = vi.fn();
    await mockSocket.emit('get_provider_config', callback);
    expect(callback).toHaveBeenCalledWith({ content: '{"name":"P"}' });

    await mockSocket.emit('save_provider_config', { content: '{"name":"P"}' }, callback);
    expect(mockFs.writeFileSync).toHaveBeenCalled();

    mockFs.readFileSync.mockImplementation(() => { throw new Error('fail'); });
    await mockSocket.emit('get_provider_config', callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ content: '{}', error: 'fail' }));
  });
});
