export function isOpaqueScriptError(message: unknown, error: unknown): boolean {
  return String(message) === 'Script error.' && !error;
}

function renderRuntimeError(root: HTMLElement, message: unknown, error: unknown) {
  const container = document.createElement('div');
  Object.assign(container.style, {
    padding: '20px',
    color: 'red',
    fontFamily: 'monospace',
  });

  const title = document.createElement('h1');
  title.textContent = 'Runtime Error';

  const messageNode = document.createElement('p');
  messageNode.textContent = String(message ?? 'Unknown error');

  const stack = document.createElement('pre');
  stack.textContent = error instanceof Error ? error.stack || '' : '';

  container.append(title, messageNode, stack);
  root.replaceChildren(container);
}

export function installGlobalErrorHandler(rootId = 'root') {
  window.onerror = (message, source, lineno, colno, error) => {
    if (isOpaqueScriptError(message, error)) {
      console.warn('Suppressed opaque script error', { source, lineno, colno });
      return true;
    }

    const root = document.getElementById(rootId);
    if (root) {
      renderRuntimeError(root, message, error);
    }
    return false;
  };
}
