import { DurableObject } from 'cloudflare:workers';
import { initSchema } from './db/schema';
import {
  BoardService,
  CredentialService,
  MCPService,
  MCPOAuthService,
  WorkflowService,
  ScheduleService,
} from './services';
import type { ScheduleConfig, ScheduledRun, ScheduledRunStatus } from './services';
import { logger } from './utils/logger';

// ============================================
// TYPE EXPORTS FOR RPC
// ============================================

export interface Board {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  columns: Column[];
  tasks: Task[];
}

export interface Column {
  id: string;
  boardId: string;
  name: string;
  position: number;
}

export interface Task {
  id: string;
  columnId: string;
  boardId: string;
  title: string;
  description: string | null;
  priority: string;
  position: number;
  context: object | null;
  scheduleConfig: ScheduleConfig | null;
  parentTaskId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledRunRecord {
  id: string;
  taskId: string;
  status: ScheduledRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  tasksCreated: number;
  summary: string | null;
  error: string | null;
  createdAt: string;
}

export interface WorkflowPlan {
  id: string;
  taskId: string;
  boardId: string;
  status: string;
  summary: string | null;
  generatedCode: string | null;
  steps: object[] | null;
  currentStepIndex: number | null;
  checkpointData: object | null;
  result: object | null;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  id: string;
  boardId: string;
  type: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface MCPServer {
  id: string;
  boardId: string;
  name: string;
  type: string;
  endpoint: string | null;
  authType: string;
  credentialId: string | null;
  enabled: boolean;
  status: string;
  transportType: string | null;
  urlPatterns: object[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface MCPTool {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  inputSchema: object;
  approvalRequiredFields: string[] | null;
}

// ============================================
// BOARD DURABLE OBJECT
// ============================================

/**
 * BoardDO - Durable Object for board state management
 *
 * Uses RPC for all operations except WebSocket (which requires fetch)
 */
export class BoardDO extends DurableObject<Env> {
  private sql: SqlStorage;

  // Services
  private boardService: BoardService;
  private credentialService: CredentialService;
  private mcpService: MCPService;
  private mcpOAuthService: MCPOAuthService;
  private workflowService: WorkflowService;
  private scheduleService: ScheduleService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    initSchema(this.sql);

    const generateId = () => crypto.randomUUID();

    this.credentialService = new CredentialService(
      this.sql,
      env.ENCRYPTION_KEY,
      generateId,
      {
        GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      }
    );

    this.boardService = new BoardService(
      this.sql,
      this.credentialService,
      generateId
    );

    this.mcpService = new MCPService(
      this.sql,
      this.credentialService,
      generateId
    );

    this.mcpOAuthService = new MCPOAuthService(
      this.sql,
      this.credentialService,
      this.mcpService,
      generateId
    );

    this.workflowService = new WorkflowService(
      this.sql,
      generateId,
      (boardId, type, data) => this.broadcast(boardId, type, data)
    );

    this.scheduleService = new ScheduleService(
      this.sql,
      generateId
    );
  }

  // ============================================
  // ALARM HANDLER (for scheduled tasks)
  // ============================================

  async alarm(): Promise<void> {
    const now = Date.now();
    logger.schedule.info('Alarm fired', { timestamp: new Date(now).toISOString() });

    const boardInfo = await this.getBoardInfo();
    if (!boardInfo.id) {
      logger.schedule.info('No board ID found, skipping alarm');
      return;
    }

    const boardId = boardInfo.id;
    logger.schedule.info('Processing alarm', { boardId });

    const dueTasks = this.scheduleService.getTasksDueForRun(boardId, now);
    logger.schedule.info('Tasks due for run', { boardId, count: dueTasks.length });

    const currentTime = new Date(now).toISOString();

    for (const { id: taskId, config, lastRunAt } of dueTasks) {
      try {
        const runResponse = this.scheduleService.createScheduledRun(taskId);
        const runResult = await runResponse.json() as { success: boolean; data?: ScheduledRun };
        if (!runResult.success || !runResult.data) continue;

        const runId = runResult.data.id;
        const task = await this.getTask(taskId);

        this.scheduleService.updateScheduledRun(runId, { status: 'running' });

        const anthropicApiKey = await this.getCredentialValue(boardId, 'anthropic_api_key');
        if (!anthropicApiKey) {
          this.scheduleService.updateScheduledRun(runId, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: 'Missing Anthropic API key',
          });
          continue;
        }

        const planResponse = this.workflowService.createWorkflowPlan(taskId, {
          boardId,
          summary: `Scheduled run: ${task.title}`,
        });
        const planResult = await planResponse.json() as { success: boolean; data?: WorkflowPlan };
        if (!planResult.success || !planResult.data) continue;

        const planId = planResult.data.id;

        const workflow = await this.env.AGENT_WORKFLOW.create({
          id: runId,
          params: {
            planId,
            taskId,
            boardId,
            taskDescription: [task.title, task.description].filter(Boolean).join('\n\n') || 'No task description provided',
            anthropicApiKey,
            isScheduledRun: true,
            runId,
            targetColumnId: config.targetColumnId,
            parentTaskId: taskId,
            currentTime,
            lastRunAt,
            scheduleTimezone: config.timezone,
          },
        });

        logger.schedule.info('Started scheduled run', { runId, taskId, workflowId: workflow.id });

        this.broadcast(boardId, 'scheduled_run_started', {
          taskId,
          runId,
          planId,
        });
      } catch (error) {
        logger.schedule.error('Failed to start scheduled run', { taskId, error: String(error) });
      }
    }

    await this.scheduleNextAlarm(boardId);
  }

  private async scheduleNextAlarm(boardId: string): Promise<void> {
    const nextRunTime = this.scheduleService.getNextScheduledRunTime(boardId);

    if (nextRunTime) {
      await this.ctx.storage.setAlarm(nextRunTime);
      logger.schedule.info('Next alarm scheduled', { nextRunTime: new Date(nextRunTime).toISOString() });
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ============================================
  // WEBSOCKET (requires fetch - can't use RPC)
  // ============================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(url);
    }

    return new Response('Use RPC methods', { status: 400 });
  }

  private handleWebSocketUpgrade(url: URL): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const boardId = url.searchParams.get('boardId');
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ boardId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore malformed messages
      }
    }
  }

  async webSocketClose() {
    // Cleanup handled by runtime
  }

  private broadcast(boardId: string, type: string, data: Record<string, unknown>): void {
    const clients = this.ctx.getWebSockets();
    const message = JSON.stringify({ type, data });

    for (const ws of clients) {
      try {
        const attachment = ws.deserializeAttachment() as { boardId: string } | null;
        if (attachment?.boardId === boardId) {
          ws.send(message);
        }
      } catch {
        // Client may have disconnected
      }
    }
  }

  // ============================================
  // BOARD RPC METHODS
  // ============================================

  async initBoard(data: { id: string; name: string; ownerId: string }): Promise<Board> {
    const response = this.boardService.initBoard(data);
    return this.extractData(response);
  }

  async getBoardInfo(): Promise<{ id: string; name: string; ownerId: string }> {
    const response = this.boardService.getBoardInfo();
    return this.extractData(response);
  }

  async getBoard(boardId: string): Promise<Board> {
    const response = this.boardService.getBoard(boardId);
    return this.extractData(response);
  }

  async updateBoard(boardId: string, data: { name?: string }): Promise<Board> {
    const response = this.boardService.updateBoard(boardId, data);
    return this.extractData(response);
  }

  async deleteBoard(boardId: string): Promise<{ success: boolean }> {
    const response = this.boardService.deleteBoard(boardId);
    return this.extractData(response);
  }

  // ============================================
  // COLUMN RPC METHODS
  // ============================================

  async createColumn(boardId: string, data: { name: string }): Promise<Column> {
    const response = this.boardService.createColumn(boardId, data);
    return this.extractData(response);
  }

  async updateColumn(columnId: string, data: { name?: string; position?: number }): Promise<Column> {
    const response = this.boardService.updateColumn(columnId, data);
    return this.extractData(response);
  }

  async deleteColumn(columnId: string): Promise<{ success: boolean }> {
    const response = this.boardService.deleteColumn(columnId);
    return this.extractData(response);
  }

  // ============================================
  // TASK RPC METHODS
  // ============================================

  async createTask(data: {
    columnId: string;
    boardId: string;
    title: string;
    description?: string;
    priority?: string;
    context?: object;
    scheduleConfig?: object;
    parentTaskId?: string;
    runId?: string;
  }): Promise<Task> {
    const response = this.boardService.createTask(data);
    const task = await this.extractData<Task>(response);

    if (data.scheduleConfig) {
      await this.scheduleNextAlarm(data.boardId);
    }

    this.broadcast(data.boardId, 'task_created', { task });

    return task;
  }

  async getTask(taskId: string): Promise<Task> {
    const response = this.boardService.getTask(taskId);
    return this.extractData(response);
  }

  async updateTask(taskId: string, data: {
    title?: string;
    description?: string;
    priority?: string;
    context?: object;
    scheduleConfig?: object | null;
  }): Promise<Task> {
    const response = this.boardService.updateTask(taskId, data);
    const task = await this.extractData<Task>(response);

    if (data.scheduleConfig !== undefined) {
      await this.scheduleNextAlarm(task.boardId);
    }

    return task;
  }

  async deleteTask(taskId: string): Promise<{ success: boolean }> {
    const response = this.boardService.deleteTask(taskId);
    return this.extractData(response);
  }

  async moveTask(taskId: string, data: { columnId: string; position: number }): Promise<Task> {
    const response = this.boardService.moveTask(taskId, data);
    return this.extractData(response);
  }

  // ============================================
  // SCHEDULE RPC METHODS
  // ============================================

  async getScheduledTasks(boardId: string): Promise<Task[]> {
    const response = this.scheduleService.getScheduledTasks(boardId);
    return this.extractData(response);
  }

  async getScheduledRuns(taskId: string, limit?: number): Promise<ScheduledRunRecord[]> {
    const response = this.scheduleService.getScheduledRuns(taskId, limit);
    return this.extractData(response);
  }

  async getRunTasks(runId: string): Promise<Task[]> {
    const response = this.scheduleService.getRunTasks(runId);
    return this.extractData(response);
  }

  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    const response = this.scheduleService.getChildTasks(parentTaskId);
    return this.extractData(response);
  }

  async triggerScheduledRun(taskId: string): Promise<{ runId: string }> {
    const task = await this.getTask(taskId);
    if (!task.scheduleConfig) {
      throw new Error('Task does not have a schedule configured');
    }

    const config = task.scheduleConfig;

    const runResponse = this.scheduleService.createScheduledRun(taskId);
    const runResult = await runResponse.json() as { success: boolean; data?: ScheduledRun };
    if (!runResult.success || !runResult.data) {
      throw new Error('Failed to create scheduled run');
    }

    const runId = runResult.data.id;

    this.scheduleService.updateScheduledRun(runId, { status: 'running' });

    const anthropicApiKey = await this.getCredentialValue(task.boardId, 'anthropic_api_key');
    if (!anthropicApiKey) {
      this.scheduleService.updateScheduledRun(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Missing Anthropic API key',
      });
      throw new Error('Missing Anthropic API key');
    }

    const planResponse = this.workflowService.createWorkflowPlan(taskId, {
      boardId: task.boardId,
      summary: `Manual run: ${task.title}`,
    });
    const planResult = await planResponse.json() as { success: boolean; data?: WorkflowPlan };
    if (!planResult.success || !planResult.data) {
      throw new Error('Failed to create workflow plan');
    }

    const planId = planResult.data.id;

    const runsResponse = this.scheduleService.getScheduledRuns(taskId, 10);
    const runsResult = await runsResponse.json() as { success: boolean; data?: Array<{ status: string; completedAt?: string }> };
    const lastCompletedRun = runsResult.data?.find(r => r.status === 'completed' && r.completedAt);
    const lastRunAt = lastCompletedRun?.completedAt;

    const currentTime = new Date().toISOString();

    await this.env.AGENT_WORKFLOW.create({
      id: runId,
      params: {
        planId,
        taskId,
        boardId: task.boardId,
        taskDescription: [task.title, task.description].filter(Boolean).join('\n\n') || 'No task description provided',
        anthropicApiKey,
        isScheduledRun: true,
        runId,
        targetColumnId: config.targetColumnId,
        parentTaskId: taskId,
        currentTime,
        lastRunAt,
        scheduleTimezone: config.timezone,
      },
    });

    this.broadcast(task.boardId, 'scheduled_run_started', {
      taskId,
      runId,
      planId,
    });

    return { runId };
  }

  async updateScheduledRun(runId: string, data: {
    status?: ScheduledRunStatus;
    completedAt?: string;
    tasksCreated?: number;
    summary?: string;
    error?: string;
    childTasksInfo?: Array<{ id: string; title: string }>;
  }): Promise<ScheduledRunRecord> {
    const response = this.scheduleService.updateScheduledRun(runId, data);
    return this.extractData(response);
  }

  async deleteScheduledRun(runId: string): Promise<void> {
    this.scheduleService.deleteScheduledRun(runId);
  }

  // ============================================
  // CREDENTIAL RPC METHODS
  // ============================================

  async getCredentials(boardId: string): Promise<Credential[]> {
    const response = this.credentialService.getCredentials(boardId);
    return this.extractData(response);
  }

  async createCredential(boardId: string, data: {
    type: string;
    name: string;
    value: string;
    metadata?: object;
  }): Promise<Credential> {
    const response = await this.credentialService.createCredential(boardId, data);
    return this.extractData(response);
  }

  async deleteCredential(boardId: string, credentialId: string): Promise<{ success: boolean }> {
    const response = this.credentialService.deleteCredential(boardId, credentialId);
    return this.extractData(response);
  }

  async getCredentialValue(boardId: string, type: string): Promise<string | null> {
    return this.credentialService.getCredentialValue(boardId, type);
  }

  async getCredentialFull(boardId: string, type: string): Promise<{ value: string; metadata: object } | null> {
    const response = await this.credentialService.getCredentialFullResponse(boardId, type);
    const result = await response.json() as { success: boolean; data?: { value: string; metadata: object } };
    return result.success ? result.data! : null;
  }

  async updateCredentialValue(
    boardId: string,
    type: string,
    value: string,
    metadata?: Record<string, unknown>
  ): Promise<{ success: boolean }> {
    const response = await this.credentialService.updateCredentialValue(boardId, type, value, metadata);
    return this.extractData(response);
  }

  async getCredentialById(boardId: string, credentialId: string): Promise<{ value: string; metadata: object | null } | null> {
    const response = await this.credentialService.getCredentialById(boardId, credentialId);
    const result = await response.json() as { success: boolean; data?: { value: string; metadata: object | null } };
    return result.success ? result.data! : null;
  }

  findCredentialId(boardId: string, type: string): string | undefined {
    return this.credentialService.findCredentialId(boardId, type);
  }

  // ============================================
  // WORKFLOW PLAN RPC METHODS
  // ============================================

  async getTaskWorkflowPlan(taskId: string): Promise<WorkflowPlan | null> {
    const response = this.workflowService.getTaskWorkflowPlan(taskId);
    const result = await response.json() as { success: boolean; data: WorkflowPlan | null };
    return result.data;
  }

  async getBoardWorkflowPlans(boardId: string): Promise<WorkflowPlan[]> {
    const response = this.workflowService.getBoardWorkflowPlans(boardId);
    return this.extractData(response);
  }

  async createWorkflowPlan(taskId: string, data: {
    id?: string;
    boardId: string;
    summary?: string;
    generatedCode?: string;
    steps?: object[];
  }): Promise<WorkflowPlan> {
    const response = this.workflowService.createWorkflowPlan(taskId, data);
    return this.extractData(response);
  }

  async getWorkflowPlan(planId: string): Promise<WorkflowPlan> {
    const response = this.workflowService.getWorkflowPlan(planId);
    return this.extractData(response);
  }

  async updateWorkflowPlan(planId: string, data: {
    status?: string;
    summary?: string;
    generatedCode?: string;
    steps?: object[];
    currentStepIndex?: number;
    checkpointData?: object;
    result?: object;
  }): Promise<WorkflowPlan> {
    const response = this.workflowService.updateWorkflowPlan(planId, data);
    return this.extractData(response);
  }

  async deleteWorkflowPlan(planId: string): Promise<{ success: boolean }> {
    const response = this.workflowService.deleteWorkflowPlan(planId);
    return this.extractData(response);
  }

  async approveWorkflowPlan(planId: string): Promise<WorkflowPlan> {
    const response = this.workflowService.approveWorkflowPlan(planId);
    return this.extractData(response);
  }

  async resolveWorkflowCheckpoint(planId: string, data: {
    action: string;
    data?: object;
  }): Promise<WorkflowPlan> {
    const response = this.workflowService.resolveWorkflowCheckpoint(planId, data);
    return this.extractData(response);
  }

  // ============================================
  // WORKFLOW LOG RPC METHODS
  // ============================================

  async getWorkflowLogs(planId: string, limit?: number, offset?: number): Promise<object[]> {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const response = this.workflowService.getWorkflowLogs(planId, params);
    return this.extractData(response);
  }

  addWorkflowLog(
    planId: string,
    level: string,
    message: string,
    stepId?: string,
    metadata?: object
  ): Record<string, unknown> {
    return this.workflowService.addWorkflowLog(planId, level, message, stepId, metadata);
  }

  broadcastStreamChunk(boardId: string, planId: string, turnIndex: number, text: string): void {
    this.broadcast(boardId, 'workflow_stream', { planId, turnIndex, text });
  }

  // ============================================
  // MCP SERVER RPC METHODS
  // ============================================

  async getMCPServers(boardId: string): Promise<MCPServer[]> {
    const response = this.mcpService.getMCPServers(boardId);
    return this.extractData(response);
  }

  async getMCPServer(serverId: string): Promise<MCPServer> {
    const response = this.mcpService.getMCPServer(serverId);
    return this.extractData(response);
  }

  async createMCPServer(boardId: string, data: {
    name: string;
    type: 'remote' | 'hosted';
    endpoint?: string;
    authType?: string;
    credentialId?: string;
    status?: string;
    transportType?: 'streamable-http' | 'sse';
    urlPatterns?: Array<{ pattern: string; type: string; fetchTool: string }>;
  }): Promise<MCPServer> {
    const response = this.mcpService.createMCPServer(boardId, data);
    return this.extractData(response);
  }

  async createAccountMCP(boardId: string, data: {
    accountId: string;
    mcpId: string;
  }): Promise<MCPServer> {
    const response = await this.mcpService.createAccountMCP(boardId, data);
    return this.extractData(response);
  }

  async updateMCPServer(serverId: string, data: {
    name?: string;
    endpoint?: string;
    authType?: string;
    credentialId?: string;
    enabled?: boolean;
    status?: string;
    transportType?: 'streamable-http' | 'sse';
  }): Promise<MCPServer> {
    const response = this.mcpService.updateMCPServer(serverId, data);
    return this.extractData(response);
  }

  async deleteMCPServer(serverId: string): Promise<{ success: boolean }> {
    const response = this.mcpService.deleteMCPServer(serverId);
    return this.extractData(response);
  }

  async getMCPServerTools(serverId: string): Promise<MCPTool[]> {
    const response = await this.mcpService.getMCPServerTools(serverId);
    return this.extractData(response);
  }

  async cacheMCPServerTools(serverId: string, data: {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: object;
      approvalRequiredFields?: string[];
    }>;
  }): Promise<MCPTool[]> {
    const response = await this.mcpService.cacheMCPServerTools(serverId, data);
    return this.extractData(response);
  }

  async connectMCPServer(serverId: string): Promise<{
    status: string;
    toolCount: number;
    tools: Array<{ name: string; description?: string }>;
  }> {
    const response = await this.mcpService.connectMCPServer(serverId);
    return this.extractData(response);
  }

  // ============================================
  // MCP OAUTH RPC METHODS
  // ============================================

  async discoverMCPOAuth(serverId: string): Promise<object> {
    const response = await this.mcpOAuthService.discoverMCPOAuth(serverId);
    return this.extractData(response);
  }

  async getMCPOAuthUrl(serverId: string, redirectUri: string): Promise<{ url: string; state: string }> {
    const params = new URLSearchParams();
    params.set('redirectUri', redirectUri);
    const response = await this.mcpOAuthService.getMCPOAuthUrl(serverId, params);
    return this.extractData(response);
  }

  async exchangeMCPOAuthCode(serverId: string, data: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<{ status: string; credentialId: string }> {
    const response = await this.mcpOAuthService.exchangeMCPOAuthCode(serverId, data);
    return this.extractData(response);
  }

  // ============================================
  // OTHER RPC METHODS
  // ============================================

  async getGitHubRepos(boardId: string): Promise<Array<{
    id: number;
    name: string;
    fullName: string;
    owner: string;
    private: boolean;
    defaultBranch: string;
    description: string | null;
  }>> {
    const response = await this.boardService.getGitHubRepos(boardId);
    return this.extractData(response);
  }

  async getLinkMetadata(boardId: string, data: { url: string }): Promise<{
    type: string;
    title: string;
    id: string;
  } | null> {
    const response = await this.boardService.getLinkMetadata(boardId, data);
    const result = await response.json() as { success: boolean; data: object | null };
    return result.data as { type: string; title: string; id: string } | null;
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  private async extractData<T>(response: Response): Promise<T> {
    const result = await response.json() as { success?: boolean; data?: T; error?: string };
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data as T;
  }
}
