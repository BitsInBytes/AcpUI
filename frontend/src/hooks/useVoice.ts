import { useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { WavRecorder } from '../utils/wavRecorder';
import { useVoiceStore } from '../store/useVoiceStore';

export function useVoice(socket: Socket | null) {
  const isRecording = useVoiceStore(state => state.isRecording);
  const setIsRecording = useVoiceStore(state => state.setIsRecording);
  const isProcessingVoice = useVoiceStore(state => state.isProcessingVoice);
  const setIsProcessingVoice = useVoiceStore(state => state.setIsProcessingVoice);
  const availableAudioDevices = useVoiceStore(state => state.availableAudioDevices);
  const setAvailableAudioDevices = useVoiceStore(state => state.setAvailableAudioDevices);
  const selectedAudioDevice = useVoiceStore(state => state.selectedAudioDevice);
  const setSelectedAudioDevice = useVoiceStore(state => state.setSelectedAudioDevice);
  
  const recorderRef = useRef<WavRecorder | null>(null);
  const voiceStartTimeRef = useRef<number>(0);
  const isMouseDownOnMicRef = useRef<boolean>(false);

  const fetchAudioDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, label: d.label || 'Default Microphone' }));
      
      setAvailableAudioDevices(audioInputs);
      if (audioInputs.length > 0 && !selectedAudioDevice) {
        setSelectedAudioDevice(audioInputs[0].id);
      }
    } catch (e) {
      console.error('Failed to list audio devices:', e);
    }
  }, [selectedAudioDevice, setAvailableAudioDevices, setSelectedAudioDevice]);

  const startRecording = useCallback(async () => {
    try {
      if (!recorderRef.current) {
        recorderRef.current = new WavRecorder();
      }
      await recorderRef.current.start(selectedAudioDevice);
      setIsRecording(true);
      voiceStartTimeRef.current = Date.now();
    } catch (e) {
      console.error('Failed to start recording:', e);
    }
  }, [selectedAudioDevice, setIsRecording]);

  const stopRecording = useCallback(async (callback: (text: string) => void) => {
    if (!recorderRef.current) return;
    try {
      setIsRecording(false);
      const blob = await recorderRef.current.stop();
      
      const duration = Date.now() - voiceStartTimeRef.current;
      if (duration < 400) {
        console.log('[VOICE] Recording too short, ignoring');
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        setIsProcessingVoice(true);
        if (socket) {
          socket.emit('process_voice', { audioBuffer: arrayBuffer }, (res: { text: string | null }) => {
            setIsProcessingVoice(false);
            if (res.text) callback(res.text);
          });
        }
      };
      reader.readAsArrayBuffer(blob);
    } catch (e) {
      console.error('Failed to stop recording:', e);
      setIsProcessingVoice(false);
    }
  }, [socket, setIsRecording, setIsProcessingVoice]);

  return {
    isRecording,
    isProcessingVoice,
    availableAudioDevices,
    selectedAudioDevice,
    setSelectedAudioDevice,
    fetchAudioDevices,
    startRecording,
    stopRecording,
    recorderRef,
    isMouseDownOnMicRef
  };
}
