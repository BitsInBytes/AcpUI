import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '../store/useCanvasStore';

describe('useCanvasStore', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      isCanvasOpen: false,
      terminals: [],
      activeTerminalId: null,
      canvasArtifacts: [],
      activeCanvasArtifact: null,
    });
  });

  it('opens a terminal', () => {
    useCanvasStore.getState().openTerminal('s1');
    const state = useCanvasStore.getState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].sessionId).toBe('s1');
    expect(state.isCanvasOpen).toBe(true);
    expect(state.activeTerminalId).toBe(state.terminals[0].id);
  });

  it('closes a terminal', () => {
    useCanvasStore.getState().openTerminal('s1');
    const termId = useCanvasStore.getState().terminals[0].id;
    useCanvasStore.getState().closeTerminal(termId);
    const state = useCanvasStore.getState();
    expect(state.terminals).toHaveLength(0);
    expect(state.isCanvasOpen).toBe(false);
  });

  it('handles opening an artifact in canvas', () => {
    const artifact = { id: 'a1', sessionId: 's1', title: 'T', content: 'C', language: 'L', version: 1 };
    useCanvasStore.getState().handleOpenInCanvas(null, 's1', artifact);
    const state = useCanvasStore.getState();
    expect(state.canvasArtifacts).toHaveLength(1);
    expect(state.activeCanvasArtifact).toEqual(artifact);
    expect(state.isCanvasOpen).toBe(true);
  });

  it('updates existing artifact in canvas', () => {
    const artifact = { id: 'a1', sessionId: 's1', title: 'T', content: 'C', language: 'L', version: 1 };
    useCanvasStore.getState().handleOpenInCanvas(null, 's1', artifact);
    const updated = { ...artifact, content: 'New' };
    useCanvasStore.getState().handleOpenInCanvas(null, 's1', updated);
    const state = useCanvasStore.getState();
    expect(state.canvasArtifacts).toHaveLength(1);
    expect(state.canvasArtifacts[0].content).toBe('New');
  });

  it('closes an artifact', () => {
    const artifact = { id: 'a1', sessionId: 's1', title: 'T', content: 'C', language: 'L', version: 1 };
    useCanvasStore.getState().handleOpenInCanvas(null, 's1', artifact);
    useCanvasStore.getState().handleCloseArtifact(null, 'a1');
    const state = useCanvasStore.getState();
    expect(state.canvasArtifacts).toHaveLength(0);
    expect(state.isCanvasOpen).toBe(false);
  });
});
