import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock window.scrollTo
window.scrollTo = vi.fn();

// Mock Element.prototype.scrollTo (since JSDOM doesn't implement it)
Element.prototype.scrollTo = vi.fn();

// Mock window.location
const mockLocation = new URL('http://localhost');
Object.defineProperty(window, 'location', {
  value: {
    ...window.location,
    hostname: 'localhost',
    href: mockLocation.href,
    search: mockLocation.search,
    protocol: mockLocation.protocol,
    assign: vi.fn(),
    replace: vi.fn(),
  },
  writable: true
});

// Mock history.replaceState
window.history.replaceState = vi.fn();

// Mock window.confirm
window.confirm = vi.fn().mockReturnValue(true);

// Mock window.alert
window.alert = vi.fn();

// Mock window.open
window.open = vi.fn();

// Mock canvas context for JSDOM
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockImplementation(() => ({
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: [] })),
    putImageData: vi.fn(),
    createImageData: vi.fn(() => []),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    transform: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
  }));
}
