import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import registerFileExplorerHandlers from '../sockets/fileExplorerHandlers.js';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

const mockProvider = { config: { paths: { home: path.resolve('provider-home') } } };

vi.mock('../services/providerLoader.js', () => ({
  getProvider: () => mockProvider
}));

vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn().mockReturnValue([
      { name: 'agents', isDirectory: () => true },
      { name: '.hidden', isDirectory: () => false },
      { name: 'settings.json', isDirectory: () => false }
    ]),
    readFileSync: vi.fn().mockReturnValue('# Hello\nWorld'),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    realpathSync: vi.fn((p) => p)
  }
}));

describe('File Explorer Handlers', () => {
  let socket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.config.paths.home = path.resolve('provider-home');
    socket = new EventEmitter();
    registerFileExplorerHandlers({}, socket);
  });

  it('explorer_root returns paths.home', () => {
    const cb = vi.fn();
    socket.listeners('explorer_root')[0](cb);
    expect(cb).toHaveBeenCalledWith({ root: path.resolve('provider-home') });
  });

  it('explorer_root returns an error when paths.home is missing', () => {
    mockProvider.config.paths.home = null;
    const cb = vi.fn();
    socket.listeners('explorer_root')[0](cb);
    expect(cb).toHaveBeenCalledWith({ root: '', error: expect.stringContaining('not configured') });
  });

  it('explorer_root returns an error when paths.home is not absolute', () => {
    mockProvider.config.paths.home = 'relative/path';
    const cb = vi.fn();
    socket.listeners('explorer_root')[0](cb);
    expect(cb).toHaveBeenCalledWith({ root: '', error: expect.stringContaining('absolute') });
  });

  it('explorer_list returns sorted entries without dotfiles', () => {
    const cb = vi.fn();
    socket.listeners('explorer_list')[0]({ dirPath: '' }, cb);
    const items = cb.mock.calls[0][0].items;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: 'agents', isDirectory: true });
    expect(items[1]).toEqual({ name: 'settings.json', isDirectory: false });
  });

  it('explorer_read returns file content', async () => {
    const fs = (await import('fs')).default;
    fs.readFileSync.mockReturnValueOnce('text');
    const cb = vi.fn();

    socket.listeners('explorer_read')[0]({ filePath: 'settings.json' }, cb);

    expect(cb).toHaveBeenCalledWith({ content: 'text', filePath: 'settings.json' });
  });

  it('explorer_read allows spaces and quotes in file names inside root', async () => {
    const fs = (await import('fs')).default;
    fs.readFileSync.mockReturnValueOnce('safe');
    const cb = vi.fn();

    socket.listeners('explorer_read')[0]({ filePath: 'dir with spaces/"quoted".md' }, cb);

    expect(cb).toHaveBeenCalledWith({ content: 'safe', filePath: 'dir with spaces/"quoted".md' });
  });

  it('explorer_write saves file', async () => {
    const fs = (await import('fs')).default;
    const cb = vi.fn();
    socket.listeners('explorer_write')[0]({ filePath: 'settings.json', content: 'new content' }, cb);
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('blocks path traversal', () => {
    const cb = vi.fn();
    socket.listeners('explorer_read')[0]({ filePath: '../../etc/passwd' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('outside the allowed root') });
  });

  it('blocks sibling-prefix bypass paths', () => {
    const cb = vi.fn();
    socket.listeners('explorer_read')[0]({ filePath: '../provider-home-sibling/secret.txt' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('outside the allowed root') });
  });

  it('blocks symlink escape when target parent resolves outside root', async () => {
    const fs = (await import('fs')).default;
    const root = path.resolve('provider-home');
    const linkDir = path.join(root, 'link');
    const target = path.join(linkDir, 'escaped.txt');

    fs.existsSync.mockImplementation((p) => p !== target);
    fs.realpathSync.mockImplementation((p) => {
      if (p === linkDir) return path.resolve('outside-root');
      return p;
    });

    const cb = vi.fn();
    socket.listeners('explorer_read')[0]({ filePath: 'link/escaped.txt' }, cb);

    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('outside the allowed root') });
  });

  it('handles list errors gracefully', async () => {
    const fs = (await import('fs')).default;
    fs.readdirSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const cb = vi.fn();
    socket.listeners('explorer_list')[0]({ dirPath: 'missing' }, cb);
    expect(cb).toHaveBeenCalledWith({ items: [], error: 'ENOENT' });
  });

  it('explorer_list sorts items of same type alphabetically', async () => {
    const fs = (await import('fs')).default;
    fs.readdirSync.mockReturnValueOnce([
      { name: 'zebra.json', isDirectory: () => false },
      { name: 'alpha.json', isDirectory: () => false }
    ]);
    const cb = vi.fn();
    socket.listeners('explorer_list')[0]({ dirPath: '' }, cb);
    const items = cb.mock.calls[0][0].items;
    expect(items[0].name).toBe('alpha.json');
    expect(items[1].name).toBe('zebra.json');
  });

  it('explorer_write handles errors gracefully', async () => {
    const fs = (await import('fs')).default;
    fs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const cb = vi.fn();
    socket.listeners('explorer_write')[0]({ filePath: 'settings.json', content: 'x' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: 'disk full' });
  });
});
