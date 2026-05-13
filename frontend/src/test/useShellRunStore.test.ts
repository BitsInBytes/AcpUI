import { describe, it, expect, beforeEach } from 'vitest';
import { useShellRunStore, pruneShellRuns, trimShellTranscript } from '../store/useShellRunStore';

describe('useShellRunStore', () => {
  beforeEach(() => {
    useShellRunStore.getState().reset();
  });

  it('upserts snapshots by run id', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'run-1',
      status: 'pending',
      command: 'npm test',
      cwd: 'D:/repo',
      transcript: '$ npm test\n'
    });

    expect(useShellRunStore.getState().runs['run-1']).toEqual(expect.objectContaining({
      status: 'pending',
      command: 'npm test',
      transcript: '$ npm test\n'
    }));
  });

  it('appends output and applies max line trimming', () => {
    useShellRunStore.getState().appendOutput({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'run-1',
      chunk: 'one\ntwo\nthree\n',
      maxLines: 2,
      needsInput: true
    });

    expect(useShellRunStore.getState().runs['run-1']).toEqual(expect.objectContaining({
      status: 'running',
      transcript: 'two\nthree\n',
      maxLines: 2,
      needsInput: true
    }));
  });

  it('hydrates active state from snapshots for reattach', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'run-1',
      status: 'running',
      transcript: '$ watch\nline\n'
    });

    expect(useShellRunStore.getState().runs['run-1'].status).toBe('running');
    expect(useShellRunStore.getState().runs['run-1'].transcript).toBe('$ watch\nline\n');
  });

  it('marks exits as read-only terminal state', () => {
    useShellRunStore.getState().upsertSnapshot({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'run-1',
      status: 'running',
      transcript: '$ test\n',
      needsInput: true
    });

    useShellRunStore.getState().markExited({
      providerId: 'provider-a',
      sessionId: 'acp-1',
      runId: 'run-1',
      exitCode: 130,
      reason: 'user_terminated'
    });

    expect(useShellRunStore.getState().runs['run-1']).toEqual(expect.objectContaining({
      status: 'exited',
      exitCode: 130,
      reason: 'user_terminated',
      transcript: '$ test\n',
      needsInput: false
    }));
  });

  it('prunes old exited runs while retaining active runs', () => {
    const pruned = pruneShellRuns({
      active: { providerId: 'provider-a', sessionId: 'acp-1', runId: 'active', status: 'running', updatedAt: 1 },
      old: { providerId: 'provider-a', sessionId: 'acp-1', runId: 'old', status: 'exited', updatedAt: 2 },
      newest: { providerId: 'provider-a', sessionId: 'acp-1', runId: 'newest', status: 'exited', updatedAt: 3 }
    }, 2);

    expect(Object.keys(pruned).sort()).toEqual(['active', 'newest']);
  });
});

describe('trimShellTranscript', () => {
  it('keeps the last N lines while preserving trailing newline', () => {
    expect(trimShellTranscript('one\ntwo\nthree\n', 2)).toBe('two\nthree\n');
  });
});
