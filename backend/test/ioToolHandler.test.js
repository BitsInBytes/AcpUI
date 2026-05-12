import { beforeEach, describe, expect, it } from 'vitest';
import { toolCallState, toolRegistry } from '../services/tools/index.js';

describe('IO Tool System V2 handler', () => {
  const ctx = { providerId: 'provider-a', sessionId: 'acp-1' };

  beforeEach(() => {
    toolCallState.clear();
  });

  it('applies file metadata for ux_write_file', () => {
    const event = toolRegistry.dispatch('start', ctx, {
      toolCallId: 'tool-write-1',
      identity: { canonicalName: 'ux_write_file' },
      input: { file_path: 'D:/Git/AcpUI/src/app.ts', content: 'export {};\n' }
    }, {
      id: 'tool-write-1',
      title: 'AcpUI/write_file'
    });

    expect(event).toEqual(expect.objectContaining({
      id: 'tool-write-1',
      toolName: 'ux_write_file',
      canonicalName: 'ux_write_file',
      title: 'Write File: app.ts',
      toolCategory: 'file_write',
      isFileOperation: true,
      filePath: 'D:/Git/AcpUI/src/app.ts'
    }));
  });

  it('uses grep description for the visual title', () => {
    const event = toolRegistry.dispatch('start', ctx, {
      toolCallId: 'tool-grep-1',
      identity: { canonicalName: 'ux_grep_search' },
      input: { description: 'Find TODO markers', pattern: 'TODO' }
    }, {
      id: 'tool-grep-1',
      title: 'AcpUI/grep_search: TODO'
    });

    expect(event).toEqual(expect.objectContaining({
      toolName: 'ux_grep_search',
      canonicalName: 'ux_grep_search',
      title: 'Search: Find TODO markers',
      toolCategory: 'grep',
      isFileOperation: true
    }));
  });

  it('uses fetch URL for the visual title', () => {
    const event = toolRegistry.dispatch('start', ctx, {
      toolCallId: 'tool-fetch-1',
      identity: { canonicalName: 'ux_web_fetch' },
      input: { url: 'https://example.test/docs' }
    }, {
      id: 'tool-fetch-1',
      title: 'AcpUI/web_fetch'
    });

    expect(event).toEqual(expect.objectContaining({
      toolName: 'ux_web_fetch',
      canonicalName: 'ux_web_fetch',
      title: 'Fetch: https://example.test/docs',
      toolCategory: 'fetch',
      isFileOperation: false
    }));
  });
});
