import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerGitHandlers from '../sockets/gitHandlers.js';
import EventEmitter from 'events';

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd) => {
    if (cmd.includes('branch --show-current')) return 'feature/test\n';
    if (cmd.includes('status --porcelain -- "untracked.txt"')) return '?? untracked.txt\n';
    if (cmd.includes('status --porcelain -- "src/app.js"')) return ' M src/app.js\n';
    if (cmd.includes('status --porcelain')) return ' M src/app.js\nA  src/new.js\n?? untracked.txt\n';
    if (cmd.includes('diff --cached')) return '+staged change\n';
    if (cmd.includes('diff --')) return '+unstaged change\n';
    return '';
  })
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue('new file content\nline 2')
  }
}));

describe('Git Handlers', () => {
  let socket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new EventEmitter();
    registerGitHandlers({}, socket);
  });

  it('git_status returns branch and files', () => {
    const cb = vi.fn();
    socket.listeners('git_status')[0]({ cwd: '/tmp/repo' }, cb);
    const res = cb.mock.calls[0][0];
    expect(res.branch).toBe('feature/test');
    expect(res.files).toHaveLength(3);
    expect(res.files[0]).toEqual({ path: 'src/app.js', status: 'modified', staged: false });
    expect(res.files[1]).toEqual({ path: 'src/new.js', status: 'added', staged: true });
    expect(res.files[2]).toEqual({ path: 'untracked.txt', status: 'untracked', staged: false });
  });

  it('git_status returns empty files array when working tree is clean', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => 'main\n'); // branch
    execSync.mockImplementationOnce(() => '');        // status --porcelain (empty)
    const cb = vi.fn();
    socket.listeners('git_status')[0]({ cwd: '/tmp/repo' }, cb);
    expect(cb).toHaveBeenCalledWith({ branch: 'main', files: [] });
  });

  it('git_status maps deleted and renamed statuses', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => 'main\n');                              // branch
    execSync.mockImplementationOnce(() => 'D  old.js\nR  new.js\n D unstaged.js\n'); // status
    const cb = vi.fn();
    socket.listeners('git_status')[0]({ cwd: '/tmp/repo' }, cb);
    const { files } = cb.mock.calls[0][0];
    expect(files[0]).toMatchObject({ path: 'old.js', status: 'deleted', staged: true });
    expect(files[1]).toMatchObject({ path: 'new.js', status: 'renamed', staged: true });
    expect(files[2]).toMatchObject({ path: 'unstaged.js', status: 'deleted', staged: false });
  });

  it('git_diff returns staged diff', () => {
    const cb = vi.fn();
    socket.listeners('git_diff')[0]({ cwd: '/tmp/repo', filePath: 'src/new.js', staged: true }, cb);
    expect(cb).toHaveBeenCalledWith({ diff: '+staged change' });
  });

  it('git_diff returns unstaged diff', () => {
    const cb = vi.fn();
    socket.listeners('git_diff')[0]({ cwd: '/tmp/repo', filePath: 'src/app.js', staged: false }, cb);
    expect(cb).toHaveBeenCalledWith({ diff: '+unstaged change' });
  });

  it('git_diff shows full content for untracked files', () => {
    const cb = vi.fn();
    socket.listeners('git_diff')[0]({ cwd: '/tmp/repo', filePath: 'untracked.txt', staged: false }, cb);
    const diff = cb.mock.calls[0][0].diff;
    expect(diff).toContain('+new file content');
    expect(diff).toContain('+line 2');
    expect(diff).toContain('/dev/null');
  });

  it('handles errors gracefully', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });
    const cb = vi.fn();
    socket.listeners('git_status')[0]({ cwd: '/tmp/nope' }, cb);
    expect(cb).toHaveBeenCalledWith({ branch: '', files: [], error: expect.stringContaining('not a git repo') });
  });

  it('git_stage calls git add', () => {
    const cb = vi.fn();
    socket.listeners('git_stage')[0]({ cwd: '/tmp/repo', filePath: 'src/app.js' }, cb);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('git_unstage calls git reset HEAD', () => {
    const cb = vi.fn();
    socket.listeners('git_unstage')[0]({ cwd: '/tmp/repo', filePath: 'src/new.js' }, cb);
    expect(cb).toHaveBeenCalledWith({ success: true });
  });

  it('git_diff returns (no changes) when diff is empty', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('status --porcelain')) return ' M src/app.js\n';
      if (cmd.includes('diff')) return '';
      return '';
    });
    const cb = vi.fn();
    socket.listeners('git_diff')[0]({ cwd: '/tmp/repo', filePath: 'src/app.js', staged: false }, cb);
    expect(cb).toHaveBeenCalledWith({ diff: '(no changes)' });
  });

  it('git_diff handles errors', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => { throw new Error('diff fail'); });
    const cb = vi.fn();
    socket.listeners('git_diff')[0]({ cwd: '/tmp/repo', filePath: 'src/app.js', staged: true }, cb);
    expect(cb).toHaveBeenCalledWith({ diff: '', error: expect.stringContaining('diff fail') });
  });

  it('git_unstage handles errors', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => { throw new Error('unstage fail'); });
    const cb = vi.fn();
    socket.listeners('git_unstage')[0]({ cwd: '/tmp/repo', filePath: 'src/app.js' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('unstage fail') });
  });

  it('git_stage handles errors', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => { throw new Error('stage fail'); });
    const cb = vi.fn();
    socket.listeners('git_stage')[0]({ cwd: '/tmp/repo', filePath: 'bad.js' }, cb);
    expect(cb).toHaveBeenCalledWith({ error: expect.stringContaining('stage fail') });
    });
    });

    describe('Git Handlers - git_show_head', () => {

  let socket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new EventEmitter();
    registerGitHandlers({}, socket);
  });

  it('returns file content from HEAD', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => 'file content from HEAD\n');
    const cb = vi.fn();
    socket.listeners('git_show_head')[0]({ cwd: '/tmp/repo', filePath: 'src/app.js' }, cb);
    expect(cb).toHaveBeenCalledWith({ content: 'file content from HEAD' });
  });

  it('returns empty string for new files when git command throws', async () => {
    const { execSync } = await import('child_process');
    execSync.mockImplementationOnce(() => { throw new Error('path not found in HEAD'); });
    const cb = vi.fn();
    socket.listeners('git_show_head')[0]({ cwd: '/tmp/repo', filePath: 'new-file.js' }, cb);
    expect(cb).toHaveBeenCalledWith({ content: '' });
  });
});