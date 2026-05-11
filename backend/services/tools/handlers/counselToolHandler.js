export const counselToolHandler = {
  onStart(ctx, invocation, event) {
    ctx.acpClient.lastSubAgentParentAcpId = ctx.sessionId;
    return {
      ...event,
      title: event.title || 'Invoke Counsel',
      canonicalName: invocation.identity?.canonicalName
    };
  }
};
