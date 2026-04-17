import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVoiceStore } from '../store/useVoiceStore';
import { act } from 'react-dom/test-utils';

describe('useVoiceStore', () => {
  beforeEach(() => {
    act(() => {
      useVoiceStore.setState({
        isRecording: false,
        isProcessingVoice: false,
        availableAudioDevices: [],
        selectedAudioDevice: ''
      });
    });
    localStorage.clear();
  });

  it('updates recording and processing state', () => {
    act(() => {
      useVoiceStore.getState().setIsRecording(true);
      useVoiceStore.getState().setIsProcessingVoice(true);
    });
    expect(useVoiceStore.getState().isRecording).toBe(true);
    expect(useVoiceStore.getState().isProcessingVoice).toBe(true);
  });

  it('manages available audio devices', () => {
    const devices = [
      { id: '1', label: 'Mic 1' },
      { id: '2', label: 'Mic 2' }
    ];
    act(() => {
      useVoiceStore.getState().setAvailableAudioDevices(devices);
    });
    expect(useVoiceStore.getState().availableAudioDevices).toEqual(devices);
  });

  it('updates selected audio device and persists to localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      useVoiceStore.getState().setSelectedAudioDevice('mic-id-123');
    });
    expect(useVoiceStore.getState().selectedAudioDevice).toBe('mic-id-123');
    expect(spy).toHaveBeenCalledWith('selectedAudioDevice', 'mic-id-123');
  });

  it('fetchAudioDevices updates state from navigator.mediaDevices', async () => {
    const mockDevices = [
      { kind: 'audioinput', deviceId: 'd1', label: 'Mic 1' },
      { kind: 'videoinput', deviceId: 'v1', label: 'Cam 1' }
    ];
    
    // Mock navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue(mockDevices)
      },
      configurable: true
    });

    await act(async () => {
      await useVoiceStore.getState().fetchAudioDevices();
    });

    const state = useVoiceStore.getState();
    expect(state.availableAudioDevices).toEqual([{ id: 'd1', label: 'Mic 1' }]);
  });

  it('setIsVoiceEnabled updates state', () => {
    act(() => { useVoiceStore.getState().setIsVoiceEnabled(true); });
    expect(useVoiceStore.getState().isVoiceEnabled).toBe(true);
    act(() => { useVoiceStore.getState().setIsVoiceEnabled(false); });
    expect(useVoiceStore.getState().isVoiceEnabled).toBe(false);
  });

  it('fetchAudioDevices handles errors gracefully', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { enumerateDevices: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { await useVoiceStore.getState().fetchAudioDevices(); });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fetchAudioDevices labels unknown devices', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'd1', label: '' }]) },
      configurable: true
    });
    await act(async () => { await useVoiceStore.getState().fetchAudioDevices(); });
    expect(useVoiceStore.getState().availableAudioDevices[0].label).toBe('Unknown Microphone');
  });
});

