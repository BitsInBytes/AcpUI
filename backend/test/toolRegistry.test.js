import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../services/tools/toolRegistry.js';
import { ACP_UX_TOOL_NAMES } from '../services/tools/acpUxTools.js';
import { subAgentStatusToolHandler } from '../services/tools/handlers/subAgentStatusToolHandler.js';

describe('ToolRegistry', () => {
  it('dispatches lifecycle events by canonical tool name', () => {
    const registry = new ToolRegistry();
    const onStart = vi.fn((ctx, invocation, event) => ({ ...event, handled: true }));
    registry.register('ux_tool', { onStart });

    const event = registry.dispatch(
      'start',
      { providerId: 'p' },
      { identity: { canonicalName: 'ux_tool' } },
      { type: 'tool_start' }
    );

    expect(onStart).toHaveBeenCalled();
    expect(event.handled).toBe(true);
  });

  it('passes unknown tools through unchanged', () => {
    const registry = new ToolRegistry();
    const event = { type: 'tool_start' };
    expect(registry.dispatch('start', {}, { identity: { canonicalName: 'unknown' } }, event)).toBe(event);
  });

  it('titles sub-agent status tools by canonical identity', () => {
    expect(subAgentStatusToolHandler.onStart(
      {},
      { identity: { canonicalName: ACP_UX_TOOL_NAMES.checkSubagents } },
      { toolName: ACP_UX_TOOL_NAMES.checkSubagents }
    )).toEqual(expect.objectContaining({
      canonicalName: ACP_UX_TOOL_NAMES.checkSubagents,
      title: 'Check Subagents'
    }));

    expect(subAgentStatusToolHandler.onStart(
      {},
      { identity: { canonicalName: ACP_UX_TOOL_NAMES.abortSubagents } },
      { title: 'Provider title' }
    )).toEqual(expect.objectContaining({
      canonicalName: ACP_UX_TOOL_NAMES.abortSubagents,
      title: 'Abort Subagents'
    }));
  });

  it('falls back for unknown sub-agent status tool titles', () => {
    expect(subAgentStatusToolHandler.onStart(
      {},
      { identity: {} },
      { toolName: 'provider_tool', title: 'Provider title' }
    )).toEqual(expect.objectContaining({
      canonicalName: 'provider_tool',
      title: 'Provider title'
    }));

    expect(subAgentStatusToolHandler.onStart(
      {},
      { identity: {} },
      { toolName: 'provider_tool' }
    )).toEqual(expect.objectContaining({
      canonicalName: 'provider_tool',
      title: 'Sub-agent Status'
    }));
  });
});
