'use strict';

class GitHub {
  constructor({ repository, token, fetchImpl = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid GITHUB_REPOSITORY');
    if (!token) throw new Error('GH_TOKEN is required');
    this.repository = repository;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(method, endpoint, body, { allow404 = false } = {}) {
    if (!endpoint.startsWith('/')) throw new Error('Expected a repository-relative API endpoint');
    const response = await this.fetch(`https://api.github.com/repos/${this.repository}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} ${endpoint}: HTTP ${response.status}`);
    return response.json();
  }

  async pages(endpoint, maxPages = 1000) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.request('GET', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error(`GitHub API returned a non-array for ${endpoint}`);
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error(`GitHub API pagination limit reached for ${endpoint}; refusing incomplete results`);
  }

  release(tag) {
    return this.request('GET', `/releases/tags/${encodeURIComponent(tag)}`, undefined, { allow404: true });
  }

  // A file as it stands at one commit. The in-flight guard needs a branch's own
  // CHANGELOG.md to see what it would add under `[Unreleased]`; a 404 is a real
  // answer -- the branch does not carry the file -- rather than a failure.
  async file(path, ref) {
    if (!/^[0-9a-f]{40}$/.test(ref || '')) throw new Error('Expected a commit SHA to read a file at');
    const body = await this.request('GET', `/contents/${path}?ref=${ref}`, undefined, { allow404: true });
    if (body === null) return '';
    if (body.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`GitHub API returned an unreadable ${path}`);
    }
    return Buffer.from(body.content, 'base64').toString('utf8');
  }
}

function fromEnvironment() {
  return new GitHub({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
}

module.exports = { GitHub, fromEnvironment };
