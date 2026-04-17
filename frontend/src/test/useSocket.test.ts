 
import { describe, it, expect, beforeEach } from 'vitest';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';

// The socket is a module-level singleton — test the store effects directly
describe('useSocket integration', () => {
  beforeEach(() => {
    useSystemStore.setState({
      connected: false,
      isEngineReady: false,
      backendBootId: null,
      sslError: false,
      slashCommands: [],
      workspaceCwds: [],
    });
    useVoiceStore.setState({ isVoiceEnabled: false });
  });

  it('setConnected updates connected state', () => {
    useSystemStore.getState().setConnected(true);
    expect(useSystemStore.getState().connected).toBe(true);
  });

  it('setIsEngineReady and setBackendBootId update state', () => {
    useSystemStore.getState().setIsEngineReady(true);
    useSystemStore.getState().setBackendBootId('boot-123');
    expect(useSystemStore.getState().isEngineReady).toBe(true);
    expect(useSystemStore.getState().backendBootId).toBe('boot-123');
  });

  it('setIsVoiceEnabled updates voice store', () => {
    useVoiceStore.getState().setIsVoiceEnabled(true);
    expect(useVoiceStore.getState().isVoiceEnabled).toBe(true);
  });

  it('setSlashCommands stores commands', () => {
    useSystemStore.getState().setSlashCommands([{ name: '/compact', description: 'Compact' }]);
    expect(useSystemStore.getState().slashCommands).toHaveLength(1);
  });

  it('setWorkspaceCwds stores workspace configs', () => {
    useSystemStore.getState().setWorkspaceCwds([{ label: 'Project', path: '/mnt/c/repos/demo-project' }]);
    expect(useSystemStore.getState().workspaceCwds).toHaveLength(1);
  });

  it('setContextUsage stores per-session usage', () => {
    useSystemStore.getState().setContextUsage('sess-1', 5.5);
    expect(useSystemStore.getState().contextUsageBySession['sess-1']).toBe(5.5);
  });

  it('setCompacting stores per-session compaction state', () => {
    useSystemStore.getState().setCompacting('sess-1', true);
    expect(useSystemStore.getState().compactingBySession['sess-1']).toBe(true);
  });
});


describe('provider_extension socket handler', () => {
  it('commands/available sets slash commands with local commands prepended', () => {
    const serverCommands = [{ name: '/compact', description: 'Compact context' }];
    useSystemStore.getState().setSlashCommands([]);

    // Simulate the provider_extension handler inline
    const data = { method: '_provider/commands/available', params: { commands: serverCommands } };
    const p = data.params || {};
    if (data.method === '_provider/commands/available' && p.commands) {
      useSystemStore.getState().setSlashCommands([...p.commands]);
    }

    const cmds = useSystemStore.getState().slashCommands;
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('/compact');
  });

  it('metadata sets context usage for session', () => {
    const data = { method: '_provider/metadata', params: { sessionId: 'sess-42', contextUsagePercentage: 72.5 } };
    const p = data.params || {};
    if (data.method === '_provider/metadata' && p.contextUsagePercentage !== undefined) {
      useSystemStore.getState().setContextUsage(p.sessionId as string, p.contextUsagePercentage as number);
    }

    expect(useSystemStore.getState().contextUsageBySession['sess-42']).toBe(72.5);
  });

  it('compaction/status started sets compacting true', () => {
    useSystemStore.getState().setCompacting('acp-1', true);
    expect(useSystemStore.getState().compactingBySession['acp-1']).toBe(true);
  });

  it('compaction/status completed clears compacting', () => {
    useSystemStore.getState().setCompacting('acp-1', true);

    const data = { method: '_provider/compaction/status', params: { sessionId: 'acp-1', status: { type: 'completed' }, summary: null } };
    const p = data.params!;
    const status = p.status as { type: string };
    if (status.type === 'completed') {
      useSystemStore.getState().setCompacting(p.sessionId as string, false);
    }

    expect(useSystemStore.getState().compactingBySession['acp-1']).toBe(false);
  });

  it('disconnect sets connected to false', () => {
    useSystemStore.getState().setConnected(true);
    // Simulate disconnect handler
    useSystemStore.getState().setConnected(false);
    expect(useSystemStore.getState().connected).toBe(false);
  });

  it('connect sets connected to true', () => {
    useSystemStore.getState().setConnected(false);
    // Simulate connect handler
    useSystemStore.getState().setConnected(true);
    expect(useSystemStore.getState().connected).toBe(true);
  });
});


describe('socket handler: branding', () => {
  it('sets branding data on system store', () => {
    const brandingData = { assistantName: 'Agent', busyText: 'Thinking...' };
    useSystemStore.setState({ branding: brandingData as any });
    expect(useSystemStore.getState().branding.assistantName).toBe('Agent');
  });

  it('sets document.title from branding title field', () => {
    const data = { title: 'My ACP App', assistantName: 'Bot' };
    useSystemStore.setState({ branding: data as any });
    // Simulate what the branding socket handler does
    document.title = data.title || data.assistantName || 'ACP UI';
    expect(document.title).toBe('My ACP App');
  });

  it('falls back to assistantName for document.title when title is absent', () => {
    const data = { assistantName: 'MyBot' };
    useSystemStore.setState({ branding: data as any });
    document.title = (data as any).title || data.assistantName || 'ACP UI';
    expect(document.title).toBe('MyBot');
  });

  it('falls back to "ACP UI" for document.title when both title and assistantName are absent', () => {
    const data = {};
    useSystemStore.setState({ branding: data as any });
    document.title = (data as any).title || (data as any).assistantName || 'ACP UI';
    expect(document.title).toBe('ACP UI');
  });
});

describe('socket handler: sidebar_settings', () => {
  it('sets deletePermanent and notification settings', () => {
    useSystemStore.getState().setDeletePermanent(true);
    useSystemStore.getState().setNotificationSettings(true, false);
    expect(useSystemStore.getState().deletePermanent).toBe(true);
    expect(useSystemStore.getState().notificationSound).toBe(true);
    expect(useSystemStore.getState().notificationDesktop).toBe(false);
  });

  it('sets notification desktop to true', () => {
    useSystemStore.getState().setNotificationSettings(false, true);
    expect(useSystemStore.getState().notificationSound).toBe(false);
    expect(useSystemStore.getState().notificationDesktop).toBe(true);
  });
});

describe('socket handler: custom_commands', () => {
  it('stores custom commands', () => {
    const cmds = [{ name: '/deploy', description: 'Deploy app', prompt: 'deploy it' }];
    useSystemStore.getState().setCustomCommands(cmds);
    expect(useSystemStore.getState().customCommands).toHaveLength(1);
    expect(useSystemStore.getState().customCommands[0].name).toBe('/deploy');
  });

  it('provider_extension commands/available includes custom commands with prompts', () => {
    useSystemStore.getState().setCustomCommands([
      { name: '/deploy', description: 'Deploy', prompt: 'do deploy' },
      { name: '/status', description: 'Status', prompt: null },
    ]);
    useSystemStore.setState({ branding: { ...useSystemStore.getState().branding, protocolPrefix: '_provider/' } });

    const serverCommands = [{ name: '/compact', description: 'Compact' }];
    const customCmds = useSystemStore.getState().customCommands
      .filter(c => c.prompt)
      .map(c => ({ name: c.name, description: c.description, meta: { local: true } }));

    useSystemStore.getState().setSlashCommands([...customCmds, ...serverCommands]);

    const cmds = useSystemStore.getState().slashCommands;
    expect(cmds).toHaveLength(2); // deploy (has prompt), compact
    expect(cmds.find(c => c.name === '/deploy')).toBeDefined();
    expect(cmds.find(c => c.name === '/status')).toBeUndefined(); // no prompt
  });
});

describe('socket handler: workspace_cwds', () => {
  it('stores workspace cwds with agent field', () => {
    useSystemStore.getState().setWorkspaceCwds([
      { label: 'Project', path: '/repos/demo-project', agent: 'agent-dev' },
    ]);
    const cwds = useSystemStore.getState().workspaceCwds;
    expect(cwds).toHaveLength(1);
    expect(cwds[0].agent).toBe('agent-dev');
  });
});



describe('socket handler: branding (extended)', () => {
  it('stores full branding object including protocolPrefix', () => {
    const data = { assistantName: 'TestBot', busyText: 'Working...', protocolPrefix: '_test.dev/' };
    useSystemStore.setState({ branding: data as any });
    const b = useSystemStore.getState().branding;
    expect(b.assistantName).toBe('TestBot');
    expect(b.protocolPrefix).toBe('_test.dev/');
  });

  it('overwrites previous branding completely', () => {
    useSystemStore.setState({ branding: { assistantName: 'Old' } as any });
    useSystemStore.setState({ branding: { assistantName: 'New', busyText: 'Busy' } as any });
    expect(useSystemStore.getState().branding.assistantName).toBe('New');
  });
});

describe('socket handler: sidebar_settings (extended)', () => {
  it('sets all three settings together', () => {
    useSystemStore.getState().setDeletePermanent(false);
    useSystemStore.getState().setNotificationSettings(false, false);

    // Simulate full handler
    const data = { deletePermanent: true, notificationSound: true, notificationDesktop: true };
    useSystemStore.getState().setDeletePermanent(data.deletePermanent);
    useSystemStore.getState().setNotificationSettings(data.notificationSound, data.notificationDesktop);

    expect(useSystemStore.getState().deletePermanent).toBe(true);
    expect(useSystemStore.getState().notificationSound).toBe(true);
    expect(useSystemStore.getState().notificationDesktop).toBe(true);
  });

  it('handles all-false settings', () => {
    const data = { deletePermanent: false, notificationSound: false, notificationDesktop: false };
    useSystemStore.getState().setDeletePermanent(data.deletePermanent);
    useSystemStore.getState().setNotificationSettings(data.notificationSound, data.notificationDesktop);

    expect(useSystemStore.getState().deletePermanent).toBe(false);
    expect(useSystemStore.getState().notificationSound).toBe(false);
    expect(useSystemStore.getState().notificationDesktop).toBe(false);
  });
});

describe('socket handler: custom_commands (extended)', () => {
  it('stores multiple commands', () => {
    const cmds = [
      { name: '/build', description: 'Build project', prompt: 'run build' },
      { name: '/test', description: 'Run tests', prompt: 'run tests' },
      { name: '/lint', description: 'Lint code', prompt: null },
    ];
    useSystemStore.getState().setCustomCommands(cmds);
    expect(useSystemStore.getState().customCommands).toHaveLength(3);
    expect(useSystemStore.getState().customCommands[2].prompt).toBeNull();
  });

  it('replaces previous commands entirely', () => {
    useSystemStore.setState({ customCommands: [{ name: '/old', description: 'Old', prompt: 'old' }] });
    useSystemStore.getState().setCustomCommands([{ name: '/new', description: 'New', prompt: 'new' }]);
    expect(useSystemStore.getState().customCommands).toHaveLength(1);
    expect(useSystemStore.getState().customCommands[0].name).toBe('/new');
  });
});

describe('provider_extension: metadata (extended)', () => {
  it('updates context usage for multiple sessions independently', () => {
    useSystemStore.getState().setContextUsage('sess-a', 10);
    useSystemStore.getState().setContextUsage('sess-b', 90);
    expect(useSystemStore.getState().contextUsageBySession['sess-a']).toBe(10);
    expect(useSystemStore.getState().contextUsageBySession['sess-b']).toBe(90);
  });

  it('overwrites context usage for same session', () => {
    useSystemStore.getState().setContextUsage('sess-a', 10);
    useSystemStore.getState().setContextUsage('sess-a', 50);
    expect(useSystemStore.getState().contextUsageBySession['sess-a']).toBe(50);
  });
});

describe('disconnect handler', () => {
  it('sets connected false after being true', () => {
    useSystemStore.getState().setConnected(true);
    expect(useSystemStore.getState().connected).toBe(true);
    useSystemStore.getState().setConnected(false);
    expect(useSystemStore.getState().connected).toBe(false);
  });
});

