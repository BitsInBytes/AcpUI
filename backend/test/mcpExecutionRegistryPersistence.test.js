import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/sessionStreamPersistence.js', () => ({
  persistStreamEvent: vi.fn().mockResolvedValue(null)
}));

vi.mock('../services/providerLoader.js', () => ({
  getProvider: vi.fn(() => ({ id: 'test-provider', config: { mcpName: 'AcpUI' } }))
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

import { McpExecutionRegistry, mcpExecutionRegistry } from '../services/tools/mcpExecutionRegistry.js';
import { toolCallState } from '../services/tools/toolCallState.js';
import { persistStreamEvent } from '../services/sessionStreamPersistence.js';

describe('mcpExecutionRegistry persistence projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpExecutionRegistry.clear();
    toolCallState.clear();
  });

  it('persists terminal MCP tool updates with invocation metadata', () => {
    const io = { to: vi.fn().mockReturnThis(), emit: vi.fn() };

    const record = mcpExecutionRegistry.begin({
      io,
      providerId: 'test-provider',
      sessionId: 'acp-1',
      mcpRequestId: 'mcp_AcpUI_ux_invoke_subagents-1',
      requestMeta: { toolCallId: 'tool-sub-1' },
      toolName: 'ux_invoke_subagents',
      input: { requests: [{ prompt: 'do task' }] }
    });

    mcpExecutionRegistry.complete(record, {
      content: [{ type: 'text', text: 'Invocation ID: inv-123\nCall ux_check_subagents next.' }]
    });

    expect(persistStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'test-provider' }),
      'acp-1',
      expect.objectContaining({
        type: 'tool_end',
        id: 'tool-sub-1',
        status: 'completed',
        toolName: 'ux_invoke_subagents',
        canonicalName: 'ux_invoke_subagents',
        invocationId: 'inv-123'
      }),
      { force: true }
    );

    expect(io.to).toHaveBeenCalledWith('session:acp-1');
    expect(io.emit).toHaveBeenCalledWith('system_event', expect.objectContaining({
      type: 'tool_end',
      id: 'tool-sub-1',
      invocationId: 'inv-123'
    }));
  });

  it('prunes old records and rebuilds lookup indexes', () => {
    const registry = new McpExecutionRegistry();

    for (let i = 0; i < 502; i++) {
      registry.records.set(`exec-${i}`, {
        executionId: `exec-${i}`,
        providerId: 'test-provider',
        sessionId: 'acp-1',
        mcpRequestId: `request-${i}`,
        toolCallId: `tool-${i}`,
        toolName: 'ux_read_file',
        updatedAt: i
      });
    }

    registry.prune();

    expect(registry.records.size).toBe(500);
    expect(registry.records.has('exec-0')).toBe(false);
    expect(registry.records.has('exec-1')).toBe(false);
    expect(registry.byToolCallId.get('test-provider::acp-1::tool-501')).toBe('exec-501');
    expect(registry.byMcpRequestId.get('test-provider::acp-1::request-500')).toBe('exec-500');
    expect(registry.bySessionTool.get('test-provider::acp-1::ux_read_file')).toContain('exec-501');
  });
});
