import { beforeEach, describe, expect, it } from 'vitest';
import { applyInvocationToEvent, resolveToolInvocation } from '../services/tools/toolInvocationResolver.js';
import { toolCallState } from '../services/tools/toolCallState.js';

describe('toolInvocationResolver', () => {
  beforeEach(() => {
    toolCallState.clear();
  });

  it('uses provider extraction as canonical tool identity', () => {
    const providerModule = {
      extractToolInvocation: () => ({
        canonicalName: 'ux_invoke_shell',
        mcpServer: 'AcpUI',
        mcpToolName: 'ux_invoke_shell',
        input: { description: 'Run tests', command: 'npm test' },
        title: 'Invoke Shell: Run tests'
      })
    };

    const invocation = resolveToolInvocation({
      providerId: 'p',
      sessionId: 's',
      update: { sessionUpdate: 'tool_call', toolCallId: 't' },
      event: { id: 't', type: 'tool_start', title: 'Invoke Shell' },
      providerModule
    });

    expect(invocation.identity).toEqual(expect.objectContaining({
      canonicalName: 'ux_invoke_shell',
      mcpServer: 'AcpUI'
    }));
    expect(invocation.input.command).toBe('npm test');
    expect(invocation.display.title).toBe('Invoke Shell: Run tests');
  });

  it('reuses cached identity and title for incomplete updates', () => {
    toolCallState.upsert({
      providerId: 'p',
      sessionId: 's',
      toolCallId: 't',
      identity: { canonicalName: 'ux_invoke_shell' },
      display: { title: 'Invoke Shell: Run tests', titleSource: 'tool_handler' }
    });

    const invocation = resolveToolInvocation({
      providerId: 'p',
      sessionId: 's',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
      event: { id: 't', type: 'tool_end', title: 'Invoke Shell' },
      providerModule: { extractToolInvocation: () => null }
    });

    const event = applyInvocationToEvent({ id: 't', title: 'Invoke Shell' }, invocation);

    expect(event.toolName).toBe('ux_invoke_shell');
    expect(event.title).toBe('Invoke Shell: Run tests');
  });
});
