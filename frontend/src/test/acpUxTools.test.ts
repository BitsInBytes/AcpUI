import { describe, expect, it } from 'vitest';
import {
  ACP_UX_TOOL_NAMES,
  isAcpUxShellToolEvent,
  isAcpUxShellToolName,
  isAcpUxSubAgentStartToolEvent,
  isAcpUxSubAgentStatusToolName,
  isAcpUxSubAgentToolName,
  isAcpUxToolName,
  toolNameFromEvent
} from '../utils/acpUxTools';

describe('acpUxTools', () => {
  it('centralizes known AcpUI UX tool names', () => {
    expect(ACP_UX_TOOL_NAMES.invokeShell).toBe('ux_invoke_shell');
    expect(ACP_UX_TOOL_NAMES.invokeSubagents).toBe('ux_invoke_subagents');
    expect(ACP_UX_TOOL_NAMES.checkSubagents).toBe('ux_check_subagents');
  });

  it('normalizes direct tool name checks', () => {
    expect(isAcpUxToolName('UX_INVOKE_SHELL')).toBe(true);
    expect(isAcpUxShellToolName(' ux_invoke_shell ')).toBe(true);
    expect(isAcpUxSubAgentToolName('ux_abort_subagents')).toBe(true);
    expect(isAcpUxSubAgentStatusToolName('ux_check_subagents')).toBe(true);
    expect(isAcpUxSubAgentStatusToolName('ux_invoke_subagents')).toBe(false);
    expect(isAcpUxSubAgentToolName('ux_read_file')).toBe(false);
  });

  it('resolves tool identity from normalized event fields', () => {
    const event = { toolName: 'provider-tool', canonicalName: 'ux_invoke_counsel' };

    expect(toolNameFromEvent(event)).toBe('ux_invoke_counsel');
    expect(toolNameFromEvent({ toolName: 'provider-tool', mcpToolName: 'ux_invoke_shell' })).toBe('provider-tool');
    expect(toolNameFromEvent({ mcpToolName: 'ux_invoke_shell' })).toBe('ux_invoke_shell');
    expect(isAcpUxSubAgentStartToolEvent(event)).toBe(true);
    expect(isAcpUxShellToolEvent({ mcpToolName: 'ux_invoke_shell' })).toBe(true);
  });
});
