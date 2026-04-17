import { describe, it, expect } from 'vitest';
import * as Diff from 'diff';

describe('Backend Diff Engine', () => {
  it('should generate a correct unified patch between two strings', () => {
    const oldText = 'line1\nline2\nline3';
    const newText = 'line1\nlineChanged\nline3';
    const toolCallId = 'replace-test-123';

    const patch = Diff.createPatch(toolCallId, oldText, newText, 'old', 'new');
    
    expect(patch).toContain(`--- ${toolCallId}\told`);
    expect(patch).toContain(`+++ ${toolCallId}\tnew`);
    expect(patch).toContain('-line2');
    expect(patch).toContain('+lineChanged');
    expect(patch).toContain('line1');
    expect(patch).toContain('line3');
  });

  it('should handle empty old text (new file creation)', () => {
    const oldText = '';
    const newText = 'new file content';
    const patch = Diff.createPatch('create-file', oldText, newText, 'old', 'new');
    
    expect(patch).toContain('+new file content');
  });

  it('should handle empty new text (file deletion)', () => {
    const oldText = 'old content';
    const newText = '';
    const patch = Diff.createPatch('delete-file', oldText, newText, 'old', 'new');
    
    expect(patch).toContain('-old content');
  });
});
