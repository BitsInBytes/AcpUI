import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalErrorHandler, isOpaqueScriptError } from '../utils/globalErrorHandler';

describe('globalErrorHandler', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'test-root';
    document.body.appendChild(root);
  });

  afterEach(() => {
    window.onerror = null;
    root.remove();
    vi.restoreAllMocks();
  });

  it('identifies opaque script errors without an error object', () => {
    expect(isOpaqueScriptError('Script error.', undefined)).toBe(true);
    expect(isOpaqueScriptError('Script error.', new Error('details'))).toBe(false);
    expect(isOpaqueScriptError('TypeError: boom', undefined)).toBe(false);
  });

  it('suppresses opaque script errors without replacing the app root', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installGlobalErrorHandler('test-root');

    const handled = window.onerror?.('Script error.', 'https://cdn.example/app.js', 0, 0, undefined);

    expect(handled).toBe(true);
    expect(root).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledWith('Suppressed opaque script error', {
      source: 'https://cdn.example/app.js',
      lineno: 0,
      colno: 0,
    });
  });

  it('renders actionable runtime errors for non-opaque failures', () => {
    installGlobalErrorHandler('test-root');
    const error = new Error('boom');

    const handled = window.onerror?.('TypeError: boom', 'app.js', 10, 5, error);

    expect(handled).toBe(false);
    expect(root).toHaveTextContent('Runtime Error');
    expect(root).toHaveTextContent('TypeError: boom');
    expect(root).toHaveTextContent('Error: boom');
  });
});
