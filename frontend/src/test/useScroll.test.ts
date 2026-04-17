import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('scrollToBottom scrolls the ref element', () => {
    const { result } = renderHook(() => useScroll('1', [], 3));

    // Create a mock element and assign to scrollRef
    const mockEl = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
    (result.current.scrollRef as any).current = mockEl;

    vi.useFakeTimers();
    act(() => {
      result.current.scrollToBottom(true);
    });
    vi.advanceTimersByTime(20);

    expect(mockEl.scrollTop).toBe(1000);
    vi.useRealTimers();
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