/**
 * Workflow handlers for plan generation, checkpoints, and cancellation
 */

import { type AgentWorkflowParams } from '../workflows/AgentWorkflow';
import { jsonResponse } from '../utils/response';
import { logger } from '../utils/logger';
import { CREDENTIAL_TYPES } from '../constants';
import type { BoardDO } from '../BoardDO';

type BoardDOStub = DurableObjectStub<BoardDO>;

/**
 * Handle generate-plan request - starts agent workflow for a task
 */
export async function handleGeneratePlan(
  env: Env,
  boardStub: BoardDOStub,
  boardId: string,
  taskId: string
): Promise<Response> {
  if (!env.AGENT_WORKFLOW) {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_CONFIGURED', message: 'Agent workflow not configured' },
    }, 500);
  }

  // Get the task details
  let task: { id: string; boardId: string; title: string; description?: string | null };
  try {
    task = await boardStub.getTask(taskId);
  } catch {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    }, 404);
  }

  // Create a plan record with status 'executing' (skip planning/draft)
  const planId = crypto.randomUUID();

  try {
    await boardStub.createWorkflowPlan(taskId, {
      id: planId,
      boardId,
      // status is set to 'executing' by default
    });
  } catch {
    return jsonResponse({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create plan record' },
    }, 500);
  }

  // Fetch Anthropic API key
  const anthropicApiKey = await boardStub.getCredentialValue(boardId, CREDENTIAL_TYPES.ANTHROPIC_API_KEY);

  if (!anthropicApiKey) {
    await boardStub.updateWorkflowPlan(planId, { status: 'failed', result: { error: 'Anthropic API key not configured' } });
    return jsonResponse({
      success: false,
      error: { code: 'NO_ANTHROPIC', message: 'Anthropic API key not configured' },
    }, 400);
  }

  // Combine task title and description for agent
  const taskDescription = [task.title, task.description].filter(Boolean).join('\n\n') || 'No task description provided';

  // Start the agent workflow directly
  try {
    const workflowParams: AgentWorkflowParams = {
      planId,
      taskId,
      boardId,
      taskDescription,
      anthropicApiKey,
    };

    await env.AGENT_WORKFLOW.create({
      id: planId,
      params: workflowParams,
    });

    // Fetch and return the full plan
    const plan = await boardStub.getWorkflowPlan(planId);
    return jsonResponse({ success: true, data: plan });
  } catch (error) {
    await boardStub.updateWorkflowPlan(planId, {
      status: 'failed',
      result: { error: error instanceof Error ? error.message : 'Failed to start agent' },
    });
    return jsonResponse({
      success: false,
      error: { code: 'WORKFLOW_FAILED', message: 'Failed to start agent workflow' },
    }, 500);
  }
}

/**
 * Handle resolve checkpoint request - resumes workflow after user approval
 */
export async function handleResolveCheckpoint(
  request: Request,
  env: Env,
  boardStub: BoardDOStub,
  _boardId: string,
  planId: string
): Promise<Response> {
  if (!env.AGENT_WORKFLOW) {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_CONFIGURED', message: 'Agent workflow not configured' },
    }, 500);
  }

  // Get the plan
  let plan: { id: string; taskId: string; boardId: string; status: string };
  try {
    plan = await boardStub.getWorkflowPlan(planId);
  } catch {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Plan not found' },
    }, 404);
  }

  // Parse the checkpoint resolution data
  const body = await request.json() as {
    action: string;
    data?: Record<string, unknown>;
    feedback?: string;
  };

  if (plan.status !== 'checkpoint') {
    return jsonResponse({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Workflow is not at a checkpoint' },
    }, 400);
  }

  // If cancelling (or legacy reject), just update the status and don't resume workflow
  if (body.action === 'cancel' || body.action === 'reject') {
    await boardStub.updateWorkflowPlan(planId, { status: 'failed', result: { error: 'Checkpoint cancelled by user' } });

    const updatedPlan = await boardStub.getWorkflowPlan(planId);
    return jsonResponse({ success: true, data: updatedPlan });
  }

  // For approve or request_changes, send event to resume the waiting workflow
  try {
    const instance = await env.AGENT_WORKFLOW.get(planId);
    await instance.sendEvent({
      type: 'checkpoint-approval',
      payload: {
        action: body.action,
        feedback: body.feedback,
        dataJson: body.data ? JSON.stringify(body.data) : undefined,
      },
    });

    // Allow the workflow to process
    await new Promise(resolve => setTimeout(resolve, 100));

    // Return updated plan
    const updatedPlan = await boardStub.getWorkflowPlan(planId);
    return jsonResponse({ success: true, data: updatedPlan });

  } catch (error) {
    logger.workflow.error('Failed to resume workflow', { planId, error: error instanceof Error ? error.message : String(error) });
    await boardStub.updateWorkflowPlan(planId, {
      status: 'failed',
      result: { error: error instanceof Error ? error.message : 'Failed to resume workflow' },
    });
    return jsonResponse({
      success: false,
      error: { code: 'WORKFLOW_FAILED', message: 'Failed to resume workflow' },
    }, 500);
  }
}

/**
 * Handle cancel workflow request - terminates running workflow
 */
export async function handleCancelWorkflow(
  env: Env,
  boardStub: BoardDOStub,
  _boardId: string,
  planId: string
): Promise<Response> {
  if (!env.AGENT_WORKFLOW) {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_CONFIGURED', message: 'Agent workflow not configured' },
    }, 500);
  }

  // Get the plan
  let plan: { id: string; status: string };
  try {
    plan = await boardStub.getWorkflowPlan(planId);
  } catch {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Plan not found' },
    }, 404);
  }

  // Only allow cancelling running or checkpoint workflows
  if (plan.status !== 'executing' && plan.status !== 'checkpoint') {
    return jsonResponse({
      success: false,
      error: { code: 'INVALID_STATUS', message: `Cannot cancel plan with status: ${plan.status}` },
    }, 400);
  }

  try {
    const instance = await env.AGENT_WORKFLOW.get(planId);
    await instance.terminate();
  } catch (error) {
    logger.workflow.warn('Workflow terminate error (may be expected)', { planId, error: error instanceof Error ? error.message : String(error) });
  }

  // Update plan status to cancelled
  await boardStub.updateWorkflowPlan(planId, {
    status: 'failed',
    result: { error: 'Cancelled by user' },
  });

  // Return updated plan
  const updatedPlan = await boardStub.getWorkflowPlan(planId);
  return jsonResponse({ success: true, data: updatedPlan });
}
