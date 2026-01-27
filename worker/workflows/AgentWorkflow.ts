/**
 * AgentWorkflow - Dynamic agent-driven workflow execution
 *
 * Runs a Claude agent loop that dynamically creates steps as it reasons
 * through the task. Each agent turn and tool call becomes a durable step.
 *
 * Key features:
 * - No upfront code generation - agent reasons step-by-step
 * - Dynamic step creation with real-time UI updates
 * - Streaming responses via WebSocket
 * - Agent-initiated approvals via special tool
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlock, ToolUseBlock, TextBlock, Tool } from '@anthropic-ai/sdk/resources/messages';
import {
  getMCPByServerName,
  getMCPTools,
  getAlwaysEnabledAccounts,
  getOAuthAccounts,
  getWorkflowGuidance,
  type MCPCredentials,
  type MCPEnvBindings,
  type AccountDefinition,
} from '../mcp/AccountMCPRegistry';
import { MCPClient, type MCPServerConfig } from '../mcp/MCPClient';
import { logger } from '../utils/logger';
import type { BoardDO } from '../BoardDO';

// Constants
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// Workflow parameters
export interface AgentWorkflowParams {
  planId: string;
  taskId: string;
  boardId: string;
  taskDescription: string;
  anthropicApiKey: string;
  // Scheduled run parameters (optional)
  isScheduledRun?: boolean;
  runId?: string;
  targetColumnId?: string;
  parentTaskId?: string;
  // Time context for scheduled runs
  currentTime?: string;   // ISO timestamp of when this run started
  lastRunAt?: string;     // ISO timestamp of when the last run completed (null if first run)
  scheduleTimezone?: string; // Timezone for the schedule (e.g., "America/Los_Angeles")
}

// Event sent to resume from checkpoint
export interface CheckpointEvent {
  action: 'approve' | 'request_changes' | 'cancel';
  feedback?: string;
  // User-edited data from approval form (e.g., PR title/body), passed as JSON string for serialization
  dataJson?: string;
}

// Extended Env with workflow bindings
// Uses index signature for dynamic MCP env bindings (Sandbox, GOOGLE_CLIENT_ID, etc.)
interface WorkflowEnv {
  BOARD_DO: DurableObjectNamespace;
  AGENT_WORKFLOW: Workflow;
  [key: string]: unknown;
}

// Step type for UI display
interface AgentStep {
  id: string;
  name: string;
  type: 'agent' | 'tool' | 'approval';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_approval';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: unknown;
  error?: string;
  // For agent steps
  thinking?: string;
  // For tool steps
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  // For approval steps
  approvalMessage?: string;
  approvalData?: unknown;
}

// Artifact created during execution
interface WorkflowArtifact {
  type: 'google_doc' | 'google_sheet' | 'gmail_message' | 'github_pr' | 'file' | 'other';
  url?: string;
  title?: string;
  description?: string;
  // Email content for inline viewing (gmail_message type)
  content?: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
    sentAt?: string;
  };
}

// MCP tool info for loading
interface MCPServerInfo {
  id: string;
  name: string;
  type: 'remote' | 'hosted';
  endpoint?: string;
  authType: string;
  transportType?: 'streamable-http' | 'sse';
  credentialId?: string;
  accessToken?: string; // OAuth access token for remote servers
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    approvalRequiredFields?: string[];
    requiresApproval?: boolean;
    disabledInScheduledRuns?: boolean;
  }>;
}

// Store for all credentials during workflow execution
interface CredentialStore {
  googleToken?: string;
  googleRefreshToken?: string;
  googleTokenExpiresAt?: string;
  githubToken?: string;
  anthropicApiKey?: string;
  // Index signature for dynamic credential types
  [key: string]: string | undefined;
}

/**
 * Convert internal tool name to user-friendly display name
 * e.g. "Google_Docs__createDocument" -> "Create Document"
 */
function formatToolName(toolName: string): string {
  // Split server__method format
  const parts = toolName.split('__');
  const method = parts.length > 1 ? parts[1] : toolName;

  // Convert camelCase to Title Case with spaces
  return method
    .replace(/([A-Z])/g, ' $1') // Add space before capitals
    .replace(/^./, (str) => str.toUpperCase()) // Capitalize first letter
    .trim();
}

export class AgentWorkflow extends WorkflowEntrypoint<WorkflowEnv, AgentWorkflowParams> {
  async run(event: WorkflowEvent<AgentWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const { planId, boardId, taskDescription, anthropicApiKey } = params;
    // Scheduled run parameters
    const isScheduledRun = params.isScheduledRun ?? false;
    const runId = params.runId;
    const targetColumnId = params.targetColumnId;
    const parentTaskId = params.parentTaskId ?? params.taskId;
    // Time context for scheduled runs
    const currentTime = params.currentTime;
    const lastRunAt = params.lastRunAt;
    const scheduleTimezone = params.scheduleTimezone;

    const getBoardStub = (): DurableObjectStub<BoardDO> => {
      const doId = this.env.BOARD_DO.idFromName(boardId);
      return this.env.BOARD_DO.get(doId) as DurableObjectStub<BoardDO>;
    };

    const updatePlan = async (data: Record<string, unknown>) => {
      const stub = getBoardStub();
      await stub.updateWorkflowPlan(planId, data);
    };

    const addLog = async (level: string, message: string, stepId?: string, metadata?: object) => {
      const stub = getBoardStub();
      stub.addWorkflowLog(planId, level, message, stepId, metadata);
    };

    const broadcastStreamChunk = async (turnIndex: number, text: string) => {
      const stub = getBoardStub();
      stub.broadcastStreamChunk(boardId, planId, turnIndex, text);
    };

    try {
      const mcpConfigJson = await step.do('load-mcp-config', async () => {
        const stub = getBoardStub();

        const rawServers = await stub.getMCPServers(boardId);
        const enabledServers = rawServers.filter((s: { enabled: boolean }) => s.enabled);

        const servers: MCPServerInfo[] = [];
        for (const server of enabledServers) {
          const tools = await stub.getMCPServerTools(server.id);

          let accessToken: string | undefined;
          if (server.type === 'remote' && server.authType === 'oauth' && server.credentialId) {
            const credData = await stub.getCredentialById(boardId, server.credentialId);
            if (credData) {
              accessToken = credData.value;
            }
          }

          servers.push({
            id: server.id,
            name: server.name,
            type: server.type as 'remote' | 'hosted',
            endpoint: server.endpoint || undefined,
            authType: server.authType,
            transportType: server.transportType as 'streamable-http' | 'sse' | undefined,
            credentialId: server.credentialId || undefined,
            accessToken,
            tools: tools.map((t: { name: string; description?: string | null; inputSchema: object; approvalRequiredFields?: string[] | null; requiresApproval?: boolean | null }) => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.inputSchema as Record<string, unknown>,
              approvalRequiredFields: t.approvalRequiredFields || undefined,
              requiresApproval: t.requiresApproval || undefined,
            })),
          });
        }

        for (const account of getAlwaysEnabledAccounts()) {
          for (const mcp of account.mcps) {
            const tools = getMCPTools(account.id, mcp.id);
            servers.push({
              id: `${account.id}-builtin`,
              name: mcp.name,
              type: 'hosted',
              authType: account.authType,
              tools: tools.map(t => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema as unknown as Record<string, unknown>,
                approvalRequiredFields: t.approvalRequiredFields || undefined,
                requiresApproval: t.requiresApproval || undefined,
              })),
            });
          }
        }

        const credentials: Record<string, string | undefined> = {
          anthropicApiKey,
        };

        for (const account of getOAuthAccounts()) {
          const credData = await stub.getCredentialFull(boardId, account.credentialType);

          const tokenKey = `${account.id}Token`;
          let accessToken = credData?.value;

          if (credData?.metadata && account.refreshToken) {
            try {
              const metadata = credData.metadata as Record<string, unknown>;
              if (metadata.refresh_token) {
                const needsRefresh = !metadata.expires_at ||
                  Date.now() > new Date(metadata.expires_at as string).getTime() - TOKEN_REFRESH_BUFFER_MS;

                if (needsRefresh) {
                  logger.workflow.info('Refreshing token', { account: account.id });

                  const clientIdKey = `${account.id.toUpperCase()}_CLIENT_ID`;
                  const clientSecretKey = `${account.id.toUpperCase()}_CLIENT_SECRET`;
                  const clientId = (this.env as Record<string, unknown>)[clientIdKey] as string | undefined;
                  const clientSecret = (this.env as Record<string, unknown>)[clientSecretKey] as string | undefined;

                  if (clientId && clientSecret) {
                    const newTokenData = await account.refreshToken(
                      metadata.refresh_token as string,
                      clientId,
                      clientSecret
                    );
                    accessToken = newTokenData.access_token;

                    const newExpiresAt = new Date(
                      Date.now() + (newTokenData.expires_in || 3600) * 1000
                    ).toISOString();

                    await stub.updateCredentialValue(boardId, account.credentialType, newTokenData.access_token, { expires_at: newExpiresAt });

                    credentials[`${account.id}RefreshToken`] = metadata.refresh_token as string;
                    credentials[`${account.id}TokenExpiresAt`] = newExpiresAt;
                  }
                } else {
                  credentials[`${account.id}RefreshToken`] = metadata.refresh_token as string;
                  credentials[`${account.id}TokenExpiresAt`] = metadata.expires_at as string;
                }
              }
            } catch (e) {
              logger.workflow.error('Token refresh error', { account: account.id, error: e instanceof Error ? e.message : String(e) });
            }
          }

          credentials[tokenKey] = accessToken;
        }

        return JSON.stringify({
          servers,
          credentials,
        });
      });

      const mcpConfig = JSON.parse(mcpConfigJson) as {
        servers: MCPServerInfo[];
        credentials: CredentialStore;
      };

      const claudeTools = this.buildClaudeTools(mcpConfig.servers, isScheduledRun);
      const systemPrompt = this.buildSystemPrompt(mcpConfig.servers, isScheduledRun, {
        currentTime,
        lastRunAt,
        scheduleTimezone,
      });
      const messages: MessageParam[] = [
        { role: 'user', content: taskDescription },
      ];

      const steps: AgentStep[] = [];
      const artifacts: WorkflowArtifact[] = [];
      let turnIndex = 0;
      let done = false;
      let childTasksCreated = 0; // Track child tasks for scheduled runs
      const childTaskTitles: string[] = []; // Track titles for summary
      const childTasksInfo: Array<{ id: string; title: string }> = [];
      const approvedTools = new Set<string>();

      while (!done && turnIndex < 50) {
        const currentTurnIndex = turnIndex;

        const turnResultJson = await step.do(`turn-${currentTurnIndex}`, async () => {
          if (currentTurnIndex === 0) {
            await updatePlan({
              status: 'executing',
              steps: [],
            });
            await addLog('info', 'Agent started working on task');
          }

          const client = new Anthropic({ apiKey: mcpConfig.credentials.anthropicApiKey });

          const stream = client.messages.stream({
            model: DEFAULT_MODEL,
            max_tokens: 8192,
            system: systemPrompt,
            messages,
            tools: claudeTools,
          });

          stream.on('text', async (text) => {
            broadcastStreamChunk(currentTurnIndex, text).catch((e) =>
              logger.workflow.error('Stream broadcast failed', { error: e instanceof Error ? e.message : String(e) })
            );
          });

          const finalMessage = await stream.finalMessage();

          const textContent = finalMessage.content
            .filter((block): block is TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('\n');

          const agentStep: AgentStep = {
            id: `turn-${currentTurnIndex}`,
            name: textContent.length > 50 ? textContent.substring(0, 50) + '...' : (textContent || 'Thinking...'),
            type: 'agent',
            status: 'completed',
            completedAt: new Date().toISOString(),
            thinking: textContent,
          };

          return JSON.stringify({
            response: {
              id: finalMessage.id,
              role: finalMessage.role,
              content: finalMessage.content,
              stop_reason: finalMessage.stop_reason,
              usage: finalMessage.usage,
            },
            agentStep,
            textContent,
          });
        });

        const turnResult = JSON.parse(turnResultJson) as {
          response: {
            id: string;
            role: 'assistant';
            content: ContentBlock[];
            stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
            usage: { input_tokens: number; output_tokens: number };
          };
          agentStep: AgentStep;
          textContent: string;
        };

        const { response, agentStep, textContent } = turnResult;
        steps.push(agentStep);

        // Fire-and-forget to avoid extra checkpoint
        updatePlan({ steps: [...steps] }).catch((e) =>
          logger.workflow.error('Plan update failed', { error: e instanceof Error ? e.message : String(e) })
        );
        if (textContent) {
          const truncated = textContent.length > 1500 ? textContent.substring(0, 1500) + '...' : textContent;
          addLog('info', truncated, agentStep.id).catch(() => {});
        }

        messages.push({ role: 'assistant', content: response.content });

        const toolUses = response.content.filter(
          (block): block is ToolUseBlock => block.type === 'tool_use'
        );

        if (toolUses.length > 0) {
          const toolResults: Array<{
            type: 'tool_result';
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }> = [];

          for (const toolUse of toolUses) {
            const toolStepId = `tool-${currentTurnIndex}-${toolUse.id}`;

            if (toolUse.name === 'request_approval') {
              // Handle approval request
              const approvalArgs = toolUse.input as {
                tool: string;
                action: string;
                data: Record<string, unknown>;
              };

              // Validate required fields from tool metadata
              // Tool name format: "ServerName__methodName"
              const [serverName, methodName] = approvalArgs.tool.split('__');
              const matchingServer = mcpConfig.servers.find((s: MCPServerInfo) => s.name.replace(/\s+/g, '_') === serverName);
              const matchingTool = matchingServer?.tools.find((t: { name: string; approvalRequiredFields?: string[] }) => t.name === methodName);
              const required = matchingTool?.approvalRequiredFields;

              if (required && required.length > 0) {
                const missing = required.filter((f: string) => !approvalArgs.data?.[f]);
                if (missing.length > 0) {
                  // Return error to agent asking for required fields
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: `Error: Missing required fields for ${approvalArgs.tool}: ${missing.join(', ')}. Please include these fields in the data parameter: ${required.map((f: string) => `"${f}"`).join(', ')}.`,
                    is_error: true,
                  });
                  continue;
                }
              }

              const approvalStep: AgentStep = {
                id: toolStepId,
                name: approvalArgs.action || 'Waiting for approval',
                type: 'approval',
                status: 'awaiting_approval',
                startedAt: new Date().toISOString(),
                toolName: approvalArgs.tool,
                approvalData: approvalArgs.data,
              };
              steps.push(approvalStep);

              // Update plan and wait for approval
              await step.do(`checkpoint-setup-${toolStepId}`, async () => {
                await updatePlan({
                  status: 'checkpoint',
                  steps: [...steps],
                  checkpointData: {
                    stepId: toolStepId,
                    tool: approvalArgs.tool,
                    action: approvalArgs.action,
                    data: approvalArgs.data,
                  },
                });
                await addLog('info', `Requesting approval: ${approvalArgs.action}`, toolStepId);
                return 'checkpoint';
              });

              // Wait for user approval event
              const approvalEvent = await step.waitForEvent<CheckpointEvent>(
                `Wait for approval: ${approvalArgs.action}`,
                { type: 'checkpoint-approval', timeout: '7 days' }
              );

              // Process approval result
              const approvalAction = approvalEvent.payload.action;
              const approvalFeedback = approvalEvent.payload.feedback;

              await step.do(`checkpoint-resolve-${toolStepId}`, async () => {
                if (approvalAction === 'cancel') {
                  // User cancelled - fail the workflow
                  const stepIndex = steps.findIndex((s) => s.id === toolStepId);
                  if (stepIndex >= 0) {
                    steps[stepIndex].status = 'failed';
                    steps[stepIndex].error = 'User cancelled';
                    steps[stepIndex].completedAt = new Date().toISOString();
                  }
                  await updatePlan({
                    status: 'failed',
                    steps: [...steps],
                  });
                  throw new Error('User cancelled the workflow');
                }

                if (approvalAction === 'request_changes') {
                  // User requested changes - update step and continue with feedback
                  const stepIndex = steps.findIndex((s) => s.id === toolStepId);
                  if (stepIndex >= 0) {
                    steps[stepIndex].status = 'completed';
                    steps[stepIndex].completedAt = new Date().toISOString();
                  }
                  await updatePlan({
                    status: 'executing',
                    steps: [...steps],
                    checkpointData: undefined,
                  });
                  await addLog('info', `User requested changes: ${approvalFeedback?.substring(0, 100) || ''}`, toolStepId);
                  return 'request_changes';
                }

                // Update step as approved
                const stepIndex = steps.findIndex((s) => s.id === toolStepId);
                if (stepIndex >= 0) {
                  steps[stepIndex].status = 'completed';
                  steps[stepIndex].completedAt = new Date().toISOString();
                }
                await updatePlan({
                  status: 'executing',
                  steps: [...steps],
                  checkpointData: undefined,
                });
                await addLog('info', 'User approved', toolStepId);
                return 'approved';
              });

              let userData: Record<string, unknown> | undefined;
              if (approvalEvent.payload.dataJson) {
                try {
                  userData = JSON.parse(approvalEvent.payload.dataJson);
                } catch {
                  // Ignore invalid JSON
                }
              }

              if (approvalAction === 'request_changes') {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({
                    approved: false,
                    action: 'request_changes',
                    feedback: approvalFeedback || 'User requested changes without specific feedback',
                    message: 'The user has requested changes. Please address the feedback and request approval again.',
                  }),
                });
              } else {
                approvedTools.add(approvalArgs.tool);

                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({
                    approved: true,
                    feedback: approvalFeedback,
                    ...(userData && { userData }),
                  }),
                });
              }
            } else if (toolUse.name === 'weft_create_task') {
              // Handle child task creation with forked agent model
              // Child tasks are independent agents that run their own workflows
              const taskArgs = toolUse.input as {
                title: string;
                description: string;
                priority?: 'low' | 'medium' | 'high';
                context?: {
                  issueUrl?: string;
                  priorAnalysis?: string;
                  constraints?: string[];
                  [key: string]: unknown;
                };
                startWorkflow?: boolean;
              };

              const shouldStartWorkflow = taskArgs.startWorkflow !== false; // default: true

              const toolResultJson = await step.do(`create-child-task-${toolStepId}`, async () => {
                if (!targetColumnId) {
                  return JSON.stringify({
                    success: false,
                    error: 'No target column configured for child tasks',
                  });
                }

                try {
                  const stub = getBoardStub();

                  // Create the child task
                  const childTask = await stub.createTask({
                    columnId: targetColumnId,
                    boardId,
                    title: taskArgs.title,
                    description: taskArgs.description,
                    priority: taskArgs.priority || 'medium',
                    context: taskArgs.context as object | undefined,
                    parentTaskId,
                    runId,
                  }) as { id: string; title: string };

                  const childTaskId = childTask.id;
                  const childTaskTitle = childTask.title;

                  let workflowStarted = false;

                  // If startWorkflow is true (default), trigger the child's workflow
                  if (shouldStartWorkflow) {
                    try {
                      // Create a workflow plan for the child task
                      const childPlanId = `plan-${childTaskId}-${Date.now()}`;
                      await stub.createWorkflowPlan(childTaskId, {
                        id: childPlanId,
                        boardId,
                        steps: [],
                      });

                      // Build comprehensive task description including context
                      // The description is what the user sees, context has the details for the agent
                      let fullTaskDescription = taskArgs.description;
                      if (taskArgs.context && Object.keys(taskArgs.context).length > 0) {
                        fullTaskDescription += '\n\n## Context from parent task\n';
                        fullTaskDescription += JSON.stringify(taskArgs.context, null, 2);
                      }

                      // Start the child workflow
                      await this.env.AGENT_WORKFLOW.create({
                        id: childPlanId,
                        params: {
                          planId: childPlanId,
                          taskId: childTaskId,
                          boardId,
                          taskDescription: fullTaskDescription,
                          anthropicApiKey: mcpConfig.credentials.anthropicApiKey!,
                          // Child tasks can also create grandchildren if needed
                          isScheduledRun: false, // Child workflows are not scheduled runs
                          targetColumnId, // Pass through for potential grandchildren
                        },
                      });

                      workflowStarted = true;
                    } catch (workflowError) {
                      // Log but don't fail task creation if workflow start fails
                      const errorMsg = workflowError instanceof Error ? workflowError.message : String(workflowError);
                      logger.workflow.error('Failed to start child workflow', { childTaskId, error: errorMsg });
                    }
                  }

                  await addLog(
                    'info',
                    `Created child task: ${taskArgs.title}${workflowStarted ? ' (workflow started)' : ''}`,
                    toolStepId,
                    {
                      type: 'child_task_created',
                      taskId: childTaskId,
                      workflowStarted,
                    }
                  );

                  return JSON.stringify({
                    success: true,
                    taskId: childTaskId,
                    title: childTaskTitle,
                    workflowStarted,
                    message: workflowStarted
                      ? `Created task "${childTaskTitle}" and started its workflow. The child agent will work independently.`
                      : `Created task "${childTaskTitle}" in the target column.`,
                  });
                } catch (e) {
                  const error = e instanceof Error ? e.message : String(e);
                  await addLog('error', `Failed to create child task: ${error}`, toolStepId);
                  return JSON.stringify({
                    success: false,
                    error,
                  });
                }
              });

              const result = JSON.parse(toolResultJson);
              if (result.success) {
                childTasksCreated++;
                childTaskTitles.push(taskArgs.title);
                childTasksInfo.push({ id: result.taskId, title: result.title || taskArgs.title });
              }

              const childTaskStep: AgentStep = {
                id: toolStepId,
                name: `Fork agent: ${taskArgs.title.substring(0, 25)}${taskArgs.title.length > 25 ? '...' : ''}`,
                type: 'tool',
                status: result.success ? 'completed' : 'failed',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                toolName: 'weft_create_task',
                toolArgs: taskArgs,
                result: result.success ? result : undefined,
                error: result.success ? undefined : result.error,
              };
              steps.push(childTaskStep);

              // Fire-and-forget to avoid extra checkpoint
              updatePlan({ steps: [...steps] }).catch((e) =>
                logger.workflow.error('Plan update failed', { error: e instanceof Error ? e.message : String(e) })
              );

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: toolResultJson,
                is_error: !result.success,
              });
            } else {
              const toolResultJson = await step.do(`tool-${toolStepId}`, async () => {
                const startTime = Date.now();
                const toolStepData: AgentStep = {
                  id: toolStepId,
                  name: formatToolName(toolUse.name),
                  type: 'tool',
                  status: 'running',
                  startedAt: new Date().toISOString(),
                  toolName: toolUse.name,
                  toolArgs: toolUse.input as Record<string, unknown>,
                };

                await addLog(
                  'info',
                  `Calling ${formatToolName(toolUse.name)}`,
                  toolStepId,
                  { type: 'tool_call', tool: toolUse.name, args: toolUse.input }
                );

                let success = false;
                let result: unknown;
                let error: string | undefined;

                const [serverName, methodName] = toolUse.name.split('__');
                const matchingServer = mcpConfig.servers.find((s: MCPServerInfo) => s.name.replace(/\s+/g, '_') === serverName);
                const matchingTool = matchingServer?.tools.find((t: { name: string; requiresApproval?: boolean }) => t.name === methodName);

                if (matchingTool?.requiresApproval && !approvedTools.has(toolUse.name)) {
                  error = `This tool requires approval before use. Please call request_approval first with tool="${toolUse.name}" to get user approval, then retry this tool call after approval is granted.`;
                } else {
                  try {
                    result = await this.executeMcpTool(
                      toolUse.name,
                      toolUse.input as Record<string, unknown>,
                      mcpConfig.credentials,
                      mcpConfig.servers
                    );
                    const mcpResult = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
                    if (mcpResult.isError) {
                      error = mcpResult.content?.find(c => c.type === 'text')?.text || 'Tool returned error';
                    } else {
                      success = true;
                    }
                  } catch (e) {
                    error = e instanceof Error ? e.message : String(e);
                  }
                }

                const durationMs = Date.now() - startTime;

                toolStepData.status = success ? 'completed' : 'failed';
                toolStepData.completedAt = new Date().toISOString();
                toolStepData.durationMs = durationMs;
                toolStepData.result = success ? result : undefined;
                toolStepData.error = error;

                await addLog(
                  success ? 'info' : 'error',
                  success
                    ? `Tool completed in ${durationMs}ms`
                    : `Tool failed: ${error}`,
                  toolStepId,
                  { type: 'tool_result', durationMs }
                );

                return JSON.stringify({
                  toolStep: toolStepData,
                  success,
                  result: success ? result : undefined,
                  error,
                });
              });

              const toolResultData = JSON.parse(toolResultJson) as {
                toolStep: AgentStep;
                success: boolean;
                result?: unknown;
                error?: string;
              };

              steps.push(toolResultData.toolStep);

              // Fire-and-forget to avoid extra checkpoint
              updatePlan({ steps: [...steps] }).catch((e) =>
                logger.workflow.error('Plan update failed', { error: e instanceof Error ? e.message : String(e) })
              );

              if (toolResultData.success && toolResultData.result) {
                const artifact = this.extractArtifact(toolUse.name, toolResultData.result);
                if (artifact) {
                  artifacts.push(artifact);
                }
              }

              if (toolResultData.success) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: JSON.stringify(toolResultData.result),
                });
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: `Error: ${toolResultData.error}`,
                  is_error: true,
                });
              }
            }
          }

          messages.push({ role: 'user', content: toolResults });
        } else if (response.stop_reason === 'end_turn') {
          done = true;
        }

        turnIndex++;
      }

      const failedSteps = steps.filter((s) => s.status === 'failed');
      const hasFailures = failedSteps.length > 0;
      const hasArtifacts = artifacts.length > 0;

      // Check if agent recovered from failures (successful work after the last failure)
      const lastFailedIndex = steps.findLastIndex((s) => s.status === 'failed');
      const recoveredFromFailures =
        hasFailures && steps.slice(lastFailedIndex + 1).some((s) => s.status === 'completed');

      // For scheduled runs: success if created tasks, no failures, or recovered from failures
      // For regular runs: success if has artifacts or no failures
      const isSuccess = isScheduledRun
        ? childTasksCreated > 0 || !hasFailures || recoveredFromFailures
        : hasArtifacts || !hasFailures;

      await step.do('complete', async () => {
        const stub = getBoardStub();

        if (isSuccess) {
          await updatePlan({
            status: 'completed',
            steps: [...steps],
            result: {
              success: true,
              totalTurns: turnIndex,
              artifacts: hasArtifacts ? artifacts : undefined,
              childTasksCreated: isScheduledRun ? childTasksCreated : undefined,
              warnings:
                hasFailures
                  ? failedSteps.map((s) => ({ name: s.name, error: s.error }))
                  : undefined,
            },
          });

          // Update scheduled run record if this is a scheduled run
          if (isScheduledRun && runId) {
            // Include task titles in summary for historical record (even if tasks are deleted later)
            let summary: string;
            if (childTasksCreated > 0) {
              const titlesStr = childTaskTitles.join('\n- ');
              summary = `Created ${childTasksCreated} task${childTasksCreated === 1 ? '' : 's'}:\n- ${titlesStr}`;
            } else {
              summary = 'Completed with no new tasks';
            }
            await stub.updateScheduledRun(runId, {
              status: 'completed',
              completedAt: new Date().toISOString(),
              tasksCreated: childTasksCreated,
              summary,
              childTasksInfo,
            });
          }

          if (hasFailures) {
            await addLog(
              'info',
              `Agent completed successfully (${failedSteps.length} intermediate tool error(s) were handled)`
            );
          } else {
            await addLog('info', isScheduledRun
              ? `Scheduled run completed: created ${childTasksCreated} task(s)`
              : 'Agent completed task successfully'
            );
          }
        } else {
          await updatePlan({
            status: 'failed',
            steps: [...steps],
            result: {
              success: false,
              totalTurns: turnIndex,
              error: `${failedSteps.length} tool(s) failed`,
              failedSteps: failedSteps.map((s) => ({ name: s.name, error: s.error })),
            },
          });

          // Update scheduled run record if this is a scheduled run
          if (isScheduledRun && runId) {
            await stub.updateScheduledRun(runId, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              tasksCreated: childTasksCreated,
              error: `${failedSteps.length} tool(s) failed`,
            });
          }

          await addLog('error', `Agent failed: ${failedSteps.length} tool error(s)`);
        }
        return 'completed';
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.workflow.error('Workflow error', { error: message });

      await step.do('handle-error', async () => {
        const stub = getBoardStub();
        await updatePlan({
          status: 'failed',
          result: { success: false, error: message },
        });

        // Update scheduled run record if this is a scheduled run
        if (isScheduledRun && runId) {
          await stub.updateScheduledRun(runId, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: message,
          });
        }

        await addLog('error', `Workflow failed: ${message}`);
        return 'error';
      });

      throw error;
    }
  }

  /**
   * Build Claude tools from MCP server definitions
   * @param servers - MCP server definitions with their tools
   * @param isScheduledRun - If true, filters out tools marked with disabledInScheduledRuns
   */
  private buildClaudeTools(servers: MCPServerInfo[], isScheduledRun = false): Tool[] {
    const tools: Tool[] = [];

    for (const server of servers) {
      for (const tool of server.tools) {
        // Skip tools disabled in scheduled runs (coordination-only mode)
        if (isScheduledRun && tool.disabledInScheduledRuns) {
          continue;
        }
        const inputSchema = tool.inputSchema as Tool['input_schema'];
        if (!inputSchema.type) {
          inputSchema.type = 'object';
        }
        tools.push({
          name: `${server.name.replace(/\s+/g, '_')}__${tool.name}`,
          description: `[${server.name}] ${tool.description}`,
          input_schema: inputSchema,
        });
      }
    }

    // For scheduled runs, only include weft_create_task (not request_approval)
    // For regular runs, only include request_approval (not weft_create_task)
    if (isScheduledRun) {
      // Scheduled run: add weft_create_task instead of request_approval
      tools.push({
        name: 'weft_create_task',
        description:
          'Fork a new independent agent to handle a subtask. The child task will have its own workflow. IMPORTANT: Keep description SHORT (1-2 sentences) since users see it on the task card. Put detailed instructions in the context field.',
        input_schema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Short, actionable title (e.g., "Daily Issue Report - Jan 19" or "Review PR #1")',
            },
            description: {
              type: 'string',
              description: 'Brief 1-2 sentence summary for the user. NO tool names. Example: "Send email summarizing open issues in repo"',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Task priority (default: medium)',
            },
            context: {
              type: 'object',
              description: 'CRITICAL: Data the child agent needs to do its job. Include ALL specifics so the child does NOT need to re-fetch data. The child will use these values directly in tool calls.',
              properties: {
                action: {
                  type: 'string',
                  description: 'What the child should do (e.g., "sendEmail", "createPullRequest", "reviewAndMerge")',
                },
                owner: {
                  type: 'string',
                  description: 'GitHub repository owner (e.g., "acme-org") - child will use this directly',
                },
                repo: {
                  type: 'string',
                  description: 'GitHub repository name (e.g., "my-project") - child will use this directly',
                },
                issueUrl: {
                  type: 'string',
                  description: 'URL of the issue or PR being worked on',
                },
                issues: {
                  type: 'array',
                  description: 'List of issues/PRs with full details (number, title, state, body, labels, etc.)',
                },
                summary: {
                  type: 'string',
                  description: 'Your analysis summary - what you found, prioritization, recommendations',
                },
                emailTo: {
                  type: 'string',
                  description: 'Email recipient address',
                },
                emailSubject: {
                  type: 'string',
                  description: 'Suggested email subject line',
                },
                emailGuidance: {
                  type: 'string',
                  description: 'Guidance for email content, tone, what to include',
                },
              },
            },
            startWorkflow: {
              type: 'boolean',
              description: 'Whether to start the child workflow immediately (default: true). Set to false to create the task without starting its agent.',
            },
          },
          required: ['title', 'description'],
        },
      });
    } else {
      // Regular run: add request_approval (not weft_create_task)
      tools.push({
        name: 'request_approval',
        description:
          'Pause execution and ask user for approval before proceeding. Use this before sending emails, creating documents, or any action that cannot be undone.',
        input_schema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'The MCP tool that will be called if approved (e.g., "Google_Docs__createDocument", "Gmail__sendMessage")',
            },
            action: {
              type: 'string',
              description: 'Short human-readable action label (e.g., "Create Document", "Send Email")',
            },
            data: {
              type: 'object',
              description: 'The exact data that will be passed to the tool (e.g., { title: "...", content: "..." } for docs)',
            },
          },
          required: ['tool', 'action', 'data'],
        },
      });
    }

    return tools;
  }

  /**
   * Build system prompt for the agent
   * Uses registry-based workflow guidance for each enabled MCP
   */
  private buildSystemPrompt(
    servers: MCPServerInfo[],
    isScheduledRun = false,
    timeContext?: {
      currentTime?: string;
      lastRunAt?: string;
      scheduleTimezone?: string;
    }
  ): string {
    const toolsList = servers
      .map((s) => `- **${s.name}**: ${s.tools.map((t) => t.name).join(', ')}`)
      .join('\n');

    const serverNames = servers.map(s => s.name.replace(/\s+/g, '_'));
    const workflowGuidance = getWorkflowGuidance(serverNames);

    // Build time context section for scheduled runs
    let timeContextSection = '';
    if (isScheduledRun && timeContext) {
      const currentTimeStr = timeContext.currentTime
        ? new Date(timeContext.currentTime).toLocaleString('en-US', {
            timeZone: timeContext.scheduleTimezone || 'UTC',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        : 'Unknown';

      const lastRunStr = timeContext.lastRunAt
        ? new Date(timeContext.lastRunAt).toLocaleString('en-US', {
            timeZone: timeContext.scheduleTimezone || 'UTC',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        : null;

      timeContextSection = `
## Time Context
- **Current time:** ${currentTimeStr}
- **Last successful run:** ${lastRunStr || 'This is the first run'}
- **Timezone:** ${timeContext.scheduleTimezone || 'UTC'}
${timeContext.lastRunAt ? `
**IMPORTANT:** When looking for "new" items (issues, emails, etc.), filter by items created or updated AFTER: ${timeContext.lastRunAt}
` : `
**IMPORTANT:** This is the first run of this scheduled task. Consider whether you need to limit results (e.g., only look at recent items, not all-time).
`}
`;
    }

    const scheduledRunGuidance = isScheduledRun ? `
## Creating Child Tasks

Use \`weft_create_task\` to delegate work. Each child task gets its own agent with full tool access and approval workflows.

**Task fields:**
- \`title\`: Short, actionable (shown on task card)
- \`description\`: 1-2 sentences for the user (NO tool names)
- \`context\`: All data the child needs - owner, repo, issue numbers, your analysis

**Example:**
\`\`\`javascript
weft_create_task({
  title: "Review PR #42",
  description: "Review dependency update PR",
  context: { owner: "acme", repo: "app", prNumber: 42, action: "review_and_merge" }
})
\`\`\`

**Important:** Include everything in context so the child doesn't re-fetch what you already found.
` : '';

    // For scheduled runs, use a completely different prompt structure
    if (isScheduledRun) {
      return `You are a scheduled task agent. Analyze the situation using read-only tools, then create child tasks for any work.

**Rules:**
- DO NOT execute actions directly (no PRs, emails, document edits)
- ALWAYS use \`weft_create_task\` for each piece of work found, even if there's only one item
- Child tasks have their own agent with full tool access and approval workflows
${timeContextSection}
## Available Tools
${toolsList}
- **weft_create_task**: Create a child task for work that needs to be done
${scheduledRunGuidance}
Summarize what you found and what child tasks you created.`;
    }

    // Regular (non-scheduled) runs get the full prompt with approval guidelines
    return `You are a helpful AI assistant that accomplishes tasks using available tools.

## Available Tools
${toolsList}
- **request_approval**: Pause and ask user for approval before irreversible actions

## Using Context from Parent Tasks
If your task includes a "## Context from parent task" section, use that data directly - don't re-fetch what the parent already gathered.

## Guidelines
- Request approval before sending emails, creating/modifying documents, making commits, or any irreversible action
- When requesting approval, include a clear description and preview of the content
- If the approval result contains \`userData\`, use those values (the user edited the data)
- Be concise and handle errors gracefully

${workflowGuidance}

Keep outputs minimal - just the content, no preambles or explanations.`;
  }

  /**
   * Get a valid access token for any OAuth account, refreshing if needed
   */
  private async ensureValidToken(
    account: AccountDefinition,
    credentials: CredentialStore
  ): Promise<string> {
    // Build credential keys based on account id (e.g., 'google' -> 'googleToken')
    const tokenKey = `${account.id}Token`;
    const refreshTokenKey = `${account.id}RefreshToken`;
    const expiresAtKey = `${account.id}TokenExpiresAt`;

    const accessToken = credentials[tokenKey];
    const refreshToken = credentials[refreshTokenKey];
    const expiresAt = credentials[expiresAtKey];

    if (!accessToken) {
      throw new Error(`${account.name} OAuth not configured`);
    }

    // Check if token needs refresh
    if (refreshToken && expiresAt && account.refreshToken) {
      const expiresAtMs = new Date(expiresAt).getTime();
      const now = Date.now();

      if (now > expiresAtMs - TOKEN_REFRESH_BUFFER_MS) {
        logger.workflow.info('Refreshing expired token', { account: account.name });

        // Get client credentials from env using account id pattern
        const clientIdKey = `${account.id.toUpperCase()}_CLIENT_ID` as keyof WorkflowEnv;
        const clientSecretKey = `${account.id.toUpperCase()}_CLIENT_SECRET` as keyof WorkflowEnv;
        const clientId = this.env[clientIdKey] as string | undefined;
        const clientSecret = this.env[clientSecretKey] as string | undefined;

        if (!clientId || !clientSecret) {
          throw new Error(`Missing OAuth config for ${account.name}`);
        }

        const newTokenData = await account.refreshToken(
          refreshToken,
          clientId,
          clientSecret
        );

        credentials[tokenKey] = newTokenData.access_token;
        credentials[expiresAtKey] = new Date(
          Date.now() + (newTokenData.expires_in || 3600) * 1000
        ).toISOString();

        logger.workflow.info('Token refreshed successfully', { account: account.name });
        return newTokenData.access_token;
      }
    }

    return accessToken;
  }

  /**
   * Execute an MCP tool using registry-based dispatch
   */
  private async executeMcpTool(
    toolName: string,
    args: Record<string, unknown>,
    credentials: CredentialStore,
    servers: MCPServerInfo[]
  ): Promise<unknown> {
    const parts = toolName.split('__');
    if (parts.length !== 2) {
      throw new Error(`Invalid tool name format: ${toolName}`);
    }

    const [serverName, method] = parts;

    const lookup = getMCPByServerName(serverName);

    if (lookup) {
      return this.executeHostedMcpTool(lookup, method, args, credentials);
    }

    const remoteServer = servers.find(s => {
      const normalized = s.name.replace(/[^a-zA-Z0-9]/g, '_');
      return normalized === serverName;
    });

    if (remoteServer && remoteServer.type === 'remote') {
      return this.executeRemoteMcpTool(remoteServer, method, args);
    }

    throw new Error(`Unknown MCP server: ${serverName}`);
  }

  /**
   * Execute a tool on a hosted MCP server (Gmail, Docs, etc.)
   * Uses registry-driven credential and env binding configuration
   */
  private async executeHostedMcpTool(
    lookup: { account: AccountDefinition; mcp: { factory: (creds: MCPCredentials, env: MCPEnvBindings) => { callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> } } },
    method: string,
    args: Record<string, unknown>,
    credentials: CredentialStore
  ): Promise<unknown> {
    const { account, mcp } = lookup;

    const mcpCredentials: MCPCredentials = {};

    if (account.authType === 'oauth') {
      const accessToken = await this.ensureValidToken(account, credentials);
      mcpCredentials.accessToken = accessToken;
    }

    if (account.additionalCredentialKeys) {
      for (const key of account.additionalCredentialKeys) {
        if (credentials[key]) {
          mcpCredentials[key] = credentials[key];
        }
      }
    }

    const envBindings: MCPEnvBindings = {};
    if (account.envBindingKeys) {
      for (const key of account.envBindingKeys) {
        const value = (this.env as Record<string, unknown>)[key];
        if (value !== undefined) {
          envBindings[key] = value;
        }
      }
    }

    const server = mcp.factory(mcpCredentials, envBindings);
    return await server.callTool(method, args);
  }

  /**
   * Execute a tool on a remote MCP server (user-added servers like Cloudflare Docs)
   */
  private async executeRemoteMcpTool(
    server: MCPServerInfo,
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!server.endpoint) {
      throw new Error(`Remote MCP server ${server.name} has no endpoint configured`);
    }

    const config: MCPServerConfig = {
      id: server.id,
      name: server.name,
      type: 'remote',
      endpoint: server.endpoint,
      authType: server.authType as MCPServerConfig['authType'],
      transportType: server.transportType || 'streamable-http',
    };

    if (server.authType === 'oauth' && server.accessToken) {
      config.credentials = { token: server.accessToken };
    }

    const client = new MCPClient(config);

    try {
      await client.initialize();
      const result = await client.callTool(method, args);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Remote MCP tool call failed: ${message}`);
    }
  }

  /**
   * Extract artifact from tool result using registry-based type lookup
   */
  private extractArtifact(toolName: string, result: unknown): WorkflowArtifact | null {
    const structured = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;
    if (!structured) return null;

    const url = structured.url as string | undefined;
    const title = structured.title as string | undefined;
    const content = structured.content as WorkflowArtifact['content'] | undefined;

    const [serverName] = toolName.split('__');
    const lookup = getMCPByServerName(serverName);

    if (!lookup?.mcp.artifactType) {
      return url ? { type: 'other', url, title } : null;
    }

    if (lookup.mcp.artifactContentType === 'inline') {
      return content ? { type: lookup.mcp.artifactType, title, content } : null;
    }

    return url ? { type: lookup.mcp.artifactType, url, title } : null;
  }
}
