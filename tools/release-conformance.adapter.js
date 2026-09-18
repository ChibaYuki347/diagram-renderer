'use strict';

// Drives this repository's own release planner from the shared conformance cases
// in tools/release-conformance.js. Nothing here decides anything: the adapter
// translates a case into the shape plan-release.js and in-flight.js already take,
// and translates the answer back. A rule that only holds inside the adapter would
// be a rule this repository does not actually run.

const { parseChangelog, planRelease } = require('./plan-release');
const { inFlight } = require('./in-flight');

// in-flight.js asks a GitHub client for open pull requests, their file lists and
// each branch's own CHANGELOG.md. The suite already knows all three, so this
// stands in for the client without a network call -- the rule being exercised is
// the one in in-flight.js, unchanged.
function client(openPulls) {
  const sha = number => String(number).padStart(40, '0');
  return {
    async pages(route) {
      if (/^\/pulls\?/.test(route)) {
        return openPulls.map(pull => ({ number: pull.number, title: pull.title, head: { sha: sha(pull.number) } }));
      }
      const match = /^\/pulls\/(\d+)\/files/.exec(route);
      if (match) {
        const pull = openPulls.find(p => p.number === Number(match[1]));
        return pull.files.map(filename => ({ filename, status: 'modified' }));
      }
      throw new Error(`The conformance adapter does not stub ${route}`);
    },
    async file(path, ref) {
      if (path !== 'CHANGELOG.md') throw new Error(`The conformance adapter does not stub ${path}`);
      const pull = openPulls.find(p => sha(p.number) === ref);
      if (!pull) throw new Error(`The conformance adapter has no branch at ${ref}`);
      return pull.changelog;
    },
  };
}

// plan-release.js reads its version from the manifests it is given. The cases are
// about the changelog, so the manifests are supplied at the case's version and the
// changelog is parsed by this repository's own parser.
function state(changelog, version) {
  return { version, documents: {}, changelog: parseChangelog(changelog) };
}

async function plan({ changelog, version, date, openPulls }) {
  if (Array.isArray(openPulls)) {
    const notes = parseChangelog(changelog).notes;
    const held = await inFlight(client(openPulls), notes);
    if (held.length) return { release: false, held: true };
  }

  const result = planRelease(state(changelog, version), { date });

  return {
    release: result.kind === 'release',
    bump: result.bump,
    version: result.version,
    held: false,
  };
}

module.exports = { plan };
