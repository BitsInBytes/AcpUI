import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileUpload } from '../hooks/useFileUpload';
import { useChatStore } from '../store/useChatStore';

// Polyfill ClipboardEvent for JSDOM
if (typeof ClipboardEvent === 'undefined') {
  (window as any).ClipboardEvent = class ClipboardEvent extends Event {
    clipboardData: any;
    constructor(type: string, options?: any) {
      super(type, options);
      this.clipboardData = options?.clipboardData;
    }
  };
}

describe('useFileUpload', () => {
  const activeSessionId = 's1';
  const activeSessionIdRef = { current: activeSessionId };

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      attachmentsMap: { [activeSessionId]: [] },
      setAttachments: vi.fn((sessionId, updater) => {
        const current = useChatStore.getState().attachmentsMap[sessionId] || [];
        const next = typeof updater === 'function' ? updater(current) : updater;
        useChatStore.setState(state => ({
          attachmentsMap: { ...state.attachmentsMap, [sessionId]: next }
        }));
      })
    });
    
    // Mock fetch
    window.fetch = vi.fn();
    window.alert = vi.fn();
  });

  it('initializes with attachments from store', () => {
    const attachment: any = { name: 'test.txt' };
    useChatStore.setState({ attachmentsMap: { [activeSessionId]: [attachment] } });
    
    const { result } = renderHook(() => useFileUpload(activeSessionId, activeSessionIdRef));
    expect(result.current.attachments).toEqual([attachment]);
  });

  it('handleFileUpload uploads files and updates store', async () => {
    const mockFiles = [new File(['content'], 'test.txt', { type: 'text/plain' })];
    (window.fetch as any).mockResolvedValue({
      json: () => Promise.resolve({ success: true, files: [{ name: 'test.txt', url: '...' }] })
    });

    const { result } = renderHook(() => useFileUpload(activeSessionId, activeSessionIdRef));
    
    await act(async () => {
      await result.current.handleFileUpload(mockFiles);
    });

    expect(window.fetch).toHaveBeenCalled();
    expect(useChatStore.getState().attachmentsMap[activeSessionId].length).toBe(1);
  });

  it('handleFileUpload alerts if no active session', async () => {
    const emptyRef = { current: null };
    const { result } = renderHook(() => useFileUpload(null, emptyRef));
    
    await act(async () => {
      await result.current.handleFileUpload([new File([], 'test.txt')]);
    });

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Please select a chat session'));
  });

  it('handlePaste processes files from clipboard', async () => {
    (window.fetch as any).mockResolvedValue({
      json: () => Promise.resolve({ success: true, files: [{ name: 'pasted.png', mimeType: 'image/png' }] })
    });

    renderHook(() => useFileUpload(activeSessionId, activeSessionIdRef));

    const mockFile = new File(['img'], 'pasted.png', { type: 'image/png' });
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: {
        files: [mockFile],
        items: [{ kind: 'file', getAsFile: () => mockFile }],
        types: ['Files']
      } as any
    });

    await act(async () => {
      window.dispatchEvent(pasteEvent);
    });

    expect(window.fetch).toHaveBeenCalled();
  });

  it('handlePaste does not prevent default for non-file clipboard data', () => {
    renderHook(() => useFileUpload(activeSessionId, activeSessionIdRef));

    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: {
        files: [],
        items: [{ kind: 'string', getAsFile: () => null }],
        types: ['text/plain']
      } as any
    });
    const preventDefaultSpy = vi.spyOn(pasteEvent, 'preventDefault');

    act(() => {
      window.dispatchEvent(pasteEvent);
    });

    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('handleFileUpload returns early with null files', async () => {
    const { result } = renderHook(() => useFileUpload(activeSessionId, activeSessionIdRef));

    await act(async () => {
      await result.current.handleFileUpload(null);
    });

    expect(window.fetch).not.toHaveBeenCalled();
  });
});
