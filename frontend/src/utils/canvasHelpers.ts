/**
 * Pure helper functions for CanvasPane logic.
 * Extracted for testability — no React, no stores, no side effects.
 */

export function isFileChanged(
  filePath: string | undefined,
  gitFiles: { path: string; status: string; staged: boolean }[]
): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return gitFiles.some(f => normalized.endsWith(f.path.replace(/\\/g, '/')));
}

export function buildFullPath(cwd: string, relativePath: string): string {
  return cwd.replace(/\\/g, '/') + '/' + relativePath.replace(/\\/g, '/');
}
