import { create } from 'zustand';

export interface AudioDevice {
  id: string;
  label: string;
}

interface VoiceState {
  isRecording: boolean;
  isProcessingVoice: boolean;
  isVoiceEnabled: boolean;
  availableAudioDevices: AudioDevice[];
  selectedAudioDevice: string;

  // Actions
  setIsRecording: (recording: boolean) => void;
  setIsProcessingVoice: (processing: boolean) => void;
  setIsVoiceEnabled: (enabled: boolean) => void;
  setAvailableAudioDevices: (devices: AudioDevice[]) => void;
  setSelectedAudioDevice: (deviceId: string) => void;
  fetchAudioDevices: () => Promise<void>;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  isRecording: false,
  isProcessingVoice: false,
  isVoiceEnabled: false,
  availableAudioDevices: [],
  selectedAudioDevice: localStorage.getItem('selectedAudioDevice') || '',

  setIsRecording: (recording) => set({ isRecording: recording }),
  setIsProcessingVoice: (processing) => set({ isProcessingVoice: processing }),
  setIsVoiceEnabled: (enabled) => set({ isVoiceEnabled: enabled }),
  setAvailableAudioDevices: (devices) => set({ availableAudioDevices: devices }),
  setSelectedAudioDevice: (deviceId) => {
    localStorage.setItem('selectedAudioDevice', deviceId);
    set({ selectedAudioDevice: deviceId });
  },

  fetchAudioDevices: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, label: d.label || 'Unknown Microphone' }));
      set({ availableAudioDevices: audioDevices });
    } catch (err) {
      console.error('Failed to fetch audio devices:', err);
    }
  },
}));
