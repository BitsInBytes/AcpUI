import { beforeEach, describe, expect, it } from 'vitest';
import { applyInvocationToEvent, resolveToolInvocation } from '../services/tools/toolInvocationResolver.js';
import { toolCallState } from '../services/tools/toolCallState.js';
import { mcpExecutionRegistry } from '../services/tools/mcpExecutionRegistry.js';

describe('toolInvocationResolver', () => {
  beforeEach(() => {
    toolCallState.clear();
    mcpExecutionRegistry.clear();
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
      providerModule,
      acpUiMcpServerName: 'AcpUI'
    });

    expect(invocation.identity).toEqual(expect.objectContaining({
      kind: 'acpui_mcp',
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
      identity: { kind: 'acpui_mcp', canonicalName: 'ux_invoke_shell' },
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
    expect(event.titleSource).toBe('tool_handler');
    expect(event.isAcpUxTool).toBe(true);
  });

  it('marks registered AcpUI UX tool names without relying on a ux prefix', () => {
    const invocation = resolveToolInvocation({
      providerId: 'p',
      sessionId: 's',
      update: { sessionUpdate: 'tool_call', toolCallId: 't' },
      event: { id: 't', type: 'tool_start', toolName: 'ux_read_file', title: 'Read File' },
      providerModule: {
        extractToolInvocation: () => ({
          canonicalName: 'ux_read_file',
          input: { file_path: 'D:/repo/app.ts' }
        })
      },
      acpUiMcpServerName: 'AcpUI'
    });

    const event = applyInvocationToEvent({ id: 't', title: 'Read File' }, invocation);

    expect(invocation.identity).toEqual(expect.objectContaining({
      kind: 'acpui_mcp',
      canonicalName: 'ux_read_file',
      mcpServer: 'AcpUI',
      mcpToolName: 'ux_read_file'
    }));
    expect(event.isAcpUxTool).toBe(true);
  });

  it('prefers centrally recorded MCP execution details over provider generic titles', () => {
    mcpExecutionRegistry.begin({
      providerId: 'p',
      sessionId: 's',
      mcpRequestId: 'mcp_AcpUI_ux_google_web_search-1',
      toolName: 'ux_google_web_search',
      input: { query: 'winnipeg mb current weather' }
    });

    const invocation = resolveToolInvocation({
      providerId: 'p',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp_AcpUI_ux_google_web_search-1',
        status: 'completed',
        title: 'ux_google_web_search (AcpUI MCP Server)'
      },
      event: { id: 'mcp_AcpUI_ux_google_web_search-1', type: 'tool_end', title: 'Web Search' },
      providerModule: {
        extractToolInvocation: () => ({
          canonicalName: 'ux_google_web_search',
          mcpServer: 'AcpUI',
          mcpToolName: 'ux_google_web_search',
          input: {},
          title: 'Web Search'
        })
      },
      acpUiMcpServerName: 'AcpUI'
    });

    const event = applyInvocationToEvent({ id: 'mcp_AcpUI_ux_google_web_search-1', title: 'Web Search' }, invocation);

    expect(invocation.input).toEqual(expect.objectContaining({ query: 'winnipeg mb current weather' }));
    expect(invocation.display).toEqual(expect.objectContaining({
      title: 'Web Search: winnipeg mb current weather',
      titleSource: 'mcp_handler'
    }));
    expect(event.title).toBe('Web Search: winnipeg mb current weather');
    expect(event.isAcpUxTool).toBe(true);
  });

  it('can claim a recent MCP execution when the provider tool id arrives later', () => {
    mcpExecutionRegistry.begin({
      providerId: 'p',
      sessionId: 's',
      mcpRequestId: 99,
      toolName: 'ux_glob',
      input: { description: 'Find docs', pattern: '*.md' }
    });

    const invocation = resolveToolInvocation({
      providerId: 'p',
      sessionId: 's',
      update: { sessionUpdate: 'tool_call', toolCallId: 'provider-tool-1', title: 'Glob' },
      event: { id: 'provider-tool-1', type: 'tool_start', title: 'Glob' },
      providerModule: {
        extractToolInvocation: () => ({
          canonicalName: 'ux_glob',
          mcpServer: 'AcpUI',
          mcpToolName: 'ux_glob',
          title: 'Glob'
        })
      },
      acpUiMcpServerName: 'AcpUI'
    });

    expect(invocation.toolCallId).toBe('provider-tool-1');
    expect(invocation.input).toEqual(expect.objectContaining({ description: 'Find docs', pattern: '*.md' }));
    expect(invocation.display.title).toBe('Glob: Find docs');
    expect(toolCallState.get('p', 's', 'provider-tool-1')).toEqual(expect.objectContaining({
      display: expect.objectContaining({ title: 'Glob: Find docs', titleSource: 'mcp_handler' })
    }));
  });

  it('does not claim recent MCP execution details when tool-name fallback is ambiguous', () => {
    mcpExecutionRegistry.begin({
      providerId: 'p',
      sessionId: 's',
      mcpRequestId: 101,
      toolName: 'ux_invoke_shell',
      input: { description: 'First shell', command: 'node -p "one"' }
    });
    mcpExecutionRegistry.begin({
      providerId: 'p',
      sessionId: 's',
      mcpRequestId: 102,
      toolName: 'ux_invoke_shell',
      input: { description: 'Second shell', command: 'node -p "two"' }
    });

    expect(mcpExecutionRegistry.find({
      providerId: 'p',
      sessionId: 's',
      toolCallId: 'provider-shell',
      toolName: 'ux_invoke_shell'
    })).toBeNull();
  });
});
