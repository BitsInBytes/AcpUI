export class ToolRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(canonicalName, handler) {
    if (!canonicalName || !handler) return;
    this.handlers.set(canonicalName, handler);
  }

  get(canonicalName) {
    return this.handlers.get(canonicalName) || null;
  }

  dispatch(phase, ctx, invocation, event) {
    const canonicalName = invocation?.identity?.canonicalName;
    const handler = this.get(canonicalName);
    const method = phase === 'start'
      ? 'onStart'
      : phase === 'end'
        ? 'onEnd'
        : 'onUpdate';

    if (!handler || typeof handler[method] !== 'function') return event;
    return handler[method](ctx, invocation, event) || event;
  }
}

export const toolRegistry = new ToolRegistry();
