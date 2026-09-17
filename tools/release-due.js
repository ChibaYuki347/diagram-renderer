'use strict';

const { currentState, inspectPublication } = require('./release');
const { planRelease } = require('./plan-release');
const { inFlight } = require('./in-flight');
const { fromEnvironment } = require('./github');

const MARKER = '<!-- diagram-renderer:release-due -->';
const TITLE = 'Release due';

async function evaluate(root, github) {
  const state = currentState(root);
  const publication = await inspectPublication(root, github, state);
  if (publication.kind === 'recover') {
    return { kind: 'recovery', detail: `${publication.tag} is tagged but not published. Run release on main with an empty version input to recover.` };
  }
  const plan = planRelease(state);
  if (plan.kind === 'noop') return { kind: 'published', detail: `${publication.tag} is published; no pending user-visible notes.` };
  const pulls = await inFlight(github, plan.notes);
  return {
    kind: pulls.length ? 'held' : 'ready',
    detail: `Proposed automatic release: ${plan.tag} (${plan.bump}).` +
      (pulls.length ? `\n\nHeld by open PRs: ${pulls.map(pull => `#${pull.number}`).join(', ')}.` : ''),
    notes: plan.notes,
  };
}

async function runDue({ root, github, evaluateStatus = () => evaluate(root, github) }) {
  let status;
  let failure;
  try {
    status = await evaluateStatus();
  } catch (error) {
    failure = error;
    status = { kind: 'failed', detail: `Inspection failed; readiness is unknown. No release decision was made.\n\n${error.message}` };
  }
  const issues = await github.pages('/issues?state=all&creator=github-actions%5Bbot%5D');
  const matching = issues.filter(issue => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(MARKER));
  if (matching.length > 1) throw new Error('Multiple release-due standing issues found; resolve duplicates explicitly');
  const issue = matching[0];
  const body = `${MARKER}\n## Status: ${status.kind}\n\n${status.detail}\n\n` +
    (status.notes ? `## Unpublished notes\n\n${status.notes}\n\n` : '') +
    `Managed by release-due. See [RELEASING.md](https://github.com/${github.repository}/blob/main/RELEASING.md) for release, hold and recovery procedures.`;
  if (body.length > 60000) throw new Error('Release-due body is too large; refusing to truncate release notes');
  if (status.kind !== 'published' || issue) {
    const fields = { title: TITLE, body, state: status.kind === 'published' ? 'closed' : 'open' };
    if (issue) {
      if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error('GitHub API returned an invalid issue number');
      await github.request('PATCH', `/issues/${issue.number}`, fields);
    } else {
      const { state, ...createFields } = fields;
      await github.request('POST', '/issues', createFields);
    }
  }
  if (failure) throw failure;
  return status;
}

module.exports = { MARKER, evaluate, runDue };

if (require.main === module) {
  (async () => {
    if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('release-due must run on main');
    console.log(JSON.stringify(await runDue({ root: process.cwd(), github: fromEnvironment() }), null, 2));
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
