/**
 * GitHub MCP Tool Definitions
 *
 * Single source of truth for GitHub tool schemas using Zod.
 * Used for both JSON Schema generation (getTools) and runtime validation (callTool).
 */

import { z } from 'zod';
import { defineTools, commonSchemas } from '../utils/zodTools';

// ============================================================================
// Output Schemas
// ============================================================================

const fileContentOutput = z.object({
  content: z.string().describe('File contents (decoded)'),
  sha: z.string().describe('File SHA (needed for updates)'),
  size: z.number().describe('File size in bytes'),
  path: z.string().describe('File path'),
});

const branchOutput = z.object({
  ref: z.string().describe('Full ref path (refs/heads/branch-name)'),
  sha: z.string().describe('Commit SHA the branch points to'),
});

const pullRequestOutput = z.object({
  number: z.number().describe('Pull request number'),
  url: z.string().describe('URL to the pull request'),
  state: z.string().describe('Pull request state'),
  title: z.string().describe('Pull request title'),
});

const issueOutput = z.object({
  number: z.number().describe('Issue number'),
  title: z.string().describe('Issue title'),
  state: z.string().describe('Issue state'),
  url: z.string().describe('URL to the issue'),
  labels: z.array(z.string()).optional().describe('Issue labels'),
});

const issueDetailOutput = z.object({
  number: z.number().describe('Issue number'),
  title: z.string().describe('Issue title'),
  state: z.string().describe('Issue state'),
  body: z.string().describe('Issue body'),
  url: z.string().describe('URL to the issue'),
});

const prDetailOutput = z.object({
  number: z.number().describe('PR number'),
  title: z.string().describe('PR title'),
  state: z.string().describe('PR state'),
  body: z.string().describe('PR body'),
  url: z.string().describe('URL to the PR'),
});

const repoOutput = z.object({
  full_name: z.string().describe('Full repo name (owner/repo)'),
  name: z.string().describe('Repository name'),
  owner: z.string().describe('Repository owner'),
  description: z.string().describe('Repository description'),
  private: z.boolean().describe('Whether repo is private'),
  url: z.string().describe('URL to the repository'),
  default_branch: z.string().optional().describe('Default branch name'),
  stars: z.number().optional().describe('Number of stars'),
  forks: z.number().optional().describe('Number of forks'),
});

const repoListItemOutput = z.object({
  full_name: z.string().describe('Full repo name (owner/repo)'),
  name: z.string().describe('Repository name'),
  owner: z.string().describe('Repository owner'),
  description: z.string().describe('Repository description'),
  private: z.boolean().describe('Whether repo is private'),
  url: z.string().describe('URL to the repository'),
});

// ============================================================================
// Tool Definitions
// ============================================================================

export const githubTools = defineTools({
  readFile: {
    description: 'Read the contents of a file from a GitHub repository',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      path: commonSchemas.filePath.describe('Path to the file in the repository'),
      ref: commonSchemas.gitRef.default('main')
        .describe('Branch, tag, or commit SHA (default: main)'),
    }),
    output: fileContentOutput,
  },

  createBranch: {
    description: 'Create a new branch in a GitHub repository',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      branch: commonSchemas.branch.describe('Name of the new branch'),
      from: commonSchemas.gitRef.default('main')
        .describe('Source branch to create from (default: main)'),
    }),
    output: branchOutput,
  },

  createPullRequest: {
    description: 'Create a pull request in a GitHub repository',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      title: z.string().max(500).describe('Pull request title'),
      body: z.string().max(65000).default('')
        .describe('Pull request description'),
      head: commonSchemas.branch.describe('Source branch containing the changes'),
      base: commonSchemas.gitRef.default('main')
        .describe('Target branch to merge into (default: main)'),
    }),
    output: pullRequestOutput,
    approvalRequiredFields: ['owner', 'repo', 'title', 'body', 'diff'],
  },

  listIssues: {
    description: 'List issues (not pull requests) in a GitHub repository',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      state: z.enum(['open', 'closed', 'all']).default('open')
        .describe('Filter by issue state (default: open)'),
      labels: z.string().max(500).optional()
        .describe('Comma-separated list of label names'),
      since: z.string().optional()
        .describe('Only issues created after this date (ISO 8601 format, e.g., 2025-01-16)'),
      perPage: z.coerce.number().int().min(1).max(100).default(30)
        .describe('Number of results per page (default: 30, max: 100)'),
    }),
    output: z.array(issueOutput),
  },

  listPullRequests: {
    description: 'List pull requests in a GitHub repository',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      state: z.enum(['open', 'closed', 'all']).default('open')
        .describe('Filter by PR state (default: open)'),
      since: z.string().optional()
        .describe('Only PRs created after this date (ISO 8601 format, e.g., 2025-01-16)'),
      perPage: z.coerce.number().int().min(1).max(100).default(30)
        .describe('Number of results per page (default: 30, max: 100)'),
    }),
    output: z.array(pullRequestOutput),
  },

  getIssue: {
    description: 'Get details of a specific issue by number',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      issueNumber: z.coerce.number().int().positive()
        .describe('Issue number'),
    }),
    output: issueDetailOutput,
  },

  getPullRequest: {
    description: 'Get details of a specific pull request by number',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
      pullNumber: z.coerce.number().int().positive()
        .describe('Pull request number'),
    }),
    output: prDetailOutput,
  },

  getRepository: {
    description: 'Get details of a specific repository',
    input: z.object({
      owner: commonSchemas.owner,
      repo: commonSchemas.repo,
    }),
    output: repoOutput,
  },

  listRepositories: {
    description: 'List repositories accessible to the authenticated user. Call this first to discover available repositories before using other tools.',
    input: z.object({
      type: z.enum(['all', 'owner', 'public', 'private', 'member']).default('all')
        .describe('Filter by repo type (default: all)'),
      sort: z.enum(['created', 'updated', 'pushed', 'full_name']).default('full_name')
        .describe('Sort field (default: full_name)'),
      perPage: z.coerce.number().int().min(1).max(100).default(30)
        .describe('Number of results per page (default: 30, max: 100)'),
    }),
    output: z.array(repoListItemOutput),
  },
});

// Export type for tool names
export type GitHubToolName = keyof typeof githubTools;
