/**
 * Approval View Registry
 *
 * Maps MCP tool names to specialized approval view components.
 * This allows different tools to have tool-specific approval UIs.
 */

import { DefaultApproval } from './DefaultApproval';
import { EmailApproval } from './EmailApproval';
import { GitHubPRApproval } from './GitHubPRApproval';
import { GoogleDocsApproval } from './GoogleDocsApproval';
import { GoogleSheetsApproval } from './GoogleSheetsApproval';

/**
 * Props passed to all approval view components
 */
export interface ApprovalViewProps {
  tool: string;
  action: string;
  data: Record<string, unknown>;
  onApprove: (responseData?: Record<string, unknown>) => void;
  onRequestChanges: (feedback: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}

type ApprovalViewComponent = React.FC<ApprovalViewProps>;

/**
 * Registry mapping tool names to their approval view components
 */
const APPROVAL_VIEW_REGISTRY: Record<string, ApprovalViewComponent> = {
  'GitHub__createPullRequest': GitHubPRApproval,
  'GitHub__create_pr': GitHubPRApproval, // legacy compat
  'Sandbox__createPullRequest': GitHubPRApproval,
  'Gmail__sendEmail': EmailApproval,
  'Gmail__createDraft': EmailApproval,
  'Google_Docs__createDocument': GoogleDocsApproval,
  'Google_Docs__appendToDocument': GoogleDocsApproval,
  'Google_Docs__replaceDocumentContent': GoogleDocsApproval,
  'Google_Sheets__createSpreadsheet': GoogleSheetsApproval,
  'Google_Sheets__appendRows': GoogleSheetsApproval,
  'Google_Sheets__updateCells': GoogleSheetsApproval,
  'Google_Sheets__replaceSheetContent': GoogleSheetsApproval,
};

/**
 * Get the approval view component for a given tool name
 * Falls back to DefaultApproval if no specialized view exists
 */
export function getApprovalView(toolName: string): ApprovalViewComponent {
  return APPROVAL_VIEW_REGISTRY[toolName] || DefaultApproval;
}
