import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BroadcastChannel as a class before importing the module
let mockPostMessage: ReturnType<typeof vi.fn>;
let capturedOnMessage: ((e: MessageEvent) => void) | null;

beforeEach(() => {
  mockPostMessage = vi.fn();
  capturedOnMessage = null;

  class MockBroadcastChannel {
    postMessage = mockPostMessage;
    close = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn();
    get onmessage() { return capturedOnMessage; }
    set onmessage(fn: any) { capturedOnMessage = fn; }
    constructor() {}
  }

  (globalThis as any).BroadcastChannel = MockBroadcastChannel as any;
});

let mod: typeof import('../lib/sessionOwnership');

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../lib/sessionOwnership');
});

describe('sessionOwnership', () => {
  it('claimSession posts a claim message', () => {
    mod.claimSession('sess-1');
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'claim', sessionId: 'sess-1' })
    );
  });

  it('releaseSession posts a release message', () => {
    mod.releaseSession('sess-1');
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'release', sessionId: 'sess-1' })
    );
  });

  it('isSessionPoppedOut returns false initially', () => {
    expect(mod.isSessionPoppedOut('sess-1')).toBe(false);
  });

  it('getWindowId returns a string starting with win-', () => {
    expect(mod.getWindowId()).toMatch(/^win-/);
  });

  it('setOwnershipChangeCallback initializes the channel', () => {
    const cb = vi.fn();
    mod.setOwnershipChangeCallback(cb);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'query' });
  });

  it('claim from another window marks session as popped out', () => {
    const cb = vi.fn();
    mod.setOwnershipChangeCallback(cb);
    capturedOnMessage?.({ data: { type: 'claim', sessionId: 'sess-2', windowId: 'other-win' } } as MessageEvent);
    expect(mod.isSessionPoppedOut('sess-2')).toBe(true);
    expect(cb).toHaveBeenCalledWith('sess-2', true);
  });

  it('release from another window removes popped out status', () => {
    const cb = vi.fn();
    mod.setOwnershipChangeCallback(cb);
    capturedOnMessage?.({ data: { type: 'claim', sessionId: 'sess-3', windowId: 'other-win' } } as MessageEvent);
    capturedOnMessage?.({ data: { type: 'release', sessionId: 'sess-3', windowId: 'other-win' } } as MessageEvent);
    expect(mod.isSessionPoppedOut('sess-3')).toBe(false);
    expect(cb).toHaveBeenCalledWith('sess-3', false);
  });

  it('announce from another window marks session as popped out', () => {
    const cb = vi.fn();
    mod.setOwnershipChangeCallback(cb);
    capturedOnMessage?.({ data: { type: 'announce', sessionId: 'sess-4', windowId: 'other-win' } } as MessageEvent);
    expect(mod.isSessionPoppedOut('sess-4')).toBe(true);
    expect(cb).toHaveBeenCalledWith('sess-4', true);
  });

  it('claim from own window is ignored', () => {
    const cb = vi.fn();
    mod.setOwnershipChangeCallback(cb);
    const ownWindowId = mod.getWindowId();
    capturedOnMessage?.({ data: { type: 'claim', sessionId: 'sess-5', windowId: ownWindowId } } as MessageEvent);
    expect(mod.isSessionPoppedOut('sess-5')).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('openPopout opens a new window', async () => {
    const mockWin = { closed: false, focus: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(mockWin as any);
    const result = await mod.openPopout('sess-6');
    expect(window.open).toHaveBeenCalledWith('/?popout=sess-6', 'popout-sess-6', 'width=1000,height=750');
    expect(result).toBe(mockWin);
  });

  it('openPopout focuses existing window if not closed', async () => {
    const mockWin = { closed: false, focus: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(mockWin as any);
    await mod.openPopout('sess-7');
    const result = await mod.openPopout('sess-7');
    expect(mockWin.focus).toHaveBeenCalled();
    expect(result).toBe(mockWin);
  });

  it('openPopout opens new window if existing is closed', async () => {
    const closedWin = { closed: true, focus: vi.fn() };
    const newWin = { closed: false, focus: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValueOnce(closedWin as any).mockReturnValueOnce(newWin as any);
    await mod.openPopout('sess-8');
    const result = await mod.openPopout('sess-8');
    expect(result).toBe(newWin);
  });

  it('focusPopout returns false when no window exists', () => {
    expect(mod.focusPopout('nonexistent')).toBe(false);
  });

  it('focusPopout returns true and focuses existing window', () => {
    const mockWin = { closed: false, focus: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(mockWin as any);
    mod.openPopout('sess-9');
    expect(mod.focusPopout('sess-9')).toBe(true);
    expect(mockWin.focus).toHaveBeenCalled();
  });

  it('focusPopout returns false when window is closed', () => {
    const mockWin = { closed: false, focus: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(mockWin as any);
    mod.openPopout('sess-10');
    (mockWin as any).closed = true;
    expect(mod.focusPopout('sess-10')).toBe(false);
  });
});
