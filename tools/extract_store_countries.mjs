#!/usr/bin/env node
/**
 * Extract only the store countries from world-atlas countries-10m.json
 * into a small TopoJSON asset (full 10m is ~3.7MB — too heavy to bundle).
 * Arc indices are remapped into a fresh arc array so the existing
 * delta-decoder in StoreMap.tsx works unchanged.
 *
 * Run: node tools/extract_store_countries.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules/world-atlas/countries-10m.json');
const OUT = join(ROOT, 'client/src/assets/countries-10m-stores.json');

// Store countries (from the stores master: JP, US, UK, SG, AU, FR, DE)
const WANT = new Set(['Japan', 'United States of America', 'United Kingdom', 'Singapore', 'Australia', 'France', 'Germany']);

const topo = JSON.parse(readFileSync(SRC, 'utf8'));
const all = topo.objects.countries.geometries;
const picked = all.filter((g) => WANT.has(g.properties?.name));
console.log(`picked ${picked.length} geometries:`, picked.map((g) => g.properties.name).join(', '));

// collect referenced arcs (negative index ~i encodes the reversed arc)
const used = new Set();
const walk = (a) => {
  if (Array.isArray(a[0])) a.forEach(walk);
  else a.forEach((i) => used.add(i < 0 ? ~i : i));
};
for (const g of picked) walk(g.arcs);

const sorted = [...used].sort((a, b) => a - b);
const remap = new Map(sorted.map((old, i) => [old, i]));
const remapRef = (i) => (i < 0 ? ~remap.get(~i) : remap.get(i));
const remapArcs = (a) => (Array.isArray(a[0]) ? a.map(remapArcs) : a.map(remapRef));

const out = {
  type: 'Topology',
  bbox: topo.bbox,
  transform: topo.transform,
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: picked.map((g) => ({ ...g, arcs: remapArcs(g.arcs) })),
    },
  },
  arcs: sorted.map((i) => topo.arcs[i]),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`arcs: ${topo.arcs.length} -> ${sorted.length}`);
console.log(`wrote ${OUT} (${(bytes / 1024).toFixed(0)}KB)`);
