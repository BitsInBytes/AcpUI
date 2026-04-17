/**
 * Pure helper for canvas resize logic.
 * Extracted from App.tsx and PopOutApp.tsx for testability.
 */

export function computeResizeWidth(
  clientX: number,
  sidebarWidth: number
): number {
  const newWidth = clientX - sidebarWidth;
  const minWidth = 300;
  const maxWidth = window.innerWidth - sidebarWidth - 400;
  return Math.max(minWidth, Math.min(maxWidth, newWidth));
}

export function computeResizeWidthNoSidebar(clientX: number): number {
  return Math.max(300, Math.min(window.innerWidth - 400, clientX));
}
