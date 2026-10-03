import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJob, transitionJob, writeJsonAtomic } from './job-store.mjs';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const jobsDir = path.join(runtimeDir, 'jobs');
const config = JSON.parse(await fs.readFile(path.join(runtimeDir, 'config.json'), 'utf8'));
if (typeof config.print_token !== 'string' || config.print_token.length < 32) {
  throw new Error('Runtime config must contain a print_token of at least 32 characters.');
}
const generatorPath = path.join(runtimeDir, 'generate-pdf.mjs');
const now = () => new Date().toISOString();

function runGenerator(inputUrl, outputFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [generatorPath, inputUrl, outputFile], { cwd: runtimeDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on('close', exitCode => resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

const redactToken = value => value.replaceAll(config.print_token, '[redacted]');

await fs.mkdir(jobsDir, { recursive: true });
const pending = [];
for (const name of await fs.readdir(jobsDir)) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(jobsDir, name);
  try {
    const job = await readJob(file);
    if (job.status === 'pending') pending.push({ file, job, mtime: (await fs.stat(file)).mtimeMs });
    if (job.status === 'processing' && Date.now() - Date.parse(job.started_at || 0) > 45 * 60 * 1000) {
      const retry = transitionJob(job, 'pending', now());
      retry.error = 'Recovered stale processing job after worker interruption.';
      await writeJsonAtomic(file, retry);
      pending.push({ file, job: retry, mtime: (await fs.stat(file)).mtimeMs });
    }
  } catch (error) {
    console.error(`Invalid job ${name}: ${error.message}`);
  }
}
pending.sort((a, b) => a.mtime - b.mtime);
if (!pending.length) {
  console.log('No pending PDF jobs.');
  process.exit(0);
}

const { file, job: initial } = pending[0];
if (typeof initial.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(initial.id)) {
  console.error('Invalid job id.');
  process.exit(1);
}
const job = transitionJob(initial, 'processing', now());
await writeJsonAtomic(file, job);
let temporaryOutput = '';
try {
  if (!job.filename || path.basename(job.filename) !== job.filename || !job.filename.toLowerCase().endsWith('.pdf')) throw new Error('Invalid output filename.');
  const inputUrl = new URL(config.site_url);
  inputUrl.searchParams.set('ohnisko_print', '1');
  inputUrl.searchParams.set('token', config.print_token);
  const outputDir = path.join(runtimeDir, 'generated');
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await fs.chmod(outputDir, 0o700);
  const outputFile = path.join(outputDir, job.filename);
  temporaryOutput = `${outputFile}.${job.id}.part.pdf`;
  console.log(`Processing job: ${job.id}`);
  const result = await runGenerator(inputUrl.toString(), temporaryOutput);
  job.generator_stdout = redactToken(result.stdout);
  job.generator_stderr = redactToken(result.stderr);
  if (result.exitCode !== 0) throw new Error(`PDF generator failed with exit code ${result.exitCode}`);
  const stat = await fs.stat(temporaryOutput);
  if (stat.size < 100) throw new Error('Generated PDF is empty or incomplete.');
  const handle = await fs.open(temporaryOutput, 'r');
  const prefix = Buffer.alloc(5);
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== 5 || prefix.toString('ascii') !== '%PDF-') throw new Error('Generated output is not a PDF.');
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryOutput, outputFile);
  const ready = transitionJob(job, 'ready', now());
  Object.assign(ready, {
    output_file: outputFile,
    pdf_size: stat.size,
  });
  await writeJsonAtomic(file, ready);
  console.log(`Job ready: ${job.id}`);
} catch (error) {
  if (temporaryOutput) await fs.rm(temporaryOutput, { force: true });
  const failed = transitionJob(job, 'failed', now());
  failed.error = error.message;
  await writeJsonAtomic(file, failed);
  console.error(`Job failed: ${job.id}: ${error.message}`);
  process.exitCode = 1;
}
