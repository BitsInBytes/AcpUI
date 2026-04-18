import { describe, it, expect, beforeEach } from 'vitest';
import { useInputStore } from '../store/useInputStore';
import { act } from 'react-dom/test-utils';

describe('useInputStore', () => {
  beforeEach(() => {
    act(() => {
      useInputStore.setState({ 
        inputs: {},
        attachmentsMap: {}
      });
    });
  });

  it('setInput stores per-session input text', () => {
    act(() => {
      useInputStore.getState().setInput('s1', 'hello');
      useInputStore.getState().setInput('s2', 'world');
    });
    const state = useInputStore.getState();
    expect(state.inputs['s1']).toBe('hello');
    expect(state.inputs['s2']).toBe('world');
  });

  it('setAttachments handles direct values', () => {
    const attachments = [{ name: 'f1', size: 10, mimeType: 'text/plain', data: '' }];
    act(() => {
      useInputStore.getState().setAttachments('s1', attachments);
    });
    expect(useInputStore.getState().attachmentsMap['s1']).toEqual(attachments);
  });

  it('setAttachments handles functional updaters', () => {
    const initial = [{ name: 'f1', size: 10, mimeType: 'text/plain', data: '' }];
    const added = { name: 'f2', size: 20, mimeType: 'text/plain', data: '' };
    act(() => {
      useInputStore.getState().setAttachments('s1', initial);
      useInputStore.getState().setAttachments('s1', (prev) => [...prev, added]);
    });
    expect(useInputStore.getState().attachmentsMap['s1']).toHaveLength(2);
    expect(useInputStore.getState().attachmentsMap['s1'][1]).toEqual(added);
  });

  it('addAttachment and removeAttachment update state', () => {
    const uiId = 's1';
    const attachment: any = { name: 'f1', size: 10 };
    act(() => {
      useInputStore.getState().addAttachment(uiId, attachment);
    });
    expect(useInputStore.getState().attachmentsMap[uiId]).toContain(attachment);
    
    act(() => {
      useInputStore.getState().removeAttachment(uiId, 0);
    });
    expect(useInputStore.getState().attachmentsMap[uiId]).toHaveLength(0);
  });

  it('clearInput resets input and attachments', () => {
    const uiId = 's1';
    act(() => {
      useInputStore.getState().setInput(uiId, 'some text');
      useInputStore.getState().addAttachment(uiId, { name: 'a' } as any);
      useInputStore.getState().clearInput(uiId);
    });
    expect(useInputStore.getState().inputs[uiId]).toBe('');
    expect(useInputStore.getState().attachmentsMap[uiId]).toHaveLength(0);
  });

  it('handleFileUpload reads files and adds to attachmentsMap', async () => {
    const mockFileData = 'data:text/plain;base64,SGVsbG8=';
    const OriginalFileReader = globalThis.FileReader;
    globalThis.FileReader = class MockFileReader {
      onload: any = null;
      readAsDataURL() {
        setTimeout(() => this.onload?.({ target: { result: mockFileData } }), 0);
      }
    } as any;

    const file = new File(['Hello'], 'test.txt', { type: 'text/plain' });
    await useInputStore.getState().handleFileUpload([file], 's1');

    const attachments = useInputStore.getState().attachmentsMap['s1'];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('test.txt');
    expect(attachments[0].data).toBe('SGVsbG8=');

    globalThis.FileReader = OriginalFileReader;
  });

  it('handleFileUpload ignores empty files or missing sessionId', async () => {
    const initial = useInputStore.getState().attachmentsMap;
    await useInputStore.getState().handleFileUpload([], 's1');
    expect(useInputStore.getState().attachmentsMap).toEqual(initial);

    await useInputStore.getState().handleFileUpload([new File([], 'a.txt')], null);
    expect(useInputStore.getState().attachmentsMap).toEqual(initial);
  });
});
