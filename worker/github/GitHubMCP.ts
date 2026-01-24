/**
 * GitHubMCP - Hosted MCP wrapper for GitHub operations
 *
 * Enables workflows to interact with GitHub repositories, issues, and pull requests
 * as MCP tools, making them composable with other MCP servers like Gmail, GoogleDocs.
 */

import { HostedMCPServer, type MCPToolSchema, type MCPToolCallResult } from '../mcp/MCPClient';
import { toolsToMCPSchemas, parseToolArgs } from '../utils/zodTools';
import { githubTools } from './githubTools';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_BRANCH = 'main';

// Backwards compatibility: map old snake_case tool names to camelCase
const LEGACY_TOOL_NAMES: Record<string, string> = {
  'read_file': 'readFile',
  'create_branch': 'createBranch',
  'create_pr': 'createPullRequest',
  'create_pull_request': 'createPullRequest',
  'list_issues': 'listIssues',
  'list_pull_requests': 'listPullRequests',
  'list_repos': 'listRepositories',
  'get_issue': 'getIssue',
  'get_pull_request': 'getPullRequest',
  'get_repository': 'getRepository',
  'list_repositories': 'listRepositories',
};

// Backwards compatibility: map old snake_case arg names to camelCase
const LEGACY_ARG_NAMES: Record<string, string> = {
  'pull_number': 'pullNumber',
  'issue_number': 'issueNumber',
  'per_page': 'perPage',
};

export class GitHubMCPServer extends HostedMCPServer {
  readonly name = 'GitHub';
  readonly description = 'Read-only access to repositories, issues, and pull requests. Use Sandbox for code changes.';

  private accessToken: string;

  constructor(accessToken: string) {
    super();
    this.accessToken = accessToken;
  }

  getTools(): MCPToolSchema[] {
    return toolsToMCPSchemas(githubTools);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const normalizedName = LEGACY_TOOL_NAMES[name] || name;
    const normalizedArgs = { ...args };
    for (const [oldKey, newKey] of Object.entries(LEGACY_ARG_NAMES)) {
      if (oldKey in normalizedArgs) {
        normalizedArgs[newKey] = normalizedArgs[oldKey];
        delete normalizedArgs[oldKey];
      }
    }

    try {
      switch (normalizedName) {
        case 'readFile':
          return await this.readFile(normalizedArgs);
        case 'createBranch':
          return await this.createBranch(normalizedArgs);
        case 'createPullRequest':
          return await this.createPullRequest(normalizedArgs);
        case 'listIssues':
          return await this.listIssues(normalizedArgs);
        case 'listPullRequests':
          return await this.listPullRequests(normalizedArgs);
        case 'getIssue':
          return await this.getIssue(normalizedArgs);
        case 'getPullRequest':
          return await this.getPullRequest(normalizedArgs);
        case 'getRepository':
          return await this.getRepository(normalizedArgs);
        case 'listRepositories':
          return await this.listRepositories(normalizedArgs);
        default:
          return this.errorContent(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.errorContent(error instanceof Error ? error.message : String(error));
    }
  }

  // ============================================================================
  // Tool Implementations
  // ============================================================================

  private async readFile(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, path, ref = DEFAULT_BRANCH } = parseToolArgs(githubTools.readFile.input, args);

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as {
      content: string;
      sha: string;
      size: number;
      path: string;
      encoding: string;
    };

    // GitHub returns base64-encoded content
    const content = this.decodeBase64(data.content);

    const result = {
      content,
      sha: data.sha,
      size: data.size,
      path: data.path,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async createBranch(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, branch, from = DEFAULT_BRANCH } = parseToolArgs(githubTools.createBranch.input, args);

    // First, get the SHA of the source branch
    const refUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/ref/heads/${from}`;
    const refResponse = await this.githubFetch(refUrl);
    const refData = await refResponse.json() as {
      object: { sha: string };
    };

    // Create the new branch
    const createUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs`;
    const response = await this.githubFetch(createUrl, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: refData.object.sha,
      }),
    });

    const data = await response.json() as {
      ref: string;
      object: { sha: string };
    };

    const result = {
      ref: data.ref,
      sha: data.object.sha,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async createPullRequest(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, title, body = '', head, base = DEFAULT_BRANCH } = parseToolArgs(githubTools.createPullRequest.input, args);

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`;
    const response = await this.githubFetch(url, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body,
        head,
        base,
      }),
    });

    const data = await response.json() as {
      number: number;
      html_url: string;
      state: string;
      title: string;
    };

    const result = {
      number: data.number,
      url: data.html_url,
      state: data.state,
      title: data.title,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: { ...result, url: data.html_url, title: data.title },
    };
  }

  private async listIssues(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, state = 'open', labels, since, perPage = 30 } = parseToolArgs(githubTools.listIssues.input, args);

    const queryParts = [`repo:${owner}/${repo}`, 'is:issue'];
    if (state !== 'all') {
      queryParts.push(`state:${state}`);
    }
    if (labels) {
      for (const label of labels.split(',')) {
        queryParts.push(`label:${label.trim()}`);
      }
    }
    if (since) {
      queryParts.push(`created:>=${since}`);
    }

    const params = new URLSearchParams({
      q: queryParts.join(' '),
      per_page: String(perPage),
    });

    const url = `${GITHUB_API_BASE}/search/issues?${params.toString()}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as {
      items: Array<{
        number: number;
        title: string;
        state: string;
        html_url: string;
        labels: Array<{ name: string; color: string }>;
      }>;
    };

    const result = data.items.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      labels: issue.labels.map((l) => l.name),
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async listPullRequests(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, state = 'open', since, perPage = 30 } = parseToolArgs(githubTools.listPullRequests.input, args);

    const queryParts = [`repo:${owner}/${repo}`, 'is:pr'];
    if (state !== 'all') {
      queryParts.push(`state:${state}`);
    }
    if (since) {
      queryParts.push(`created:>=${since}`);
    }

    const params = new URLSearchParams({
      q: queryParts.join(' '),
      per_page: String(perPage),
    });

    const url = `${GITHUB_API_BASE}/search/issues?${params.toString()}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as {
      items: Array<{
        number: number;
        title: string;
        state: string;
        html_url: string;
      }>;
    };

    const result = data.items.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.html_url,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async getIssue(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, issueNumber } = parseToolArgs(githubTools.getIssue.input, args);

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as {
      number: number;
      title: string;
      state: string;
      body: string | null;
      html_url: string;
    };

    const result = {
      number: data.number,
      title: data.title,
      state: data.state,
      body: data.body || '',
      url: data.html_url,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async getPullRequest(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo, pullNumber } = parseToolArgs(githubTools.getPullRequest.input, args);

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as {
      number: number;
      title: string;
      state: string;
      body: string | null;
      html_url: string;
    };

    const result = {
      number: data.number,
      title: data.title,
      state: data.state,
      body: data.body || '',
      url: data.html_url,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async getRepository(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { owner, repo } = parseToolArgs(githubTools.getRepository.input, args);

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as {
      full_name: string;
      name: string;
      owner: { login: string };
      description: string | null;
      private: boolean;
      html_url: string;
      default_branch: string;
      stargazers_count: number;
      forks_count: number;
    };

    const result = {
      full_name: data.full_name,
      name: data.name,
      owner: data.owner.login,
      description: data.description || '',
      private: data.private,
      url: data.html_url,
      default_branch: data.default_branch,
      stars: data.stargazers_count,
      forks: data.forks_count,
      // Use full_name as title for link pills
      title: data.full_name,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async listRepositories(args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const { type = 'all', sort = 'full_name', perPage = 30 } = parseToolArgs(githubTools.listRepositories.input, args);

    const params = new URLSearchParams({
      type,
      sort,
      per_page: String(perPage),
    });

    const url = `${GITHUB_API_BASE}/user/repos?${params.toString()}`;
    const response = await this.githubFetch(url);
    const data = await response.json() as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      description: string | null;
      private: boolean;
      html_url: string;
    }>;

    const result = data.map((repo) => ({
      full_name: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      description: repo.description || '',
      private: repo.private,
      url: repo.html_url,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }

  private async githubFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Weft-App',
        ...options.headers,
      },
    });

    if (!response.ok) {
      let errorMessage = `GitHub API error: ${response.status}`;
      try {
        const errorData = await response.json() as { message?: string };
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    return response;
  }

  private decodeBase64(data: string): string {
    // GitHub returns base64 with newlines, need to strip them
    const cleaned = data.replace(/\n/g, '');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
}
