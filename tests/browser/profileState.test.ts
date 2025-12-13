import { describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  cleanupStaleProfileState,
  readDevToolsPort,
  writeChromePid,
  writeDevToolsActivePort,
} from '../../src/browser/profileState.js';

describe('profileState', () => {
  test('writes DevToolsActivePort to both root and Default', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-profile-'));
    try {
      await writeDevToolsActivePort(dir, 12345);
      const root = path.join(dir, 'DevToolsActivePort');
      const nested = path.join(dir, 'Default', 'DevToolsActivePort');
      expect(existsSync(root)).toBe(true);
      expect(existsSync(nested)).toBe(true);
      expect((await readFile(root, 'utf8')).split('\n')[0]?.trim()).toBe('12345');
      expect((await readFile(nested, 'utf8')).split('\n')[0]?.trim()).toBe('12345');
      await expect(readDevToolsPort(dir)).resolves.toBe(12345);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('cleans DevToolsActivePort, but only removes locks when oracle pid is dead', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-profile-'));
    const lockFiles = [
      path.join(dir, 'lockfile'),
      path.join(dir, 'SingletonLock'),
      path.join(dir, 'SingletonSocket'),
      path.join(dir, 'SingletonCookie'),
    ];
    try {
      await writeDevToolsActivePort(dir, 12345);
      for (const lock of lockFiles) {
        await writeFile(lock, 'x');
      }

      // Alive pid => keep locks
      await writeChromePid(dir, process.pid);
      await cleanupStaleProfileState(dir, undefined, { lockRemovalMode: 'if_oracle_pid_dead' });
      expect(existsSync(path.join(dir, 'DevToolsActivePort'))).toBe(false);
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(true);
      }

      // Dead pid => remove locks
      for (const lock of lockFiles) {
        await writeFile(lock, 'x');
      }
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      await once(child, 'exit');
      await writeChromePid(dir, child.pid ?? 0);
      await cleanupStaleProfileState(dir, undefined, { lockRemovalMode: 'if_oracle_pid_dead' });
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

