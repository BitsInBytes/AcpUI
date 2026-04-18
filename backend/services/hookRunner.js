import { exec } from 'child_process';
import { writeLog } from './logger.js';
import { getProvider, getProviderModule } from './providerLoader.js';

export async function runHooks(agentName, hookType, context = {}, options = {}) {
  const providerId = options.providerId || null;
  const { config } = getProvider(providerId);
  const cliManagedHooks = config.cliManagedHooks ?? [];

  if (cliManagedHooks.includes(hookType)) {
    writeLog(`[HOOKS] Skipping ${hookType} — auto-run by CLI`);
    return [];
  }

  const providerModule = await getProviderModule(providerId);
  const entries = await providerModule.getHooksForAgent(agentName, hookType);

  if (!entries.length) return [];

  const { matcher: toolName, io, sessionId } = options;

  const toRun = entries.filter(entry => {
    if (!entry.matcher) return true;
    if (!toolName) return false;
    const m = entry.matcher.toLowerCase();
    const t = toolName.toLowerCase();
    if (m === 'fs_write' || m === 'write') return t.startsWith('editing') || t.startsWith('creating');
    if (m === 'fs_read' || m === 'read') return t.startsWith('reading');
    if (m === 'shell' || m === 'execute_bash' || m === 'bash') return t.startsWith('running');
    return t.includes(m) || m.includes(t);
  });

  if (!toRun.length) return [];

  writeLog(`[HOOKS] Running ${toRun.length} ${hookType} hook(s) for agent "${agentName}"`);

  if (hookType === 'stop' && io && sessionId) {
    io.to('session:' + sessionId).emit('hooks_status', { sessionId, running: true });
    await new Promise(r => setTimeout(r, 50));
  }

  const results = [];
  for (const entry of toRun) {
    try {
      const output = await runScript(entry.command, context, hookType);
      if (output.trim()) results.push(output.trim());
    } catch (err) {
      writeLog(`[HOOKS] Script failed: ${entry.command} — ${err.message}`);
    }
  }

  if (hookType === 'stop' && io && sessionId) io.to('session:' + sessionId).emit('hooks_status', { sessionId, running: false });
  return results;
}

function runScript(command, stdinData, hookType) {
  const timeout = hookType === 'stop' ? 300000 : 30000;
  return new Promise((resolve, reject) => {
    const child = exec(command, {
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env }
    }, (err, stdout, stderr) => {
      if (err) {
        writeLog(`[HOOKS] Script error: ${err.message}`);
        if (err.killed) return reject(new Error('Script timed out'));
      }
      if (stderr) writeLog(`[HOOKS] stderr: ${stderr.substring(0, 500)}`);
      resolve(stdout || '');
    });
    if (stdinData && Object.keys(stdinData).length) {
      child.stdin.write(JSON.stringify(stdinData));
    }
    child.stdin.end();
  });
}
