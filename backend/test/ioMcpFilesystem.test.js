import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  findFiles,
  grepSearch,
  listDirectory,
  readFile,
  replaceText,
  writeFile
} from '../services/ioMcp/filesystem.js';
import { resetMcpConfigForTests } from '../services/mcpConfig.js';

describe('IO MCP filesystem helpers', () => {
  const testDir = path.resolve(process.cwd(), 'test-temp-io-mcp');

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpConfigForTests();
  });

  function useMcpConfig(config) {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'acpui-mcp-config-'));
    const configPath = path.join(dir, 'mcp.json');
    fsSync.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    vi.stubEnv('MCP_CONFIG', configPath);
    resetMcpConfigForTests();
    return configPath;
  }

  async function createTestFile(filename, content) {
    const filePath = path.join(testDir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  describe('basic file tools', () => {
    it('reads selected line ranges', async () => {
      const filePath = await createTestFile('read.txt', 'a\nb\nc\n');

      await expect(readFile(filePath, 2, 3)).resolves.toBe('b\nc');
    });

    it('writes parent directories recursively', async () => {
      const filePath = path.join(testDir, 'nested', 'write.txt');

      await writeFile(filePath, 'written');

      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('written');
    });

    it('lists direct children with slash suffixes for directories', async () => {
      await createTestFile('list-root.txt', 'root');
      await fs.mkdir(path.join(testDir, 'child-dir'), { recursive: true });

      const entries = await listDirectory(testDir);

      expect(entries).toContain('list-root.txt');
      expect(entries).toContain('child-dir/');
    });

    it('finds files with glob patterns', async () => {
      const filePath = await createTestFile('glob/example.match', 'match');

      const files = await findFiles('**/*.match', testDir);

      expect(files).toContain(filePath);
    });

    it('searches file contents with ripgrep', async () => {
      await createTestFile('grep.txt', 'needle\nother\n');

      const output = await grepSearch('needle', testDir, { fixedStrings: true });

      expect(output).toEqual(expect.objectContaining({
        type: 'ux_grep_search_result',
        pattern: 'needle',
        dirPath: testDir,
        matchCount: expect.any(Number),
        matches: expect.arrayContaining([
          expect.objectContaining({
            filePath: expect.stringContaining('grep.txt'),
            lineNumber: 1,
            line: 'needle'
          })
        ])
      }));
    });

    it('blocks file access outside configured allowed roots', async () => {
      useMcpConfig({
        tools: { io: true },
        io: {
          autoAllowWorkspaceCwd: false,
          allowedRoots: [testDir],
          maxReadBytes: 1024,
          maxWriteBytes: 1024,
          maxReplaceBytes: 1024,
          maxOutputBytes: 1024
        }
      });
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'outside.txt');
        await fs.writeFile(outsideFile, 'blocked', 'utf8');

        await expect(readFile(outsideFile)).rejects.toThrow(/allowed roots/);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('supports wildcard allowed roots', async () => {
      useMcpConfig({
        tools: { io: true },
        io: {
          autoAllowWorkspaceCwd: false,
          allowedRoots: ['*'],
          maxReadBytes: 1024,
          maxWriteBytes: 1024,
          maxReplaceBytes: 1024,
          maxOutputBytes: 1024
        }
      });
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acpui-io-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'outside.txt');
        await fs.writeFile(outsideFile, 'allowed', 'utf8');

        await expect(readFile(outsideFile)).resolves.toBe('allowed');
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('enforces read and write size caps', async () => {
      useMcpConfig({
        tools: { io: true },
        io: {
          autoAllowWorkspaceCwd: true,
          allowedRoots: [],
          maxReadBytes: 4,
          maxWriteBytes: 4,
          maxReplaceBytes: 1024,
          maxOutputBytes: 1024
        }
      });
      const filePath = await createTestFile('too-large.txt', '12345');

      await expect(readFile(filePath)).rejects.toThrow(/size cap/);
      await expect(writeFile(path.join(testDir, 'too-large-write.txt'), '12345')).rejects.toThrow(/size cap/);
    });
  });

  describe('replaceText with fuzzy matching', () => {
    it('replaces exact matches', async () => {
      const filePath = await createTestFile('exact.ts', 'const a = 1;\nconst b = 2;\n');

      const output = await replaceText(filePath, 'const b = 2;', 'const b = 3;');

      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('const a = 1;\nconst b = 3;\n');
      expect(output).toContain('Index:');
      expect(output).toContain('--- ');
      expect(output).toContain('+++ ');
      expect(output).toContain('-const b = 2;');
      expect(output).toContain('+const b = 3;');
    });

    it('normalizes line endings and restores CRLF output', async () => {
      const filePath = await createTestFile('newlines.ts', 'function test() {\r\n    return true;\r\n}\r\n');

      await replaceText(
        filePath,
        'function test() {\n    return true;\n}',
        'function test() {\n    return false;\n}'
      );

      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('function test() {\r\n    return false;\r\n}\r\n');
    });

    it('handles spurious leading blank lines from AI edit blocks', async () => {
      const filePath = await createTestFile('blankline.ts', 'let x = 10;\nlet y = 20;\nlet z = 30;\n');

      await replaceText(filePath, '\nlet  y = 20;\nlet z = 30;', 'let y = 100;\nlet z = 200;');

      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('let x = 10;\nlet y = 100;\nlet z = 200;\n');
    });

    it('repairs missing leading whitespace in edit blocks', async () => {
      const fileContent = `class User {
    constructor() {
        this.name = "Test";
        this.age = 30;
    }
}`;
      const filePath = await createTestFile('indent.ts', fileContent);

      await replaceText(
        filePath,
        'this.name = "Test";\nthis.age = 30;',
        'this.name = "Updated";\nthis.age = 40;'
      );

      const expectedContent = `class User {
    constructor() {
        this.name = "Updated";
        this.age = 40;
    }
}`;
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(expectedContent);
    });

    it('falls back to fuzzy sequence matching for close edit blocks', async () => {
      const fileContent = `function calculateTotal(items) {
    let total = 0;
    for (const item of items) {
        total += item.price * item.qty;
    }
    return total;
}`;
      const filePath = await createTestFile('fuzzy.ts', fileContent);

      await replaceText(
        filePath,
        `    for (const item of items) {
        total += item.cost * item.qty;
    }
    return total;`,
        `    const total = items.reduce((acc, item) => acc + (item.price * item.qty), 0);
    return total;`
      );

      const expectedContent = `function calculateTotal(items) {
    let total = 0;
    const total = items.reduce((acc, item) => acc + (item.price * item.qty), 0);
    return total;
}`;
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(expectedContent);
    });

    it('rejects multiple exact matches unless allowMultiple is true', async () => {
      const filePath = await createTestFile('multiple.ts', 'console.log("hello");\nconsole.log("hello");\n');

      await expect(replaceText(filePath, 'console.log("hello");', 'console.log("world");'))
        .rejects.toThrow(/Found multiple occurrences/);
    });
  });
});
