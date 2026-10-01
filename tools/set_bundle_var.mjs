#!/usr/bin/env node
/**
 * Set a bundle variable value in databricks.yml, preserving comments.
 *
 * Writes into `targets.<target>.variables.<key>` (the bundle-idiomatic
 * override point), creating the variables map if needed. Used by
 * scripts/post_deploy.sh to record the deployed Genie space ID.
 *
 * Usage:
 *   node tools/set_bundle_var.mjs <key> <value> [-t <target>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'databricks.yml');

const argv = process.argv.slice(2);
const [key, value] = argv;
const targetName = argv.includes('-t') ? argv[argv.indexOf('-t') + 1] : null;
if (!key || value === undefined) {
  console.error('usage: node tools/set_bundle_var.mjs <key> <value> [-t <target>]');
  process.exit(1);
}

const doc = YAML.parseDocument(readFileSync(FILE, 'utf8'));
const targets = doc.get('targets');
if (!targets) {
  console.error('no targets: block in databricks.yml');
  process.exit(1);
}
const name = targetName ?? [...targets.items].find((i) => i.value?.get('default') === true)?.key?.value;
if (!name || !targets.has(name)) {
  console.error(`target ${targetName ?? '(default)'} not found in databricks.yml`);
  process.exit(1);
}
const target = targets.get(name);
if (!target.has('variables')) target.set('variables', new YAML.YMap());
target.get('variables').set(key, value);

writeFileSync(FILE, doc.toString());
console.log(`databricks.yml: targets.${name}.variables.${key} = '${value}'`);
