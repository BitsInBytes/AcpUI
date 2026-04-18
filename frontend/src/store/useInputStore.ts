import { create } from 'zustand';
import type { Attachment } from '../types';

interface InputState {
  inputs: Record<string, string>; // uiId -> current input text
  attachmentsMap: Record<string, Attachment[]>; // uiId -> attachments

  // Actions
  setInput: (uiId: string, text: string) => void;
  setAttachments: (uiId: string, attachments: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void;
  addAttachment: (uiId: string, attachment: Attachment) => void;
  removeAttachment: (uiId: string, index: number) => void;
  handleFileUpload: (files: FileList | File[] | null, activeSessionId: string | null) => Promise<void>;
  clearInput: (uiId: string) => void;
}

export const useInputStore = create<InputState>((set) => ({
  inputs: {},
  attachmentsMap: {},

  setInput: (uiId, text) => set(state => ({
    inputs: { ...state.inputs, [uiId]: text }
  })),

  setAttachments: (uiId, attachments) => set(state => {
    const current = state.attachmentsMap[uiId] || [];
    const newVal = typeof attachments === 'function' ? attachments(current) : attachments;
    return {
      attachmentsMap: { ...state.attachmentsMap, [uiId]: newVal }
    };
  }),

  addAttachment: (uiId, attachment) => set(state => {
    const current = state.attachmentsMap[uiId] || [];
    return {
      attachmentsMap: { ...state.attachmentsMap, [uiId]: [...current, attachment] }
    };
  }),

  removeAttachment: (uiId, index) => set(state => {
    const current = state.attachmentsMap[uiId] || [];
    return {
      attachmentsMap: { ...state.attachmentsMap, [uiId]: current.filter((_, i) => i !== index) }
    };
  }),

  clearInput: (uiId) => set(state => ({
    inputs: { ...state.inputs, [uiId]: '' },
    attachmentsMap: { ...state.attachmentsMap, [uiId]: [] }
  })),

  handleFileUpload: async (files, activeSessionId) => {
    if (!files || files.length === 0 || !activeSessionId) return;

    const newAttachments: Attachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();

      const fileData = await new Promise<string>((resolve) => {
        reader.onload = (e) => {
          const result = e.target?.result as string;
          resolve(result.split(',')[1]); // Base64 part
        };
        reader.readAsDataURL(file);
      });

      newAttachments.push({
        name: file.name,
        size: file.size,
        mimeType: file.type,
        data: fileData
      });
    }

    set(state => {
      const current = state.attachmentsMap[activeSessionId] || [];
      return {
        attachmentsMap: { ...state.attachmentsMap, [activeSessionId]: [...current, ...newAttachments] }
      };
    });
  }
}));
