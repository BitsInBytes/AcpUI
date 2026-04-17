import { useCallback, useEffect } from 'react';
import { useChatStore } from '../store/useChatStore';
import { BACKEND_URL } from '../utils/backendConfig';

export function useFileUpload(activeSessionId: string | null, activeSessionIdRef: React.MutableRefObject<string | null>) {
  const attachmentsMap = useChatStore(state => state.attachmentsMap);
  const setAttachments = useChatStore(state => state.setAttachments);

  const attachments = activeSessionId ? (attachmentsMap[activeSessionId] || []) : [];

  const handleFileUpload = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return;
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) {
      alert('Please select a chat session before uploading files.');
      return;
    }
    
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    const formData = new FormData();
    for (const file of fileArray) {
      formData.append('files', file);
    }

    try {
      const response = await fetch(`${BACKEND_URL}/upload/${currentSessionId}`, {
        method: 'POST',
        body: formData
      });
      const result = await response.json();
      if (result.success) {
        // Read base64 data for image preview in chat bubbles
        const filesWithData = await Promise.all(result.files.map(async (f: { mimeType?: string }, i: number) => {
          if (fileArray[i] && (f.mimeType || '').startsWith('image/')) {
            const data = await new Promise<string>(resolve => {
              const reader = new FileReader();
              reader.onload = (e) => resolve((e.target?.result as string).split(',')[1]);
              reader.readAsDataURL(fileArray[i]);
            });
            return { ...f, data };
          }
          return f;
        }));
        setAttachments(currentSessionId, prev => [...prev, ...filesWithData]);
      } else {
        alert(`Upload failed: ${result.error}`);
      }
    } catch (err: unknown) {
      alert(`Upload network error: ${(err as Error).message || 'Unknown error'}`);
    }
  }, [activeSessionIdRef, setAttachments]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    if (clipboardData.files && clipboardData.files.length > 0) {
      e.preventDefault();
      handleFileUpload(clipboardData.files);
      return;
    }

    const items = clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    
    if (files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      handleFileUpload(files);
    }
  }, [handleFileUpload]);

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  return {
    attachments,
    setAttachments,
    handleFileUpload,
    handlePaste
  };
}
