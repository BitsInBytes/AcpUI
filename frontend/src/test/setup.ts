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
