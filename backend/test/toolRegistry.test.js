import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../services/tools/toolRegistry.js';

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
});
