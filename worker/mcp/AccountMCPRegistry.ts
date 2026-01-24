/**
 * AccountMCPRegistry - Pluggable registry for accounts with multiple MCPs
 *
 * Defines accounts (Google, future: Microsoft, etc.) and their associated MCPs.
 * Makes adding new account integrations straightforward.
 *
 * Used by:
 * - Board settings UI (which MCPs to enable)
 * - AgentWorkflow (tool execution and credential management)
 */

import { HostedMCPServer, type MCPToolSchema } from './MCPClient';
import { GmailMCPServer } from '../google/GmailMCP';
import { DocsMCPServer } from '../google/DocsMCP';
import { SheetsMCPServer } from '../google/SheetsMCP';
import { SandboxMCPServer } from '../sandbox/SandboxMCP';
import { GitHubMCPServer } from '../github/GitHubMCP';
import { refreshAccessToken } from '../google/oauth';
import { CREDENTIAL_TYPES } from '../constants';
import type { Sandbox } from '@cloudflare/sandbox';

// ============================================================================
// Types
// ============================================================================

/** How authentication is handled for this account */
export type CredentialAuthType = 'oauth' | 'api_key' | 'env_binding' | 'none';

/** Artifact types that can be created by MCP tools */
export type ArtifactType = 'google_doc' | 'google_sheet' | 'gmail_message' | 'github_pr' | 'file' | 'other';

/** URL pattern types for link enrichment */
export type UrlPatternType = 'google_doc' | 'google_sheet' | 'github_pr' | 'github_issue' | 'github_repo';

/** URL pattern definition for link pills */
export interface MCPUrlPattern {
  /** Regex pattern to match URLs */
  pattern: string;
  /** Type of resource this pattern matches */
  type: UrlPatternType;
  /** Tool name to call for fetching metadata */
  fetchTool: string;
}

/** Environment bindings that may be needed by MCP factories */
export interface MCPEnvBindings {
  Sandbox?: DurableObjectNamespace<Sandbox>;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  [key: string]: unknown;
}

/** Credentials passed to factories and refresh functions */
export interface MCPCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  apiKey?: string;
  [key: string]: unknown;
}

/**
 * Definition for an individual MCP within an account
 */
export interface MCPDefinition {
  /** Unique identifier for the MCP (e.g., 'gmail', 'google-docs') */
  id: string;
  /** Display name (e.g., 'Gmail', 'Google Docs') */
  name: string;
  /** Server name used in tool names (e.g., 'Gmail', 'Google_Docs' for 'Gmail__sendMessage') */
  serverName: string;
  /** Short description of what this MCP does */
  description: string;
  /** Factory function to create the MCP server instance */
  factory: (credentials: MCPCredentials, env?: MCPEnvBindings) => HostedMCPServer;
  /** Type of artifact this MCP produces (for UI display) */
  artifactType?: ArtifactType;
  /**
   * How artifact content is stored:
   * - 'url': External link (default) - artifact has url field
   * - 'inline': Content stored in artifact - artifact has content field
   */
  artifactContentType?: 'url' | 'inline';
  /** URL patterns this MCP can enrich for link pills */
  urlPatterns?: MCPUrlPattern[];
  /**
   * Workflow guidance for the agent system prompt.
   * Explains how to use this MCP's tools effectively.
   * This is injected into the agent's system prompt when the MCP is enabled.
   */
  workflowGuidance?: string;
}

/**
 * Definition for an account that has multiple MCPs
 */
export interface AccountDefinition {
  /** Unique identifier for the account (e.g., 'google', 'microsoft') */
  id: string;
  /** Display name (e.g., 'Google', 'Microsoft') */
  name: string;
  /** The credential type used for this account (e.g., 'google_oauth') */
  credentialType: string;
  /** How authentication is handled */
  authType: CredentialAuthType;
  /** Icon identifier for the account */
  icon?: string;
  /** MCPs available for this account */
  mcps: MCPDefinition[];
  /**
   * Token refresh function for OAuth accounts.
   * Returns new access token and optional expiry.
   */
  refreshToken?: (
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ) => Promise<{ access_token: string; expires_in?: number }>;
  /**
   * If true, this account's MCPs are always available (injected automatically).
   * Used for system MCPs like Sandbox that don't require user configuration.
   */
  alwaysEnabled?: boolean;
  /**
   * Environment binding keys required by this account's MCPs.
   * These are passed from the workflow env to the MCP factory.
   * Example: ['SANDBOX'] for Sandbox MCP, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] for Google
   */
  envBindingKeys?: string[];
  /**
   * Additional credential keys to pass to MCP factories beyond the main accessToken.
   * Example: ['githubToken', 'anthropicApiKey'] for Sandbox MCP
   */
  additionalCredentialKeys?: string[];
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Registry of all accounts with multiple MCPs
 *
 * To add a new account:
 * 1. Create MCP server classes extending HostedMCPServer
 * 2. Add a new AccountDefinition to this array
 * 3. Implement OAuth flow in worker/index.ts (if needed)
 */
// ============================================================================
// Workflow Guidance Templates
// These are injected into the agent's system prompt when the MCP is enabled.
// ============================================================================

const GMAIL_GUIDANCE = `## Gmail Workflow
Always request approval before sending emails.

**Sending an email:**
\`\`\`
request_approval({
  tool: "Gmail__sendEmail",
  action: "Send Email",
  data: {
    to: "recipient@example.com",
    subject: "Email Subject",
    body: "Email body content..."
  }
})
\`\`\`
After approval, call: \`Gmail__sendEmail({ to: "...", subject: "...", body: "..." })\``;

const GOOGLE_DOCS_GUIDANCE = `## Google Docs Workflow

**Creating a new document:**
\`\`\`
request_approval({
  tool: "Google_Docs__createDocument",
  action: "Create Document",
  data: {
    title: "Document Title",
    content: "The full document content to create..."
  }
})
\`\`\`
After approval, call: \`Google_Docs__createDocument({ title: "...", content: "..." })\`

**Modifying existing documents (append or replace):**
1. **Get current content first**:
   \`\`\`
   Google_Docs__getDocument({ documentId: "..." })
   \`\`\`
2. **Request approval with both old and new content**:
   \`\`\`
   request_approval({
     tool: "Google_Docs__replaceDocumentContent",  // or appendToDocument
     action: "Replace Document Content",
     data: {
       documentId: "...",
       title: "Document Title",
       currentContent: "<content from getDocument>",
       newContent: "<the new content to write>",
       action: "replace"  // or "append"
     }
   })
   \`\`\`
3. **After approval**, call the actual tool:
   \`\`\`
   Google_Docs__replaceDocumentContent({ documentId: "...", content: "..." })
   \`\`\``;

const GOOGLE_SHEETS_GUIDANCE = `## Google Sheets Workflow
For creating or modifying spreadsheets, ALWAYS request approval first.

**Creating a new spreadsheet:**
\`\`\`
request_approval({
  tool: "Google_Sheets__createSpreadsheet",
  action: "Create Spreadsheet",
  data: {
    title: "Spreadsheet Title",
    rows: [
      ["Column 1", "Column 2", "Column 3"],  // Header row
      ["Value 1", "Value 2", "Value 3"],     // Data rows
    ]
  }
})
\`\`\`

**Modifying an existing spreadsheet (append/update/replace):**
1. First search/get the spreadsheet to get its title
2. Get current data: \`Google_Sheets__getSheetData({ spreadsheetId: "...", range: "Sheet1" })\`
3. Request approval - CRITICAL: You MUST include both currentRows AND title:
\`\`\`
request_approval({
  tool: "Google_Sheets__appendRows",  // or updateCells, replaceSheetContent
  action: "Append Rows to Spreadsheet",
  data: {
    spreadsheetId: "...",
    title: "ACTUAL spreadsheet title from search",  // REQUIRED - use real title!
    currentRows: [[...], [...], ...],  // REQUIRED - copy the rows array from getSheetData result
    newRows: [[...], [...], ...]       // the new rows to add
  }
})
\`\`\`

IMPORTANT for approval to show diff correctly:
- \`title\` must be the actual spreadsheet title (not "Spreadsheet Title")
- \`currentRows\` must contain the actual current data from getSheetData (the \`rows\` array)
- \`newRows\` contains only the NEW rows being added

After approval, call the actual tool with the approved data.`;

const SANDBOX_GUIDANCE = `## Code Change Workflow (Sandbox)
For ANY task requiring code changes, you MUST use Sandbox. Here's the flow:

1. **Clone the repository**:
   \`\`\`
   Sandbox__createSession({ repoUrl: "https://github.com/owner/repo.git", branch: "main" })
   \`\`\`
   This returns a sessionId you'll use for all subsequent calls.

2. **Make changes** - Use runClaude to let Claude Code make the edits:
   \`\`\`
   Sandbox__runClaude({ sessionId: "...", task: "description of what to change" })
   \`\`\`

3. **Get the diff** - REQUIRED before approval:
   \`\`\`
   Sandbox__getDiff({ sessionId: "..." })
   \`\`\`
   This returns \`structuredContent.diff\` (unified diff) and \`structuredContent.stats\`.

4. **Request PR approval** - Include the diff from step 3:
   \`\`\`
   request_approval({
     tool: "Sandbox__createPullRequest",
     action: "Create Pull Request",
     data: {
       title: "PR title",
       body: "PR description",
       branch: "feature/descriptive-branch-name",
       diff: structuredContent.diff  // REQUIRED: extract from getDiff result
     }
   })
   \`\`\`

5. **After user approval** - Create the PR (handles commit + push + PR creation):
   \`\`\`
   Sandbox__createPullRequest({
     sessionId,
     title: "PR title",
     body: "PR description",
     branch: "feature/descriptive-branch-name",
     base: "main",
     commitMessage: "commit message",
     diff: structuredContent.diff
   })
   \`\`\`

IMPORTANT RULES:
- createSession requires repoUrl parameter
- ALWAYS call getDiff before requesting approval
- Include the diff in both the approval request AND the createPullRequest call
- createPullRequest handles everything: creates branch, commits, pushes, creates PR`;

const GITHUB_GUIDANCE = `## GitHub Workflow
Use GitHub tools to read repository information, issues, and pull requests.
For creating PRs with code changes, use Sandbox to make the changes first.

**Reading repository info:**
\`\`\`
GitHub__getRepository({ owner: "...", repo: "..." })
GitHub__listIssues({ owner: "...", repo: "...", state: "open" })
GitHub__getPullRequest({ owner: "...", repo: "...", pullNumber: 123 })
\`\`\``;

// ============================================================================
// Registry
// ============================================================================

export const ACCOUNT_REGISTRY: AccountDefinition[] = [
  {
    id: 'google',
    name: 'Google',
    credentialType: CREDENTIAL_TYPES.GOOGLE_OAUTH,
    authType: 'oauth',
    icon: 'google',
    refreshToken: refreshAccessToken,
    envBindingKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    mcps: [
      {
        id: 'gmail',
        name: 'Gmail',
        serverName: 'Gmail',
        description: 'Read, send, and search emails',
        factory: (creds) => new GmailMCPServer(creds.accessToken || ''),
        artifactType: 'gmail_message',
        artifactContentType: 'inline',
        workflowGuidance: GMAIL_GUIDANCE,
      },
      {
        id: 'google-docs',
        name: 'Google Docs',
        serverName: 'Google_Docs',
        description: 'Create and edit documents',
        factory: (creds) => new DocsMCPServer(creds.accessToken || ''),
        artifactType: 'google_doc',
        urlPatterns: [{
          pattern: 'docs\\.google\\.com/document/d/([a-zA-Z0-9_-]+)',
          type: 'google_doc',
          fetchTool: 'getDocument',
        }],
        workflowGuidance: GOOGLE_DOCS_GUIDANCE,
      },
      {
        id: 'google-sheets',
        name: 'Google Sheets',
        serverName: 'Google_Sheets',
        description: 'Create and edit spreadsheets',
        factory: (creds) => new SheetsMCPServer(creds.accessToken || ''),
        artifactType: 'google_sheet',
        urlPatterns: [{
          pattern: 'docs\\.google\\.com/spreadsheets/d/([a-zA-Z0-9_-]+)',
          type: 'google_sheet',
          fetchTool: 'getSpreadsheet',
        }],
        workflowGuidance: GOOGLE_SHEETS_GUIDANCE,
      },
    ],
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    credentialType: 'none',
    authType: 'env_binding',
    alwaysEnabled: true,
    envBindingKeys: ['SANDBOX'],
    additionalCredentialKeys: ['githubToken', 'anthropicApiKey'],
    mcps: [
      {
        id: 'sandbox',
        name: 'Sandbox',
        serverName: 'Sandbox',
        description: 'Execute code in isolated environment',
        factory: (creds, env) => new SandboxMCPServer(
          env?.SANDBOX as DurableObjectNamespace<Sandbox>,
          {
            githubToken: creds.githubToken as string | undefined,
            anthropicApiKey: creds.anthropicApiKey as string | undefined,
          }
        ),
        workflowGuidance: SANDBOX_GUIDANCE,
        artifactType: 'github_pr',
      },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    credentialType: CREDENTIAL_TYPES.GITHUB_OAUTH,
    authType: 'oauth',
    icon: 'github',
    // GitHub tokens don't expire, so no refreshToken needed
    mcps: [
      {
        id: 'github',
        name: 'GitHub',
        serverName: 'GitHub',
        description: 'Manage repositories, issues, and pull requests',
        factory: (creds) => new GitHubMCPServer(creds.accessToken || ''),
        artifactType: 'github_pr',
        urlPatterns: [
          {
            pattern: 'github\\.com/([^/]+)/([^/]+)/pull/(\\d+)',
            type: 'github_pr',
            fetchTool: 'getPullRequest',
          },
          {
            pattern: 'github\\.com/([^/]+)/([^/]+)/issues/(\\d+)',
            type: 'github_issue',
            fetchTool: 'getIssue',
          },
          {
            // Match repo URLs but exclude PR/issue/blob/tree paths
            pattern: 'github\\.com/([^/]+)/([^/]+)/?$',
            type: 'github_repo',
            fetchTool: 'getRepository',
          },
        ],
        workflowGuidance: GITHUB_GUIDANCE,
      },
    ],
  },
];

/**
 * Get an account definition by its ID
 */
export function getAccountById(id: string): AccountDefinition | undefined {
  return ACCOUNT_REGISTRY.find((a) => a.id === id);
}

/**
 * Get an account definition by its credential type
 */
export function getAccountByCredentialType(credentialType: string): AccountDefinition | undefined {
  return ACCOUNT_REGISTRY.find((a) => a.credentialType === credentialType);
}

/**
 * Get all MCPs for an account by account ID
 */
export function getMCPsForAccount(accountId: string): MCPDefinition[] {
  return getAccountById(accountId)?.mcps ?? [];
}

/**
 * Get a specific MCP definition by account ID and MCP ID
 */
export function getMCPDefinition(accountId: string, mcpId: string): MCPDefinition | undefined {
  const account = getAccountById(accountId);
  return account?.mcps.find((m) => m.id === mcpId);
}

/**
 * Find which account an MCP belongs to by MCP name
 */
export function getAccountForMCPName(mcpName: string): AccountDefinition | undefined {
  return ACCOUNT_REGISTRY.find((account) =>
    account.mcps.some((mcp) => mcp.name === mcpName)
  );
}

/**
 * Get an MCP definition by its display name
 */
export function getMCPByName(mcpName: string): MCPDefinition | undefined {
  for (const account of ACCOUNT_REGISTRY) {
    const mcp = account.mcps.find((m) => m.name === mcpName);
    if (mcp) return mcp;
  }
  return undefined;
}

/**
 * Get MCP and its parent account by server name (e.g., 'Gmail', 'Google_Docs')
 * Used by AgentWorkflow to look up MCPs when executing tools
 */
export function getMCPByServerName(serverName: string): {
  account: AccountDefinition;
  mcp: MCPDefinition;
} | undefined {
  for (const account of ACCOUNT_REGISTRY) {
    const mcp = account.mcps.find((m) => m.serverName === serverName);
    if (mcp) {
      return { account, mcp };
    }
  }
  return undefined;
}

/**
 * Get credential requirements for a list of server names
 * Returns unique credential types needed (excluding 'none')
 */
export function getCredentialRequirements(serverNames: string[]): Array<{
  credentialType: string;
  authType: CredentialAuthType;
  accountId: string;
}> {
  const seen = new Set<string>();
  const requirements: Array<{
    credentialType: string;
    authType: CredentialAuthType;
    accountId: string;
  }> = [];

  for (const serverName of serverNames) {
    const lookup = getMCPByServerName(serverName);
    if (lookup && lookup.account.credentialType !== 'none' && !seen.has(lookup.account.credentialType)) {
      seen.add(lookup.account.credentialType);
      requirements.push({
        credentialType: lookup.account.credentialType,
        authType: lookup.account.authType,
        accountId: lookup.account.id,
      });
    }
  }

  return requirements;
}

/**
 * Get all account IDs
 */
export function getAllAccountIds(): string[] {
  return ACCOUNT_REGISTRY.map((a) => a.id);
}

/**
 * Check if a credential type belongs to a registered account
 */
export function isAccountCredentialType(credentialType: string): boolean {
  return ACCOUNT_REGISTRY.some((a) => a.credentialType === credentialType);
}

/**
 * Get tools for an MCP by creating a temporary instance
 * Useful for caching tools without needing a real token
 */
export function getMCPTools(accountId: string, mcpId: string): MCPToolSchema[] {
  const mcp = getMCPDefinition(accountId, mcpId);
  if (!mcp) return [];
  // Create instance with empty credentials just to get tool schemas
  const instance = mcp.factory({});
  return instance.getTools();
}

/**
 * Get all accounts that are always enabled (system MCPs like Sandbox)
 */
export function getAlwaysEnabledAccounts(): AccountDefinition[] {
  return ACCOUNT_REGISTRY.filter((a) => a.alwaysEnabled);
}

/**
 * Get all accounts that require OAuth credentials
 */
export function getOAuthAccounts(): AccountDefinition[] {
  return ACCOUNT_REGISTRY.filter((a) => a.authType === 'oauth');
}

/**
 * Get workflow guidance for a list of enabled MCP server names
 * Returns concatenated guidance sections for the agent system prompt
 */
export function getWorkflowGuidance(serverNames: string[]): string {
  const guidanceSections: string[] = [];
  const seen = new Set<string>();

  for (const serverName of serverNames) {
    const lookup = getMCPByServerName(serverName);
    if (lookup?.mcp.workflowGuidance && !seen.has(lookup.mcp.id)) {
      seen.add(lookup.mcp.id);
      guidanceSections.push(lookup.mcp.workflowGuidance);
    }
  }

  return guidanceSections.join('\n\n');
}

/**
 * Get all required env binding keys for enabled accounts
 * Used to build the env bindings object for MCP factories
 */
export function getRequiredEnvBindingKeys(serverNames: string[]): string[] {
  const keys = new Set<string>();

  for (const serverName of serverNames) {
    const lookup = getMCPByServerName(serverName);
    if (lookup?.account.envBindingKeys) {
      for (const key of lookup.account.envBindingKeys) {
        keys.add(key);
      }
    }
  }

  return Array.from(keys);
}

/**
 * Get additional credential keys needed for enabled accounts
 * Used to pass extra credentials (like githubToken) to MCP factories
 */
export function getAdditionalCredentialKeys(serverNames: string[]): string[] {
  const keys = new Set<string>();

  for (const serverName of serverNames) {
    const lookup = getMCPByServerName(serverName);
    if (lookup?.account.additionalCredentialKeys) {
      for (const key of lookup.account.additionalCredentialKeys) {
        keys.add(key);
      }
    }
  }

  return Array.from(keys);
}

/**
 * Get credential type for a URL pattern type.
 * Finds which account's MCP has this pattern and returns that account's credentialType.
 */
export function getCredentialTypeForUrlPattern(patternType: UrlPatternType): string | undefined {
  for (const account of ACCOUNT_REGISTRY) {
    for (const mcp of account.mcps) {
      if (mcp.urlPatterns?.some(p => p.type === patternType)) {
        return account.credentialType;
      }
    }
  }
  return undefined;
}
