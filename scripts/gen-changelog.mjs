#!/usr/bin/env node
// Generate a draft release-notes file by grouping conventional commits
// between two git refs. This produces a MECHANICAL draft only; a human or
// an AI pass should polish wording before publishing.
//
// Usage:
//   node scripts/gen-changelog.mjs <fromRef> [toRef]
//   node scripts/gen-changelog.mjs v0.1.1 v0.1.2
//   node scripts/gen-changelog.mjs v0.1.2            (toRef defaults to HEAD)
//   node scripts/gen-changelog.mjs                   (auto: latest two tags)
//
// Output: scripts/release-notes-<toRef>.md  (use --stdout to print instead)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 5e7 }).trim();
}

// --- Section mapping: conventional-commit type -> release section ---------
// Order here defines output order. Tweak freely to match project taste.
const SECTIONS = [
  { key: 'feat', title: '## ✨ New Features', types: ['feat'] },
  { key: 'improve', title: '## 🔧 Improvements', types: ['refactor', 'style', 'perf'] },
  { key: 'infra', title: '## 🏗️ Infrastructure', types: ['chore', 'build', 'ci'] },
  { key: 'docs', title: '## 📝 Documentation', types: ['docs'] },
  { key: 'test', title: '## 🧪 Tests', types: ['test'] },
  { key: 'fix', title: '## 🐛 Fixes', types: ['fix'] },
];

function sectionForType(type) {
  const s = SECTIONS.find((sec) => sec.types.includes(type));
  return s ? s.key : null; // unknown types are dropped from the draft
}

// --- Resolve refs ----------------------------------------------------------
const argv = process.argv.slice(2).filter((a) => a !== '--stdout');
const toStdout = process.argv.includes('--stdout');

let fromRef = argv[0];
let toRef = argv[1] || 'HEAD';

if (!fromRef) {
  // Auto: pick the latest two tags by version sort.
  const tags = git(['tag', '-l', '--sort=-v:refname'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length < 2) {
    console.error('Need at least two tags to auto-detect a range. Pass <fromRef> [toRef] explicitly.');
    process.exit(1);
  }
  fromRef = tags[1];
  toRef = tags[0];
}

// --- Collect commits -------------------------------------------------------
const raw = git([
  'log',
  '--no-merges',
  '--pretty=format:%H%x1f%s%x1f%b%x1e',
  `${fromRef}..${toRef}`,
]);

const commits = raw
  .split('\x1e')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, subject, body] = c.split('\x1f');
    return { hash, subject: (subject || '').trim(), body: (body || '').trim() };
  });

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;

const buckets = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));

for (const commit of commits) {
  const m = commit.subject.match(CONVENTIONAL);
  if (!m) continue;
  const type = m[1].toLowerCase();
  const summary = m[4].trim();
  // Skip release/version-bump chores; they add no user-facing value.
  if (/^release\b/i.test(summary) || /^bump\b/i.test(summary)) continue;
  const key = sectionForType(type);
  if (!key) continue;
  // Capitalize first letter for consistency with the house style.
  const text = summary.charAt(0).toUpperCase() + summary.slice(1);
  buckets[key].push({ text, hash: commit.hash.slice(0, 7) });
}

// --- Build compare link from origin remote --------------------------------
function compareLink() {
  let url = '';
  try {
    url = git(['remote', 'get-url', 'origin']);
  } catch {
    return null;
  }
  // git@github.com:owner/repo.git  OR  https://github.com/owner/repo.git
  const ssh = url.match(/git@([^:]+):(.+?)(?:\.git)?$/);
  const https = url.match(/https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  const host = ssh ? ssh[1] : https ? https[1] : null;
  const slug = ssh ? ssh[2] : https ? https[2] : null;
  if (!host || !slug) return null;
  return `https://${host}/${slug}/compare/${fromRef}...${toRef}`;
}

// --- Render ----------------------------------------------------------------
const lines = [];
for (const sec of SECTIONS) {
  const items = buckets[sec.key];
  if (!items.length) continue;
  lines.push(sec.title, '');
  for (const it of items) lines.push(`- ${it.text}`);
  lines.push('');
}

const link = compareLink();
lines.push('---', '');
if (link) lines.push(`**Full Changelog**: ${link}`);
else lines.push(`**Full Changelog**: ${fromRef}...${toRef}`);
lines.push('');

const output = lines.join('\n');

if (toStdout) {
  process.stdout.write(output);
} else {
  const label = toRef === 'HEAD' ? 'HEAD' : toRef;
  const outPath = join(__dirname, `release-notes-${label}.md`);
  writeFileSync(outPath, output, 'utf8');
  console.error(`Wrote ${outPath}`);
  console.error('NOTE: this is a mechanical draft. Polish wording before publishing.');
}
