export function isOpaqueScriptError(message: unknown, error: unknown): boolean {
  return String(message) === 'Script error.' && !error;
}

const PRODUCTION_RUNTIME_ERROR_MESSAGE =
  'Something went wrong. Please refresh the page. If the issue persists, contact your administrator.';

type GlobalErrorHandlerOptions = {
  showDetails?: boolean;
};

function renderRuntimeError(root: HTMLElement, message: unknown, error: unknown, showDetails: boolean) {
  const container = document.createElement('div');
  Object.assign(container.style, {
    padding: '20px',
    color: 'red',
    fontFamily: 'monospace',
  });

  const title = document.createElement('h1');
  title.textContent = 'Runtime Error';

  const messageNode = document.createElement('p');
  messageNode.textContent = showDetails
    ? String(message ?? 'Unknown error')
    : PRODUCTION_RUNTIME_ERROR_MESSAGE;

  container.append(title, messageNode);

  if (showDetails) {
    const stack = document.createElement('pre');
    stack.textContent = error instanceof Error ? error.stack || '' : '';
    container.append(stack);
  }

  root.replaceChildren(container);
}

export function installGlobalErrorHandler(
  rootId = 'root',
  options: GlobalErrorHandlerOptions = {},
) {
  const showDetails = options.showDetails ?? import.meta.env.DEV;

  window.onerror = (message, source, lineno, colno, error) => {
    if (isOpaqueScriptError(message, error)) {
      console.warn('Suppressed opaque script error', { source, lineno, colno });
      return true;
    }

    console.error('Unhandled runtime error', { message, source, lineno, colno, error });

    const root = document.getElementById(rootId);
    if (root) {
      renderRuntimeError(root, message, error, showDetails);
    }
    return false;
  };
}
