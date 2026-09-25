'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MANIFESTS, LOCK, readState, planRelease, applyPlan } = require('./plan-release');
const { prFromSubject } = require('./changes');
const { fromEnvironment } = require('./github');

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function lines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function changeFilesAt(root, ref) {
  return lines(git(root, 'ls-tree', '-r', '--name-only', ref, 'changes'))
    .filter((file) => /^changes\/[^/]+\.md$/i.test(file) && file.toLowerCase() !== 'changes/readme.md');
}

function prAt(root, ref, file) {
  try {
    const subject = git(root, 'log', '--first-parent', '--diff-filter=A', '--format=%s', '-1', ref, '--', file);
    return prFromSubject(subject);
  } catch {
    return null;
  }
}

function readAt(root, ref) {
  const files = new Set(lines(git(root, 'ls-tree', '-r', '--name-only', ref)));
  const changes = changeFilesAt(root, ref);
  return readState(
    (file) => git(root, 'show', `${ref}:${file}`),
    (file) => files.has(file),
    { list: () => changes, prOf: (file) => prAt(root, ref, file) },
  );
}

function currentChangeFiles(root) {
  const dir = path.join(root, 'changes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /\.md$/i.test(name) && name.toLowerCase() !== 'readme.md')
    .map((name) => `changes/${name}`);
}

function currentState(root) {
  return readState(
    (file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8'),
    (file) => fs.existsSync(path.join(root, ...file.split('/'))),
    { list: () => currentChangeFiles(root), prOf: (file) => prAt(root, 'HEAD', file) },
  );
}

function remoteRef(root, ref) {
  const out = git(root, 'ls-remote', 'origin', ref, `${ref}^{}`);
  const refs = new Map(lines(out).map((line) => {
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

function objectExists(root, commit, file) {
  try {
    git(root, 'cat-file', '-e', `${commit}:${file}`);
    return true;
  } catch {
    return false;
  }
}

function verifyCut(root, commit, version) {
  const parents = git(root, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
  if (parents.length !== 1) throw new Error('A release cut must have exactly one parent');
  const base = parents[0];
  if (git(root, 'show', '-s', '--format=%B', commit) !== commitMessage(version, base)) {
    throw new Error(`v${version} is not a verifiable automation cut; refusing recovery`);
  }
  const state = readAt(root, commit);
  if (state.version !== version || state.changelog.latest !== version) {
    throw new Error('Release cut has inconsistent versions');
  }
  const previous = readAt(root, base);
  const manual = Number(version.split('.')[0]) === Number(previous.version.split('.')[0]) + 1;
  const plan = planRelease(previous, { date: state.changelog.latestDate, version: manual ? version : '', allowMajor: manual, requirePrs: true });
  if (plan.kind !== 'release' || plan.version !== version) throw new Error('Release cut does not match its parent plan');
  const actualFiles = lines(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit)).sort();
  const expectedFiles = Object.keys(plan.changes).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Release cut contains unexpected or missing files');
  }
  for (const [file, expected] of Object.entries(plan.changes)) {
    if (expected === null) {
      if (objectExists(root, commit, file)) throw new Error(`Release cut should delete ${file}`);
    } else {
      const actual = git(root, 'show', `${commit}:${file}`).replace(/\r\n/g, '\n');
      if (actual !== expected.replace(/\r\n/g, '\n').trim()) {
        throw new Error(`Release cut content differs from its parent plan: ${file}`);
      }
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
  // A tag cut before change files (#6) holds a CHANGELOG with the hand-written
  // `## [Unreleased]` heading that this planner refuses, and no plan of this
  // planner made it, so it cannot be read as a state or verified as a cut.
  // Measured: the first scheduled run after #6 failed here on v0.6.0. Such a tag
  // is the version its manifest says; published, it is done, and unpublished, a
  // person has to look.
  if (!objectExists(root, commit, 'changes/README.md')) {
    // Every manifest, and the lock where the tag tracks one, agrees on the
    // version, as readState asks of any state; only the CHANGELOG is not read.
    const at = (file) => JSON.parse(git(root, 'show', `${commit}:${file}`));
    for (const file of MANIFESTS) {
      if (at(file).version !== state.version) throw new Error(`${tag} does not contain version ${state.version} in ${file}`);
    }
    if (objectExists(root, commit, LOCK)) {
      const lock = at(LOCK);
      if (lock.version !== state.version || (lock.lockfileVersion >= 2 && lock.packages?.['']?.version !== state.version)) {
        throw new Error(`${tag} does not contain version ${state.version} in ${LOCK}`);
      }
    }
    if (!release) throw new Error(`${tag} predates change files and has no release; manual investigation required`);
    if (release.tag_name !== tag || release.draft || release.prerelease) throw new Error(`Conflicting release state for ${tag}`);
    return { kind: 'published', tag, commit };
  }
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
  // Validate manual input even on retries and empty runs.
  const plan = planRelease(state, { version, allowMajor, date, requirePrs: true });
  const publication = await inspectPublication(root, github, state);
  if (publication.kind === 'recover') {
    if (version) throw new Error('Recover the previous cut with an empty version input before requesting a new major');
    await publish(root, github, publication);
    return { kind: 'recovered', tag: publication.tag, commit: publication.commit };
  }
  // A refusal fails the run: a person has to act, and a green run would retry it
  // every morning with nobody told. Only a day with no change files is quiet.
  if (plan.kind === 'refused') throw new Error(`Release refused: ${plan.reason}`);
  if (plan.kind === 'noop') return plan;
  if (await github.release(plan.tag) || remoteRef(root, `refs/tags/${plan.tag}`)) {
    throw new Error(`${plan.tag} already exists; refusing to overwrite a tag or release`);
  }
  applyPlan(root, plan);
  await validate();
  if (remoteRef(root, 'refs/heads/main') !== base) throw new Error('main moved during validation; retry without tagging it');
  const tracked = Object.keys(plan.changes).filter((file) => git(root, 'ls-files', '--', file));
  if (tracked.length) git(root, 'add', '-A', '--', ...tracked);
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

// What the workflow reads after the release: whether a version was published on
// this run (a new cut, or a recovered one), and its tag, so the marketplace can
// be asked to pin it. A day with nothing to release publishes nothing.
function outputsOf(result) {
  const published = !!result && (result.kind === 'released' || result.kind === 'recovered');
  return `published=${published}\ntag=${published ? result.tag : ''}\n`;
}

module.exports = { git, currentState, readAt, remoteRef, verifyCut, inspectPublication, runRelease, outputsOf };

if (require.main === module) {
  (async () => {
    if (process.env.GITHUB_REF !== 'refs/heads/main' ||
        !['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) {
      throw new Error('Release must run on main via schedule or workflow_dispatch');
    }
    const root = process.cwd();
    const result = await runRelease({
      root,
      github: fromEnvironment(),
      version: process.env.RELEASE_VERSION || '',
      allowMajor: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
      validate: () => {
        execFileSync(process.execPath, ['--test', 'tools/plan-release.test.js', 'tools/release.test.js', 'tools/changes.test.js'], { cwd: root, stdio: 'inherit' });
        execFileSync(process.execPath, ['tools/plan-release.js', '--check'], { cwd: root, stdio: 'inherit' });
        execFileSync(process.execPath, ['tools/changes.js', '--check'], { cwd: root, stdio: 'inherit' });
      },
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, outputsOf(result));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release result:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
