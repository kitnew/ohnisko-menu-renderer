import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const nextStates = {
  pending: new Set(['processing']),
  processing: new Set(['ready', 'failed', 'pending']),
  ready: new Set(),
  failed: new Set(['pending']),
};

export async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function transitionJob(job, status, now = new Date().toISOString()) {
  if (job.status === status) return { ...job };
  if (!nextStates[job.status]?.has(status)) {
    throw new Error(`Invalid job transition: ${job.status} -> ${status}`);
  }
  const next = { ...job, status, updated_at: now };
  if (status === 'processing') {
    next.started_at = now;
    next.attempts = (Number(job.attempts) || 0) + 1;
    next.error = null;
  } else if (status === 'ready') {
    next.completed_at = now;
    next.error = null;
  } else if (status === 'failed') {
    next.failed_at = now;
  } else if (status === 'pending') {
    next.requeued_at = now;
  }
  return next;
}

export async function readJob(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
