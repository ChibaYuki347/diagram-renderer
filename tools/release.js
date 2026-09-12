'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readState, planRelease, applyPlan } = require('./plan-release');
const { fromEnvironment } = require('./github');
const { inFlight } = require('./in-flight');

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function readAt(root, ref) {
  const files = new Set(git(root, 'ls-tree', '-r', '--name-only', ref).split('\n'));
  return readState(file => git(root, 'show', `${ref}:${file}`), file => files.has(file));
}

function currentState(root) {
  return readState(file => fs.readFileSync(path.join(root, file), 'utf8'), file => fs.existsSync(path.join(root, file)));
}

function remoteRef(root, ref) {
  const lines = git(root, 'ls-remote', 'origin', ref, `${ref}^{}`).split('\n').filter(Boolean);
  const refs = new Map(lines.map(line => {
    const [sha, name] = line.split(/\s+/);
    return [name, sha];
  }));
  const sha = refs.get(`${ref}^{}`) || refs.get(ref);
  if (sha && !/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid remote object ID for ${ref}`);
  return sha;
}

function commitMessage(version, base) {
  return `chore(release): v${version}\n\nRelease-Version: ${version}\nRelease-Base: ${base}`;
}

function verifyCut(root, commit, version) {
  const parents = git(root, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
  if (parents.length !== 1) throw new Error('A release cut must have exactly one parent');
  const base = parents[0];
  if (git(root, 'show', '-s', '--format=%B', commit) !== commitMessage(version, base)) {
    throw new Error(`v${version} is not a verifiable automation cut; refusing recovery`);
  }
  const state = readAt(root, commit);
  if (state.version !== version || state.changelog.hasNotes) throw new Error('Release cut has inconsistent versions or Unreleased notes');
  const heading = state.changelog.next.title;
  const date = heading.slice(-10);
  const previous = readAt(root, base);
  const manual = Number(version.split('.')[0]) === Number(previous.version.split('.')[0]) + 1;
  const plan = planRelease(previous, { date, version: manual ? version : '', allowMajor: manual });
  if (plan.kind !== 'release' || plan.version !== version) throw new Error('Release cut does not match its parent plan');
  const actualFiles = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n').sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(plan.changes).sort())) {
    throw new Error('Release cut contains unexpected or missing files');
  }
  for (const [file, expected] of Object.entries(plan.changes)) {
    if (git(root, 'show', `${commit}:${file}`).replace(/\r\n/g, '\n') !== expected.trim()) {
      throw new Error(`Release cut content differs from its parent plan: ${file}`);
    }
  }
  return { ...plan, commit };
}

async function inspectPublication(root, github, state) {
  const tag = `v${state.version}`;
  const commit = remoteRef(root, `refs/tags/${tag}`);
  const release = await github.release(tag);
  if (!commit) throw new Error(`${tag} is missing on origin; do not guess a release commit or retag main`);
  git(root, 'merge-base', '--is-ancestor', commit, 'HEAD');
  const tagged = readAt(root, commit);
  if (tagged.version !== state.version) throw new Error(`${tag} does not contain version ${state.version}`);
  const managed = git(root, 'show', '-s', '--format=%B', commit).startsWith('chore(release): ');
  const cut = managed ? verifyCut(root, commit, state.version) : null;
  if (release) {
    if (release.tag_name !== tag || release.draft || release.prerelease) throw new Error(`Conflicting release state for ${tag}`);
    if (cut && (release.body || '').trim() !== cut.notes.trim()) throw new Error(`Existing ${tag} release notes differ; refusing overwrite`);
    return { kind: 'published', tag, commit };
  }
  if (!cut) throw new Error(`${tag} has no release and is not an automation cut; manual investigation required`);
  return { ...cut, kind: 'recover' };
}

async function publish(root, github, cut) {
  if (remoteRef(root, `refs/tags/${cut.tag}`) !== cut.commit) throw new Error('Remote tag no longer matches the verified cut');
  const existing = await github.release(cut.tag);
  if (existing) {
    if (existing.tag_name !== cut.tag || existing.draft || existing.prerelease ||
        (existing.body || '').trim() !== cut.notes.trim()) throw new Error('Existing release conflicts with this cut; refusing overwrite');
    return;
  }
  await github.request('POST', '/releases', {
    tag_name: cut.tag,
    target_commitish: cut.commit,
    name: cut.tag,
    body: cut.notes,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  });
}

async function runRelease({ root, github, version = '', allowMajor = false, date, validate = () => {} }) {
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Release requires a clean tracked worktree');
  const base = git(root, 'rev-parse', 'HEAD');
  if (remoteRef(root, 'refs/heads/main') !== base) throw new Error('main moved since checkout; retry on latest main');
  const state = currentState(root);
  // Validate manual input even on retries and empty-note runs.
  const plan = planRelease(state, { version, allowMajor, date });
  const publication = await inspectPublication(root, github, state);
  if (publication.kind === 'recover') {
    if (version) throw new Error('Recover the previous cut with an empty version input before requesting a new major');
    await publish(root, github, publication);
    return { kind: 'recovered', tag: publication.tag, commit: publication.commit };
  }
  if (plan.kind === 'noop') return plan;
  const held = await inFlight(github, plan.notes);
  if (held.length) return { kind: 'held', pulls: held };
  if (await github.release(plan.tag) || remoteRef(root, `refs/tags/${plan.tag}`)) {
    throw new Error(`${plan.tag} already exists; refusing to overwrite a tag or release`);
  }
  applyPlan(root, plan);
  await validate();
  const heldAfterValidation = await inFlight(github, plan.notes);
  if (heldAfterValidation.length) return { kind: 'held', pulls: heldAfterValidation };
  if (remoteRef(root, 'refs/heads/main') !== base) throw new Error('main moved during validation; retry without tagging it');
  const tracked = Object.keys(plan.changes).filter(file => git(root, 'ls-files', '--', file));
  git(root, 'add', '--', ...tracked);
  git(root, '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', commitMessage(plan.version, base));
  const commit = git(root, 'rev-parse', 'HEAD');
  const cut = verifyCut(root, commit, plan.version);
  git(root, '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag', '-a', plan.tag, '-m', `Release ${plan.tag}`, commit);
  // Neither ref can land alone; a concurrent main push rejects the entire cut.
  git(root, 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${plan.tag}`);
  await publish(root, github, cut);
  return { kind: 'released', tag: plan.tag, commit };
}

module.exports = { git, currentState, readAt, remoteRef, verifyCut, inspectPublication, runRelease };

if (require.main === module) {
  (async () => {
    if (process.env.GITHUB_REF !== 'refs/heads/main' ||
        !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) {
      throw new Error('Release must run on main via push or workflow_dispatch');
    }
    const root = process.cwd();
    const result = await runRelease({
      root,
      github: fromEnvironment(),
      version: process.env.RELEASE_VERSION || '',
      allowMajor: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
      validate: () => {
        execFileSync(process.execPath, ['--test', 'tools/plan-release.test.js', 'tools/release.test.js'], { cwd: root, stdio: 'inherit' });
        execFileSync(process.execPath, ['tools/plan-release.js', '--check'], { cwd: root, stdio: 'inherit' });
      },
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release result:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
