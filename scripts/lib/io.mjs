import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON only when the content actually changed. bootstrap-static is ~1.2MB
 * and mutates constantly during the season; committing every run would bloat the
 * repo without adding information.
 * @returns {Promise<boolean>} true if the file was written
 */
export async function writeJSONIfChanged(path, value) {
  const next = JSON.stringify(value, null, 0);
  const nextHash = createHash('sha256').update(next).digest('hex');
  const prev = await readFile(path, 'utf8').catch(() => null);
  if (prev !== null) {
    const prevHash = createHash('sha256').update(prev).digest('hex');
    if (prevHash === nextHash) return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return true;
}

export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 0));
}
