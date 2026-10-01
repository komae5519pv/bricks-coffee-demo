#!/usr/bin/env node
/**
 * Resolve bundle variables from databricks.yml (single source of truth).
 *
 * Merges global `variables:` defaults with `targets.<target>.variables`
 * overrides (target wins), then expands nested `${var.<name>}` references
 * inside values. Substitutions that are not `${var.*}` (e.g.
 * `${workspace.current_user.userName}`) are left as-is — they only resolve
 * at bundle deploy time and are never needed for app.yaml / post-deploy.
 *
 * Usage:
 *   node tools/bundle_vars.mjs [-t <target>]          # JSON to stdout
 *   node tools/bundle_vars.mjs [-t <target>] --env    # KEY='value' lines
 *
 * Imported by tools/render_app_yaml.mjs; called by scripts/post_deploy.sh.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveBundleVars(targetName = null) {
  const doc = YAML.parse(readFileSync(join(ROOT, 'databricks.yml'), 'utf8'));
  const targets = doc.targets ?? {};
  const target = targetName ? targets[targetName] : Object.entries(targets).find(([, t]) => t?.default)?.[1];
  if (!target) {
    throw new Error(`target ${targetName ?? '(default)'} not found in databricks.yml`);
  }

  const vars = {};
  for (const [key, def] of Object.entries(doc.variables ?? {})) {
    if (def && typeof def === 'object' && 'default' in def) vars[key] = def.default;
  }
  Object.assign(vars, target.variables ?? {});

  // expand nested ${var.x} (a few passes handle chains)
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value !== 'string') continue;
      const expanded = value.replace(/\$\{var\.([A-Za-z0-9_]+)\}/g, (m, name) => {
        if (name in vars && typeof vars[name] === 'string') {
          changed = true;
          return vars[name];
        }
        return m;
      });
      if (expanded !== value) vars[key] = expanded;
    }
    if (!changed) break;
  }
  return vars;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('-t');
  const targetName = ti >= 0 ? argv[ti + 1] : null;
  const vars = resolveBundleVars(targetName);
  if (argv.includes('--env')) {
    for (const [k, v] of Object.entries(vars)) console.log(`${k}='${String(v).replaceAll("'", "'\\''")}'`);
  } else {
    console.log(JSON.stringify(vars, null, 2));
  }
}
