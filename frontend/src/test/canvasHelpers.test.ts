import { describe, it, expect } from 'vitest';
import { isFileChanged, buildFullPath } from '../utils/canvasHelpers';

const gitFiles = [
  { path: 'src/app.ts', status: 'modified', staged: false },
  { path: 'lib/utils.ts', status: 'added', staged: true },
];

describe('isFileChanged', () => {
  it('returns true when file path matches', () => {
    expect(isFileChanged('/repo/src/app.ts', gitFiles)).toBe(true);
  });

  it('returns false when no match', () => {
    expect(isFileChanged('/repo/other.ts', gitFiles)).toBe(false);
  });

  it('returns false for undefined filePath', () => {
    expect(isFileChanged(undefined, gitFiles)).toBe(false);
  });

  it('handles backslash/forward slash normalization', () => {
    expect(isFileChanged('C:\\repo\\src\\app.ts', gitFiles)).toBe(true);
  });
});

describe('buildFullPath', () => {
  it('joins and normalizes paths', () => {
    expect(buildFullPath('C:\\repos\\project', 'src\\app.ts')).toBe('C:/repos/project/src/app.ts');
  });
});
