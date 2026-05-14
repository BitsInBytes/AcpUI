import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useScroll } from '../hooks/useScroll';
import { useUIStore } from '../store/useUIStore';

describe('useScroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    act(() => {
      useUIStore.setState({ isAutoScrollDisabled: false, toggleAutoScroll: vi.fn() });
    });
  });

  it('should initialize with auto-scroll enabled by default', () => {
    const { result } = renderHook(() => useScroll(null, [], 3));
    expect(result.current.isAutoScrollEnabled).toBe(true);
    expect(result.current.isManualScrollDisabled).toBe(false);
  });

  it('should load initial state from UI store', () => {
    act(() => { useUIStore.setState({ isAutoScrollDisabled: true }); });
    const { result } = renderHook(() => useScroll(null, [], 3));
    expect(result.current.isManualScrollDisabled).toBe(true);
  });

  it('should toggle auto-scroll via UI store action', () => {
    const toggleAutoScrollMock = vi.fn();
    act(() => { useUIStore.setState({ toggleAutoScroll: toggleAutoScrollMock, isAutoScrollDisabled: false }); });
    const { result } = renderHook(() => useScroll(null, [], 3));
    
    act(() => {
      result.current.toggleAutoScroll();
    });

    expect(toggleAutoScrollMock).toHaveBeenCalled();
  });

  it('uses the latest auto-scroll disabled flag without remounting', async () => {
    const { result } = renderHook(() => useScroll('1', [], 3));
    const mockEl = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
    (result.current.scrollRef as any).current = mockEl;

    act(() => {
      useUIStore.setState({ isAutoScrollDisabled: true });
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.scrollToBottom();
      result.current.handleWheel({ deltaY: -10 } as any);
    });

    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });

    expect(mockEl.scrollTop).toBe(0);
    expect(result.current.showScrollButton).toBe(true);
  });

  it('should scroll to bottom when session changes even if manually disabled', () => {
    act(() => { useUIStore.setState({ isAutoScrollDisabled: true }); });
    const { result, rerender } = renderHook(
      ({ sessionId }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: '1' } }
    );

    expect(result.current.isManualScrollDisabled).toBe(true);
    
    rerender({ sessionId: '2' });
    
    expect(result.current.isManualScrollDisabled).toBe(true);
  });

  it('should disable stickiness when scrolling up', () => {
    const { result } = renderHook(() => useScroll('1', [], 3));
    
    act(() => {
      result.current.handleWheel({ deltaY: -10 } as any);
    });

    expect(result.current.isAutoScrollEnabled).toBe(false);
    // Button only shows when auto-scroll toggle is off
    expect(result.current.showScrollButton).toBe(false);
  });

  it('scrollToBottom scrolls the ref element', async () => {
    const { result } = renderHook(() => useScroll('1', [], 3));

    // Create a mock element and assign to scrollRef
    const mockEl = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
    (result.current.scrollRef as any).current = mockEl;

    act(() => {
      result.current.scrollToBottom(true);
    });

    // scrollToBottom schedules via requestAnimationFrame; flush one frame.
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });

    expect(mockEl.scrollTop).toBe(1000);
  });

  it('handleScroll updates showScrollButton when not at bottom', () => {
    const { result } = renderHook(() => useScroll('1', [], 3));

    const mockEl = { scrollTop: 100, scrollHeight: 1000, clientHeight: 500 };
    (result.current.scrollRef as any).current = mockEl;

    // First scroll to set lastScrollTop high
    mockEl.scrollTop = 500;
    act(() => { result.current.handleScroll(); });

    // Now scroll up
    mockEl.scrollTop = 200;
    act(() => { result.current.handleScroll(); });

    // Button only shows when auto-scroll toggle is off
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.isAutoScrollEnabled).toBe(false);
  });

  it('handleWheel does not change state when scrolling down', () => {
    const { result } = renderHook(() => useScroll('1', [], 3));

    act(() => {
      result.current.handleWheel({ deltaY: 10 } as any);
    });

    // Scrolling down should not disable auto-scroll
    expect(result.current.isAutoScrollEnabled).toBe(true);
  });
});

// ─── ResizeObserver ──────────────────────────────────────────────────────────
// The hook creates one ResizeObserver instance (stable callback, no GC churn)
// and swaps the observed element when the active session changes.

describe('useScroll — ResizeObserver', () => {
  let observerCallback: () => void;
  let observeSpy: ReturnType<typeof vi.fn>;
  let disconnectSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useUIStore.setState({ isAutoScrollDisabled: false, toggleAutoScroll: vi.fn() });
    });

    observeSpy = vi.fn();
    disconnectSpy = vi.fn();
    // Capture the callback so tests can fire it manually.
    // Must use `function` (not arrow) so vi.fn() can be called with `new`.
    (globalThis as any).ResizeObserver = vi.fn(function(cb: () => void) {
      observerCallback = cb;
      return { observe: observeSpy, disconnect: disconnectSpy };
    });
  });

  afterEach(() => {
    delete (globalThis as any).ResizeObserver;
  });

  /** Build a scroll container with a content child and attach it to the hook ref. */
  function setupScrollEl(result: ReturnType<typeof useScroll>) {
    const scrollEl = document.createElement('div');
    const contentEl = document.createElement('div');
    scrollEl.appendChild(contentEl);
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true, writable: true });
    (result.scrollRef as any).current = scrollEl;
    return { scrollEl, contentEl };
  }

  it('creates the ResizeObserver exactly once on mount', () => {
    renderHook(() => useScroll('session-1', [], 3));
    expect((globalThis as any).ResizeObserver).toHaveBeenCalledTimes(1);
  });

  it('calls observe(firstElementChild) when a session is active', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: null as string | null } }
    );
    const { contentEl } = setupScrollEl(result.current);
    rerender({ sessionId: 'session-1' });
    expect(observeSpy).toHaveBeenCalledWith(contentEl);
  });

  it('disconnects old observation and re-observes new content when session changes', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: null as string | null } }
    );

    const scrollEl = document.createElement('div');
    const content1 = document.createElement('div');
    scrollEl.appendChild(content1);
    (result.current.scrollRef as any).current = scrollEl;

    rerender({ sessionId: 'session-1' });
    expect(observeSpy).toHaveBeenCalledWith(content1);

    // Swap content child to simulate a different session's DOM
    const content2 = document.createElement('div');
    scrollEl.removeChild(content1);
    scrollEl.appendChild(content2);

    rerender({ sessionId: 'session-2' });
    expect(disconnectSpy).toHaveBeenCalled();
    expect(observeSpy).toHaveBeenCalledWith(content2);
  });

  it('scrolls to bottom when observer callback fires and auto-scroll is enabled', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: null as string | null } }
    );
    const { scrollEl } = setupScrollEl(result.current);
    rerender({ sessionId: 'session-1' });

    act(() => { observerCallback(); });

    expect(scrollEl.scrollTop).toBe(1000);
  });

  it('does not scroll when isAutoScrollEnabled ref is false (user scrolled up)', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: null as string | null } }
    );
    const { scrollEl } = setupScrollEl(result.current);
    scrollEl.scrollTop = 0;
    rerender({ sessionId: 'session-1' });

    // Simulate user scrolling up — disables isAutoScrollEnabledRef
    act(() => { result.current.handleWheel({ deltaY: -10 } as any); });

    act(() => { observerCallback(); });
    expect(scrollEl.scrollTop).toBe(0); // unchanged
  });

  it('does not scroll when isAutoScrollDisabled store flag is true', () => {
    act(() => { useUIStore.setState({ isAutoScrollDisabled: true }); });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: null as string | null } }
    );
    const { scrollEl } = setupScrollEl(result.current);
    scrollEl.scrollTop = 0;
    rerender({ sessionId: 'session-1' });

    act(() => { observerCallback(); });
    expect(scrollEl.scrollTop).toBe(0); // unchanged
  });

  it('disconnects the observer on unmount', () => {
    const { result, rerender, unmount } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useScroll(sessionId, [], 3),
      { initialProps: { sessionId: null as string | null } }
    );
    setupScrollEl(result.current);
    rerender({ sessionId: 'session-1' });

    unmount();

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('skips observer setup gracefully when ResizeObserver is undefined', () => {
    delete (globalThis as any).ResizeObserver;

    // Should not throw even without ResizeObserver in the environment
    expect(() => renderHook(() => useScroll('session-1', [], 3))).not.toThrow();
  });
});
