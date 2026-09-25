#!/usr/bin/env node
/**
 * Vendor tarballs for packages newly added to package-lock.json (vs a base
 * commit), and point npm `overrides` at the local files so the platform's
 * npm install never has to fetch them through the flaky build-env proxy.
 *
 *   node tools/vendor_new_deps.mjs [baseRef]   # default baseRef = HEAD~1
 *
 * Run `npm install` afterwards to regenerate the lockfile with file:
 * resolutions, then commit vendor/ + package.json + package-lock.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const baseRef = process.argv[2] ?? 'HEAD~1';

const cur = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages;
const old = JSON.parse(execFileSync('git', ['show', `${baseRef}:package-lock.json`], { cwd: ROOT, encoding: 'utf8' })).packages;

const newEntries = Object.entries(cur).filter(([k]) => k && !old[k]);
if (newEntries.length === 0) {
  console.log('no new packages vs', baseRef);
  process.exit(0);
}
console.log(`${newEntries.length} new packages to vendor`);

mkdirSync(VENDOR, { recursive: true });

const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
pkgJson.overrides ??= {};

function tgzName(key, version) {
  // node_modules/@types/debug -> types-debug-4.1.13.tgz
  const base = key
    .replace(/^node_modules\//, '')
    .replace(/\/node_modules\//g, '--')
    .replace(/^@/, '')
    .replace(/\//g, '-');
  return `${base}-${version}.tgz`;
}

let done = 0;
for (const [key, meta] of newEntries) {
  const url = meta.resolved;
  const version = meta.version;
  if (!url?.startsWith('http') || !version) {
    console.error(`skip (no registry tarball): ${key}`);
    continue;
  }
  const file = tgzName(key, version);
  execFileSync('curl', ['-sf', '--max-time', '60', '-o', join(VENDOR, file), url], { cwd: ROOT });
  const pkgName = key.replace(/^node_modules\//, '').replace(/\/node_modules\/.+$/, '');
  const nested = key.match(/^node_modules\/(.+)\/node_modules\/(.+)$/);
  if (nested) {
    // Nested instance (a second major living under its parent). A nested
    // override object would clobber the parent's own flat override (and a
    // file: path inside it resolves relative to the PARENT package dir —
    // broken), so pin the child with a version-scoped top-level override
    // instead; other majors of the same package stay registry-resolved.
    const [, , child] = nested;
    pkgJson.overrides[`${child}@^${version}`] = `file:vendor/${file}`;
  } else {
    pkgJson.overrides[pkgName] = `file:vendor/${file}`;
  }
  done++;
}

writeFileSync(join(ROOT, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
console.log(`vendored ${done} tarballs into vendor/ and wrote overrides.`);
console.log('next: npm install  (regenerates the lockfile with file: resolutions)');
