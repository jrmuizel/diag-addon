#!/usr/bin/env node
'use strict';

/*
 * Dependency-free sanity checks for the unpacked extension.
 *
 * Runs the same checks locally (`npm run check`) and in CI:
 *   1. every .js file parses as JavaScript
 *   2. every .json file is valid JSON
 *   3. files referenced by manifest.json exist
 *   4. local src/href references in .html files exist
 *
 * No build step and no dependencies, so this is just a static audit of the
 * source tree.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const errors = [];
const counts = { js: 0, json: 0, html: 0, refs: 0 };

function rel(p) {
  return path.relative(ROOT, p) || p;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isLocalRef(ref) {
  if (!ref || ref.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // scheme: (http:, data:, ...)
  if (ref.startsWith('//')) return false;             // protocol-relative
  return true;
}

const files = walk(ROOT);

/* 1. JavaScript syntax */
for (const file of files.filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(src, { filename: file });
    counts.js++;
  } catch (err) {
    errors.push(`${rel(file)}: JavaScript syntax error: ${err.message}`);
  }
}

/* 2. JSON validity */
for (const file of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    counts.json++;
  } catch (err) {
    errors.push(`${rel(file)}: invalid JSON: ${err.message}`);
  }
}

/* 3. Files referenced by the manifest exist */
const manifestPath = path.join(ROOT, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    errors.push(`manifest.json: could not parse: ${err.message}`);
  }

  if (manifest) {
    const refs = [];
    if (manifest.devtools_page) refs.push(manifest.devtools_page);
    if (manifest.background) {
      if (manifest.background.service_worker) refs.push(manifest.background.service_worker);
      if (Array.isArray(manifest.background.scripts)) refs.push(...manifest.background.scripts);
    }
    if (manifest.sandbox && Array.isArray(manifest.sandbox.pages)) refs.push(...manifest.sandbox.pages);
    if (manifest.icons) refs.push(...Object.values(manifest.icons));
    if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
    if (manifest.options_page) refs.push(manifest.options_page);
    if (manifest.options_ui && manifest.options_ui.page) refs.push(manifest.options_ui.page);

    for (const ref of refs) {
      if (typeof ref !== 'string' || !isLocalRef(ref)) continue;
      if (fs.existsSync(path.join(ROOT, ref))) counts.refs++;
      else errors.push(`manifest.json: referenced file does not exist: ${ref}`);
    }
  }
}

/* 4. Local src/href references in HTML exist */
for (const file of files.filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(file, 'utf8');
  counts.html++;

  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(src))) {
    const ref = match[1].trim();
    if (!isLocalRef(ref)) continue;
    const cleaned = ref.split('#')[0].split('?')[0];
    if (!cleaned) continue;
    const target = path.join(path.dirname(file), cleaned);
    if (!fs.existsSync(target)) {
      errors.push(`${rel(file)}: referenced file does not exist: ${ref}`);
    }
  }
}

if (errors.length) {
  console.error(`\n\u2717 ${errors.length} problem(s) found:\n`);
  for (const err of errors) console.error('  - ' + err);
  console.error('');
  process.exit(1);
}

console.log(
  `\u2713 checks passed (${counts.js} JS, ${counts.json} JSON, ` +
  `${counts.html} HTML, ${counts.refs} manifest references)`
);
