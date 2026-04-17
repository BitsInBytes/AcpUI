import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { writeLog } from '../services/logger.js';

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trimEnd();
}

export default function registerGitHandlers(io, socket) {
  socket.on('git_status', ({ cwd }, callback) => {
    try {
      const branch = git(cwd, 'branch --show-current');
      const raw = git(cwd, 'status --porcelain');
      const files = raw ? raw.split('\n').map(line => {
        const staged = line[0];
        const unstaged = line[1];
        const filePath = line.substring(3).trim();
        // Determine display status
        let status = 'modified';
        if (staged === '?' || unstaged === '?') status = 'untracked';
        else if (staged === 'A') status = 'added';
        else if (staged === 'D' || unstaged === 'D') status = 'deleted';
        else if (staged === 'R') status = 'renamed';
        const isStaged = staged !== ' ' && staged !== '?';
        return { path: filePath, status, staged: isStaged };
      }) : [];
      callback?.({ branch, files });
    } catch (err) {
      writeLog(`[GIT ERR] status: ${err.message}`);
      callback?.({ branch: '', files: [], error: err.message });
    }
  });

  socket.on('git_diff', ({ cwd, filePath, staged }, callback) => {
    try {
      let diff;
      if (staged) {
        diff = git(cwd, `diff --cached -- "${filePath}"`);
      } else {
        // Check if untracked
        const status = git(cwd, `status --porcelain -- "${filePath}"`);
        if (status.startsWith('??')) {
          // Untracked — show full file as new
          const fullPath = path.resolve(cwd, filePath);
          const content = fs.readFileSync(fullPath, 'utf8');
          diff = content.split('\n').map(l => `+${l}`).join('\n');
          diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n${diff}`;
        } else {
          diff = git(cwd, `diff -- "${filePath}"`);
        }
      }
      callback?.({ diff: diff || '(no changes)' });
    } catch (err) {
      writeLog(`[GIT ERR] diff: ${err.message}`);
      callback?.({ diff: '', error: err.message });
    }
  });

  socket.on('git_stage', ({ cwd, filePath }, callback) => {
    try {
      git(cwd, `add -- "${filePath}"`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[GIT ERR] stage: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('git_unstage', ({ cwd, filePath }, callback) => {
    try {
      git(cwd, `reset HEAD -- "${filePath}"`);
      callback?.({ success: true });
    } catch (err) {
      writeLog(`[GIT ERR] unstage: ${err.message}`);
      callback?.({ error: err.message });
    }
  });

  socket.on('git_show_head', ({ cwd, filePath }, callback) => {
    try {
      const relPath = path.relative(cwd, path.resolve(cwd, filePath)).replace(/\\/g, '/');
      const content = git(cwd, `show HEAD:"${relPath}"`);
      callback?.({ content });
    } catch {
      // File doesn't exist in HEAD (new file)
      callback?.({ content: '' });
    }
  });
}
