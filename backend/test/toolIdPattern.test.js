import { describe, expect, it } from 'vitest';
import { matchToolIdPattern, replaceToolIdPattern, toolIdPatternToRegex } from '../services/tools/toolIdPattern.js';

describe('toolIdPattern', () => {
  it('matches provider-configured slash tool ids', () => {
    expect(matchToolIdPattern('Tool: AcpUI/ux_invoke_shell', '{mcpName}/{toolName}')).toEqual({
      raw: 'AcpUI/ux_invoke_shell',
      mcpName: 'AcpUI',
      toolName: 'ux_invoke_shell'
    });
  });

  it('matches provider-configured double underscore tool ids', () => {
    expect(matchToolIdPattern('mcp__AcpUI__ux_invoke_shell', 'mcp__{mcpName}__{toolName}')).toEqual({
      raw: 'mcp__AcpUI__ux_invoke_shell',
      mcpName: 'AcpUI',
      toolName: 'ux_invoke_shell'
    });
  });

  it('matches provider-configured Gemini ids without numeric suffixes', () => {
    expect(matchToolIdPattern('mcp_AcpUI_ux_invoke_shell-1', 'mcp_{mcpName}_{toolName}')).toEqual({
      raw: 'mcp_AcpUI_ux_invoke_shell',
      mcpName: 'AcpUI',
      toolName: 'ux_invoke_shell'
    });
  });

  it('replaces configured pattern occurrences', () => {
    expect(replaceToolIdPattern('Running: @AcpUI/ux_invoke_shell', '@{mcpName}/{toolName}')).toBe('Running: ux_invoke_shell');
  });

  it('returns null for missing or invalid patterns', () => {
    expect(toolIdPatternToRegex('')).toBeNull();
    expect(matchToolIdPattern('AcpUI/ux_invoke_shell', '')).toBeNull();
  });
});
