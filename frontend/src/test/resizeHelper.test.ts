import { describe, it, expect } from 'vitest';
import { computeResizeWidth, computeResizeWidthNoSidebar } from '../utils/resizeHelper';

// Mock window.innerWidth
Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });

describe('resizeHelper', () => {
  describe('computeResizeWidth', () => {
    it('calculates width from clientX minus sidebar', () => {
      const result = computeResizeWidth(800, 280);
      expect(result).toBe(520);
    });

    it('clamps to minimum width of 300', () => {
      const result = computeResizeWidth(400, 280);
      expect(result).toBe(300);
    });

    it('clamps to maximum width (innerWidth - sidebar - 400)', () => {
      // max = 1920 - 280 - 400 = 1240
      const result = computeResizeWidth(1800, 280);
      expect(result).toBe(1240);
    });

    it('works with no sidebar (sidebarWidth = 0)', () => {
      const result = computeResizeWidth(600, 0);
      expect(result).toBe(600);
    });
  });

  describe('computeResizeWidthNoSidebar', () => {
    it('calculates width from clientX directly', () => {
      const result = computeResizeWidthNoSidebar(700);
      expect(result).toBe(700);
    });

    it('clamps to minimum 300', () => {
      const result = computeResizeWidthNoSidebar(100);
      expect(result).toBe(300);
    });

    it('clamps to maximum (innerWidth - 400)', () => {
      // max = 1920 - 400 = 1520
      const result = computeResizeWidthNoSidebar(1800);
      expect(result).toBe(1520);
    });
  });
});
