import { beforeEach, describe, expect, it } from 'vitest';
import { ToolCallState } from '../services/tools/toolCallState.js';

describe('ToolCallState', () => {
  let state;

  beforeEach(() => {
    state = new ToolCallState();
  });

  it('merges identity, input, file path, and tool-specific metadata by tool call id', () => {
    state.upsert({
      providerId: 'p',
      sessionId: 's',
      toolCallId: 't',
      identity: { canonicalName: 'ux_invoke_shell' },
      input: { command: 'npm test' },
      filePath: 'a.js'
    });

    const record = state.upsert({
      providerId: 'p',
      sessionId: 's',
      toolCallId: 't',
      input: { cwd: 'D:/repo' },
      toolSpecific: { shellRunId: 'run-1' }
    });

    expect(record).toEqual(expect.objectContaining({
      identity: expect.objectContaining({ canonicalName: 'ux_invoke_shell' }),
      input: expect.objectContaining({ command: 'npm test', cwd: 'D:/repo' }),
      filePath: 'a.js',
      toolSpecific: expect.objectContaining({ shellRunId: 'run-1' })
    }));
  });

  it('preserves authoritative titles over later provider titles', () => {
    state.upsert({
      providerId: 'p',
      sessionId: 's',
      toolCallId: 't',
      display: { title: 'Invoke Shell: Run tests', titleSource: 'mcp_handler' }
    });

    const record = state.upsert({
      providerId: 'p',
      sessionId: 's',
      toolCallId: 't',
      display: { title: 'Invoke Shell', titleSource: 'provider' }
    });

    expect(record.display.title).toBe('Invoke Shell: Run tests');
  });
});
