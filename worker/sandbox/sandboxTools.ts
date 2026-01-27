/**
 * Sandbox MCP Tool Definitions
 *
 * Single source of truth for Sandbox tool schemas using Zod.
 * Used for both JSON Schema generation (getTools) and runtime validation (callTool).
 */

import { z } from 'zod';
import { defineTools, commonSchemas } from '../utils/zodTools';

// ============================================================================
// Output Schemas
// ============================================================================

const createSessionOutput = z.object({
  sessionId: z.string().describe('Session identifier for subsequent calls'),
  workDir: z.string().describe('Full working directory path'),
});

const runClaudeOutput = z.object({
  success: z.boolean().describe('Whether Claude completed successfully'),
  output: z.string().describe("Claude's stdout output"),
  filesModified: z.array(z.string())
    .describe('List of files that were modified'),
  exitCode: z.number().describe('Exit code from Claude CLI'),
});

const diffStatsOutput = z.object({
  files: z.number().describe('Number of files changed'),
  additions: z.number().describe('Lines added'),
  deletions: z.number().describe('Lines deleted'),
});

const getDiffOutput = z.object({
  diff: z.string().describe('Git diff output (unified format)'),
  stats: diffStatsOutput,
});

const commitOutput = z.object({
  success: z.boolean().describe('Whether commit succeeded'),
  commitHash: z.string().optional().describe('Git commit hash'),
});

const pushOutput = z.object({
  success: z.boolean().describe('Whether push succeeded'),
  ref: z.string().optional().describe('Git ref that was pushed'),
  usedFork: z.boolean().optional().describe('Whether a fork was used due to permission error'),
});

const createPullRequestOutput = z.object({
  success: z.boolean().describe('Whether PR was created'),
  prNumber: z.number().optional().describe('Pull request number'),
  prUrl: z.string().optional().describe('URL to the pull request'),
  commitHash: z.string().optional().describe('Commit hash'),
  usedFork: z.boolean().optional().describe('Whether PR was created from a fork'),
});

const readFileOutput = z.object({
  content: z.string().describe('File contents'),
});

const writeFileOutput = z.object({
  success: z.boolean().describe('Whether write succeeded'),
  bytesWritten: z.number().optional().describe('Number of bytes written'),
});

const execOutput = z.object({
  stdout: z.string().describe('Standard output'),
  stderr: z.string().describe('Standard error'),
  exitCode: z.number().describe('Command exit code'),
});

const destroySessionOutput = z.object({
  success: z.boolean().describe('Whether destruction succeeded'),
});

// ============================================================================
// Tool Definitions
// ============================================================================

// Sandbox tools are disabled in scheduled runs - those should only create child tasks
export const sandboxTools = defineTools({
  createSession: {
    description: 'Create a new sandbox session, optionally cloning a git repository. Returns a sessionId to use in subsequent calls.',
    input: z.object({
      repoUrl: z.string().max(500).optional()
        .describe('Git repository URL to clone (e.g., https://github.com/owner/repo.git). GitHub token is auto-injected.'),
      branch: z.string().max(200).default('main')
        .describe('Branch to checkout (default: main)'),
      workDir: z.string().max(200).default('repo')
        .describe('Working directory name (default: repo)'),
    }),
    output: createSessionOutput,
    disabledInScheduledRuns: true,
  },

  runClaude: {
    description: 'Execute Claude Code CLI with a task. Returns output and list of modified files. Claude will make changes but NOT commit them.',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      task: z.string().max(50000).describe('Task description for Claude to execute'),
      context: z.string().max(50000).optional()
        .describe('Additional context from previous workflow steps'),
      systemPrompt: z.string().max(10000).optional()
        .describe('Optional system prompt override'),
      timeout: z.coerce.number().int().min(30).max(1800).default(600)
        .describe('Timeout in seconds (default: 600)'),
    }),
    output: runClaudeOutput,
    disabledInScheduledRuns: true,
  },

  getDiff: {
    description: 'Get the git diff of uncommitted changes in the sandbox',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      staged: z.boolean().default(false)
        .describe('Get only staged changes (default: false, gets all changes)'),
    }),
    output: getDiffOutput,
    disabledInScheduledRuns: true,
  },

  commit: {
    description: 'Commit current changes with a message',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      message: z.string().max(5000).describe('Commit message'),
    }),
    output: commitOutput,
    disabledInScheduledRuns: true,
  },

  push: {
    description: 'Push commits to the remote repository',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      remote: z.string().max(100).default('origin')
        .describe('Remote name (default: origin)'),
      branch: z.string().max(200).optional()
        .describe('Branch name to push'),
    }),
    output: pushOutput,
    hidden: true, // Internal only - agents should use createPullRequest
    disabledInScheduledRuns: true,
  },

  createPullRequest: {
    description: 'Create a pull request with the current sandbox changes. Handles commit, push, and PR creation in one step. IMPORTANT: Get the diff first using getDiff and request approval before calling this tool.',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      title: z.string().max(500).describe('Pull request title'),
      body: z.string().max(65000).default('')
        .describe('Pull request description (markdown supported)'),
      branch: z.string().max(200)
        .describe('Feature branch name to create (e.g., "feature/add-login")'),
      base: z.string().max(200).default('main')
        .describe('Target branch to merge into (default: main)'),
      commitMessage: z.string().max(5000)
        .describe('Commit message for the changes'),
      diff: z.string().max(500000)
        .describe('The diff from getDiff - required for approval review'),
    }),
    output: createPullRequestOutput,
    approvalRequiredFields: ['title', 'body', 'diff', 'branch'],
    requiresApproval: true,
    disabledInScheduledRuns: true,
  },

  readFile: {
    description: 'Read a file from the sandbox',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      path: commonSchemas.sandboxPath.describe('File path relative to working directory'),
    }),
    output: readFileOutput,
    disabledInScheduledRuns: true,
  },

  writeFile: {
    description: 'Write content to a file in the sandbox',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      path: commonSchemas.sandboxPath.describe('File path relative to working directory'),
      content: z.string().max(1000000).describe('Content to write'),
    }),
    output: writeFileOutput,
    disabledInScheduledRuns: true,
  },

  exec: {
    description: 'Execute a shell command in the sandbox',
    input: z.object({
      sessionId: commonSchemas.sessionId,
      command: z.string().max(10000).describe('Command to execute'),
      cwd: z.string().max(500).optional()
        .describe('Working directory for command (relative to session workDir)'),
      timeout: z.coerce.number().int().min(1).max(300).default(60)
        .describe('Timeout in seconds (default: 60)'),
    }),
    output: execOutput,
    disabledInScheduledRuns: true,
  },

  destroySession: {
    description: 'Cleanup and destroy a sandbox session',
    input: z.object({
      sessionId: commonSchemas.sessionId,
    }),
    output: destroySessionOutput,
    disabledInScheduledRuns: true,
  },
});

// Export type for tool names
export type SandboxToolName = keyof typeof sandboxTools;
