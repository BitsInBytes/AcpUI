import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { formatDuration, useElapsed } from '../utils/timer';

describe('formatDuration', () => {
  it('shows ms for < 1 second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(342)).toBe('342ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('shows seconds for 1s - 59s', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(12500)).toBe('12s');
    expect(formatDuration(59999)).toBe('59s');
  });

  it('shows minutes + seconds for >= 60s', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(135000)).toBe('2m 15s');
    expect(formatDuration(3661000)).toBe('61m 1s');
  });
});

describe('useElapsed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns null when no startTime', () => {
    const { result } = renderHook(() => useElapsed(undefined, undefined));
    expect(result.current).toBeNull();
  });

  it('returns final duration when endTime is set', () => {
    const { result } = renderHook(() => useElapsed(1000, 3500));
    expect(result.current).toBe('2s');
  });

  it('returns live duration when endTime is undefined', () => {
    const now = Date.now();
    const { result } = renderHook(() => useElapsed(now, undefined));
    expect(result.current).toBe('0ms');

    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current).toBe('1s');
  });

  it('stops ticking when endTime is provided', () => {
    const now = Date.now();
    const { result, rerender } = renderHook(
      ({ start, end }) => useElapsed(start, end),
      { initialProps: { start: now, end: undefined as number | undefined } }
    );

    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current).toBe('2s');

    // Set endTime — should freeze
    rerender({ start: now, end: now + 2000 });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current).toBe('2s');
  });
});
