import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJob, transitionJob, writeJsonAtomic } from './job-store.mjs';

test('job transitions are deterministic and reject invalid state changes', () => {
  const pending = { id: 'a', status: 'pending', attempts: 0 };
  const processing = transitionJob(pending, 'processing', '2026-10-03T00:00:00Z');
  assert.equal(processing.attempts, 1);
  assert.deepEqual(transitionJob(processing, 'processing'), processing);
  assert.equal(transitionJob(processing, 'ready', '2026-10-03T00:01:00Z').completed_at, '2026-10-03T00:01:00Z');
  assert.throws(() => transitionJob(pending, 'ready'), /Invalid job transition/);
});

test('atomic job writes expose only complete JSON at the canonical job path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohnisko-jobs-'));
  const file = path.join(dir, 'job.json');
  try {
    const payload = 'x'.repeat(8_000_000);
    let writing = true;
    const observations = [];
    const writer = writeJsonAtomic(file, { id: 'job', status: 'pending', payload }).finally(() => { writing = false; });
    while (writing) {
      try {
        const visible = await readJob(file);
        observations.push(visible.payload.length);
        assert.equal(visible.payload.length, 8_000_000);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    await writer;
    const result = await readJob(file);
    assert.equal(result.payload.length, 8_000_000);
    assert.deepEqual(await fs.readdir(dir), ['job.json']);
    await writeJsonAtomic(file, { id: 'job', status: 'processing' });
    assert.deepEqual(await readJob(file), { id: 'job', status: 'processing' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
