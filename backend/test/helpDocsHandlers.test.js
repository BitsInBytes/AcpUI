import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHelpDocsHandlers } from '../sockets/helpDocsHandlers.js';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

describe('Help Docs Handlers', () => {
  let rootDir;
  let socket;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-help-docs-'));
    fs.mkdirSync(path.join(rootDir, 'documents'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'providers', 'test-provider'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'README.md'), '# Root', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'documents', 'Guide.md'), '# Guide', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'providers', 'test-provider', 'README.MD'), '# Provider', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'documents', 'notes.txt'), 'not markdown', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'node_modules', 'pkg', 'README.md'), '# Dependency', 'utf8');

    socket = new EventEmitter();
    createHelpDocsHandlers({ rootDir }).register({}, socket);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('help_docs_list returns sorted Markdown files under the repository root', () => {
    const cb = vi.fn();

    socket.listeners('help_docs_list')[0]({}, cb);

    expect(cb).toHaveBeenCalledWith({
      root: path.resolve(rootDir),
      files: [
        { name: 'Guide.md', path: 'documents/Guide.md', directory: 'documents' },
        { name: 'README.md', path: 'README.md', directory: '' },
        { name: 'README.MD', path: 'providers/test-provider/README.MD', directory: 'providers/test-provider' },
      ],
    });
  });

  it('help_docs_list supports callback-only emits', () => {
    const cb = vi.fn();

    socket.listeners('help_docs_list')[0](cb);

    expect(cb).toHaveBeenCalledWith({
      root: path.resolve(rootDir),
      files: expect.arrayContaining([
        { name: 'README.md', path: 'README.md', directory: '' },
      ]),
    });
  });

  it('help_docs_read returns Markdown document content', () => {
    const cb = vi.fn();

    socket.listeners('help_docs_read')[0]({ filePath: 'documents/Guide.md' }, cb);

    expect(cb).toHaveBeenCalledWith({ content: '# Guide', filePath: 'documents/Guide.md' });
  });

  it('blocks path traversal reads', () => {
    const cb = vi.fn();

    socket.listeners('help_docs_read')[0]({ filePath: '../outside.md' }, cb);

    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('traversal') });
  });

  it('blocks absolute path reads', () => {
    const cb = vi.fn();
    const absolutePath = path.join(rootDir, 'README.md');

    socket.listeners('help_docs_read')[0]({ filePath: absolutePath }, cb);

    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('traversal') });
  });

  it('blocks Windows-style path traversal reads', () => {
    const cb = vi.fn();

    socket.listeners('help_docs_read')[0]({ filePath: '..\\outside.md' }, cb);

    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('traversal') });
  });

  it('rejects non-Markdown reads', () => {
    const cb = vi.fn();

    socket.listeners('help_docs_read')[0]({ filePath: 'documents/notes.txt' }, cb);

    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('Markdown') });
  });

  it('handles list errors gracefully', () => {
    const cb = vi.fn();
    fs.rmSync(rootDir, { recursive: true, force: true });

    socket.listeners('help_docs_list')[0]({}, cb);

    expect(cb).toHaveBeenCalledWith({ files: [], error: expect.any(String) });
  });
});
