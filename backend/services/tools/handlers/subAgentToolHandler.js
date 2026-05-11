export const subAgentToolHandler = {
  onStart(ctx, invocation, event) {
    ctx.acpClient.lastSubAgentParentAcpId = ctx.sessionId;
    return {
      ...event,
      title: event.title || 'Invoke Subagents',
      canonicalName: invocation.identity?.canonicalName
    };
  }
};
