import { jsonResponse } from '../utils/response';
import { logger } from '../utils/logger';
import { CREDENTIAL_TYPES } from '../constants';
import { transformBoard, transformColumn, transformTask, toCamelCase } from '../utils/transformations';
import { getCredentialTypeForUrlPattern, type UrlPatternType } from '../mcp/AccountMCPRegistry';
import type { CredentialService } from './CredentialService';

interface TaskRow {
  id: string;
  column_id: string;
  board_id: string;
  title: string;
  description: string | null;
  priority: string;
  position: number;
  context: string | null;
  schedule_config: string | null;
  parent_task_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

export class BoardService {
  private sql: SqlStorage;
  private credentialService: CredentialService;
  private generateId: () => string;

  constructor(
    sql: SqlStorage,
    credentialService: CredentialService,
    generateId: () => string
  ) {
    this.sql = sql;
    this.credentialService = credentialService;
    this.generateId = generateId;
  }

  // ============================================
  // BOARD OPERATIONS
  // ============================================

  /**
   * Initialize a new board in this Durable Object
   */
  initBoard(data: { id: string; name: string; ownerId: string }): Response {
    const now = new Date().toISOString();

    const existing = this.sql.exec('SELECT id FROM boards WHERE id = ?', data.id).toArray()[0];
    if (existing) {
      return jsonResponse({ success: false, error: 'Board already initialized' }, 400);
    }

    this.sql.exec(
      'INSERT INTO boards (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      data.id, data.name, data.ownerId, now, now
    );

    // Create default columns
    const defaultColumns = ['Backlog', 'Doing', 'Done'];
    defaultColumns.forEach((name, position) => {
      const columnId = this.generateId();
      this.sql.exec(
        'INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
        columnId, data.id, name, position
      );
    });

    return this.getBoard(data.id);
  }

  /**
   * Get basic board info for access verification
   */
  getBoardInfo(): Response {
    const board = this.sql.exec('SELECT id, name, owner_id FROM boards').toArray()[0];
    if (!board) {
      return jsonResponse({ success: false, error: 'Board not initialized' }, 404);
    }

    const boardRecord = board as { id: string; name: string; owner_id: string };
    return jsonResponse({
      success: true,
      data: {
        id: boardRecord.id,
        name: boardRecord.name,
        ownerId: boardRecord.owner_id,
      },
    });
  }

  /**
   * Get a board with all columns and tasks
   */
  getBoard(id: string): Response {
    const board = this.sql.exec('SELECT * FROM boards WHERE id = ?', id).toArray()[0];
    if (!board) {
      return jsonResponse({ error: 'Board not found' }, 404);
    }

    const columns = this.sql.exec(
      'SELECT * FROM columns WHERE board_id = ? ORDER BY position',
      id
    ).toArray();

    const tasks = this.sql.exec(
      'SELECT * FROM tasks WHERE board_id = ? ORDER BY position',
      id
    ).toArray();

    return jsonResponse({
      success: true,
      data: {
        ...transformBoard(board as Record<string, unknown>),
        columns: columns.map(c => transformColumn(c as Record<string, unknown>)),
        tasks: tasks.map(t => transformTask(t as Record<string, unknown>))
      }
    });
  }

  /**
   * Update a board
   */
  updateBoard(id: string, data: { name?: string }): Response {
    const now = new Date().toISOString();
    this.sql.exec(
      'UPDATE boards SET name = COALESCE(?, name), updated_at = ? WHERE id = ?',
      data.name ?? null, now, id
    );
    return this.getBoard(id);
  }

  /**
   * Delete a board and all its data
   */
  deleteBoard(id: string): Response {
    this.sql.exec('DELETE FROM tasks WHERE board_id = ?', id);
    this.sql.exec('DELETE FROM columns WHERE board_id = ?', id);
    this.sql.exec('DELETE FROM boards WHERE id = ?', id);
    return jsonResponse({ success: true });
  }

  // ============================================
  // COLUMN OPERATIONS
  // ============================================

  /**
   * Create a new column
   */
  createColumn(boardId: string, data: { name: string }): Response {
    const id = this.generateId();

    const result = this.sql.exec(
      'SELECT MAX(position) as max_pos FROM columns WHERE board_id = ?',
      boardId
    ).toArray()[0] as { max_pos: number | null };
    const position = (result?.max_pos ?? -1) + 1;

    this.sql.exec(
      'INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
      id, boardId, data.name, position
    );

    const column = this.sql.exec('SELECT * FROM columns WHERE id = ?', id).toArray()[0];
    return jsonResponse({ success: true, data: transformColumn(column as Record<string, unknown>) });
  }

  /**
   * Update a column
   */
  updateColumn(id: string, data: { name?: string; position?: number }): Response {
    if (data.name !== undefined) {
      this.sql.exec('UPDATE columns SET name = ? WHERE id = ?', data.name, id);
    }

    if (data.position !== undefined) {
      const currentColumn = this.sql.exec(
        'SELECT position, board_id FROM columns WHERE id = ?', id
      ).toArray()[0] as { position: number; board_id: string } | undefined;

      if (currentColumn) {
        const oldPosition = currentColumn.position;
        const newPosition = data.position;
        const boardId = currentColumn.board_id;

        if (oldPosition !== newPosition) {
          if (oldPosition < newPosition) {
            this.sql.exec(
              `UPDATE columns SET position = position - 1
               WHERE board_id = ? AND position > ? AND position <= ?`,
              boardId, oldPosition, newPosition
            );
          } else {
            this.sql.exec(
              `UPDATE columns SET position = position + 1
               WHERE board_id = ? AND position >= ? AND position < ?`,
              boardId, newPosition, oldPosition
            );
          }
          this.sql.exec('UPDATE columns SET position = ? WHERE id = ?', newPosition, id);
        }
      }
    }

    const column = this.sql.exec('SELECT * FROM columns WHERE id = ?', id).toArray()[0];
    return jsonResponse({ success: true, data: transformColumn(column as Record<string, unknown>) });
  }

  /**
   * Delete a column
   */
  deleteColumn(id: string): Response {
    const column = this.sql.exec('SELECT id FROM columns WHERE id = ?', id).toArray()[0];
    if (!column) {
      return jsonResponse({ error: 'Column not found' }, 404);
    }
    this.sql.exec('DELETE FROM tasks WHERE column_id = ?', id);
    this.sql.exec('DELETE FROM columns WHERE id = ?', id);
    return jsonResponse({ success: true });
  }

  // ============================================
  // TASK OPERATIONS
  // ============================================

  /**
   * Create a new task
   */
  createTask(data: {
    columnId: string;
    boardId: string;
    title: string;
    description?: string;
    priority?: string;
    context?: object;
    scheduleConfig?: object;
    parentTaskId?: string;
    runId?: string;
  }): Response {
    const id = this.generateId();
    const now = new Date().toISOString();

    const result = this.sql.exec(
      'SELECT MAX(position) as max_pos FROM tasks WHERE column_id = ?',
      data.columnId
    ).toArray()[0] as { max_pos: number | null };
    const position = (result?.max_pos ?? -1) + 1;

    this.sql.exec(
      `INSERT INTO tasks (id, column_id, board_id, title, description, priority, position, context, schedule_config, parent_task_id, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      data.columnId,
      data.boardId,
      data.title,
      data.description ?? null,
      data.priority ?? 'medium',
      position,
      data.context ? JSON.stringify(data.context) : null,
      data.scheduleConfig ? JSON.stringify(data.scheduleConfig) : null,
      data.parentTaskId ?? null,
      data.runId ?? null,
      now,
      now
    );

    const task = this.sql.exec('SELECT * FROM tasks WHERE id = ?', id).toArray()[0];
    return jsonResponse({ success: true, data: transformTask(task as Record<string, unknown>) });
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): Response {
    const task = this.sql.exec('SELECT * FROM tasks WHERE id = ?', id).toArray()[0];
    if (!task) {
      return jsonResponse({ error: 'Task not found' }, 404);
    }
    return jsonResponse({ success: true, data: transformTask(task as Record<string, unknown>) });
  }

  /**
   * Update a task
   */
  updateTask(id: string, data: {
    title?: string;
    description?: string;
    priority?: string;
    context?: object;
    scheduleConfig?: object | null;
  }): Response {
    const now = new Date().toISOString();

    const task = this.sql.exec('SELECT * FROM tasks WHERE id = ?', id).toArray()[0] as unknown as TaskRow | undefined;
    if (!task) {
      return jsonResponse({ error: 'Task not found' }, 404);
    }

    // Handle scheduleConfig - null means remove, undefined means keep existing
    let scheduleConfigValue: string | null;
    if (data.scheduleConfig === null) {
      scheduleConfigValue = null;
    } else if (data.scheduleConfig !== undefined) {
      scheduleConfigValue = JSON.stringify(data.scheduleConfig);
    } else {
      scheduleConfigValue = task.schedule_config;
    }

    this.sql.exec(
      `UPDATE tasks SET
        title = ?,
        description = ?,
        priority = ?,
        context = ?,
        schedule_config = ?,
        updated_at = ?
       WHERE id = ?`,
      data.title ?? task.title,
      data.description ?? task.description,
      data.priority ?? task.priority,
      data.context ? JSON.stringify(data.context) : task.context,
      scheduleConfigValue,
      now,
      id
    );

    const updated = this.sql.exec('SELECT * FROM tasks WHERE id = ?', id).toArray()[0];
    return jsonResponse({ success: true, data: transformTask(updated as Record<string, unknown>) });
  }

  /**
   * Delete a task
   */
  deleteTask(id: string): Response {
    const task = this.sql.exec('SELECT id FROM tasks WHERE id = ?', id).toArray()[0];
    if (!task) {
      return jsonResponse({ error: 'Task not found' }, 404);
    }
    this.sql.exec('DELETE FROM tasks WHERE id = ?', id);
    return jsonResponse({ success: true });
  }

  /**
   * Move a task to a different column/position
   */
  moveTask(id: string, data: { columnId: string; position: number }): Response {
    const now = new Date().toISOString();

    const currentTask = this.sql.exec(
      'SELECT column_id, position FROM tasks WHERE id = ?', id
    ).toArray()[0] as { column_id: string; position: number } | undefined;

    if (!currentTask) {
      return jsonResponse({ error: 'Task not found' }, 404);
    }

    const sourceColumnId = currentTask.column_id;
    const oldPosition = currentTask.position;
    const targetColumnId = data.columnId;
    const newPosition = data.position;

    if (sourceColumnId === targetColumnId) {
      // Same column reorder
      if (oldPosition < newPosition) {
        this.sql.exec(
          `UPDATE tasks SET position = position - 1
           WHERE column_id = ? AND position > ? AND position <= ? AND id != ?`,
          targetColumnId, oldPosition, newPosition, id
        );
      } else if (oldPosition > newPosition) {
        this.sql.exec(
          `UPDATE tasks SET position = position + 1
           WHERE column_id = ? AND position >= ? AND position < ? AND id != ?`,
          targetColumnId, newPosition, oldPosition, id
        );
      }
    } else {
      // Cross-column move
      this.sql.exec(
        `UPDATE tasks SET position = position - 1
         WHERE column_id = ? AND position > ?`,
        sourceColumnId, oldPosition
      );
      this.sql.exec(
        `UPDATE tasks SET position = position + 1
         WHERE column_id = ? AND position >= ?`,
        targetColumnId, newPosition
      );
    }

    this.sql.exec(
      'UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?',
      targetColumnId, newPosition, now, id
    );

    const task = this.sql.exec('SELECT * FROM tasks WHERE id = ?', id).toArray()[0];
    return jsonResponse({ success: true, data: transformTask(task as Record<string, unknown>) });
  }

  /**
   * Validate that a task exists (for generate-plan endpoint)
   */
  validateTaskExists(taskId: string): Response {
    const task = this.sql.exec('SELECT * FROM tasks WHERE id = ?', taskId).toArray()[0];
    if (!task) {
      return jsonResponse({ error: 'Task not found' }, 404);
    }
    return jsonResponse({ success: true, data: transformTask(task as Record<string, unknown>) });
  }

  // ============================================
  // LINK METADATA (for link pills)
  // ============================================

  /**
   * Get metadata for a URL to display as a link pill
   */
  async getLinkMetadata(boardId: string, data: { url: string }): Promise<Response> {
    const { url } = data;
    if (!url) {
      return jsonResponse({
        success: false,
        error: { code: 'MISSING_URL', message: 'URL is required' }
      }, 400);
    }

    // Get all MCP servers with URL patterns
    const servers = this.sql.exec(
      "SELECT * FROM mcp_servers WHERE board_id = ? AND url_patterns IS NOT NULL AND status = 'connected'",
      boardId
    ).toArray();

    for (const serverRow of servers) {
      const server = toCamelCase(serverRow as Record<string, unknown>) as {
        id: string;
        name: string;
        credentialId?: string;
        urlPatterns: string;
      };

      let patterns: Array<{ pattern: string; type: string; fetchTool: string }>;
      try {
        patterns = JSON.parse(server.urlPatterns);
      } catch {
        continue;
      }

      for (const patternDef of patterns) {
        const regex = new RegExp(patternDef.pattern);
        const match = url.match(regex);

        if (match) {
          try {
            const metadata = await this.fetchLinkMetadataFromMCP(
              boardId,
              server.name,
              server.credentialId,
              patternDef.fetchTool,
              patternDef.type,
              url,
              match
            );

            if (metadata) {
              return jsonResponse({ success: true, data: metadata });
            }
          } catch (error) {
            logger.board.error('Failed to fetch link metadata', { url, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }

    return jsonResponse({ success: true, data: null });
  }

  /**
   * Fetch metadata from an MCP server for a matched URL
   */
  private async fetchLinkMetadataFromMCP(
    boardId: string,
    _serverName: string,
    _credentialId: string | undefined,
    fetchTool: string,
    type: string,
    _url: string,
    match: RegExpMatchArray
  ): Promise<{ type: string; title: string; id: string } | null> {
    const credentialType = getCredentialTypeForUrlPattern(type as UrlPatternType);
    if (!credentialType) {
      return null;
    }

    const accessToken = await this.credentialService.getValidAccessToken(boardId, credentialType);
    if (!accessToken) {
      return null;
    }

    switch (type) {
      case 'google_doc': {
        const documentId = match[1];
        const { DocsMCPServer } = await import('../google/DocsMCP');
        const mcp = new DocsMCPServer(accessToken);
        const result = await mcp.callTool(fetchTool, { documentId });
        const data = result?.structuredContent as { title?: string } | undefined;
        if (data?.title) {
          return { type: 'google_doc', title: data.title, id: documentId };
        }
        break;
      }
      case 'google_sheet': {
        const spreadsheetId = match[1];
        const { SheetsMCPServer } = await import('../google/SheetsMCP');
        const mcp = new SheetsMCPServer(accessToken);
        const result = await mcp.callTool(fetchTool, { spreadsheetId });
        const data = result?.structuredContent as { title?: string } | undefined;
        if (data?.title) {
          return { type: 'google_sheet', title: data.title, id: spreadsheetId };
        }
        break;
      }
      case 'github_pr': {
        const [, owner, repo, prNumber] = match;
        const { GitHubMCPServer } = await import('../github/GitHubMCP');
        const mcp = new GitHubMCPServer(accessToken);
        const result = await mcp.callTool(fetchTool, { owner, repo, pullNumber: parseInt(prNumber, 10) });
        const data = result?.structuredContent as { title?: string } | undefined;
        if (data?.title) {
          return { type: 'github_pr', title: data.title, id: `${owner}/${repo}#${prNumber}` };
        }
        break;
      }
      case 'github_issue': {
        const [, owner, repo, issueNumber] = match;
        const { GitHubMCPServer } = await import('../github/GitHubMCP');
        const mcp = new GitHubMCPServer(accessToken);
        const result = await mcp.callTool(fetchTool, { owner, repo, issueNumber: parseInt(issueNumber, 10) });
        const data = result?.structuredContent as { title?: string } | undefined;
        if (data?.title) {
          return { type: 'github_issue', title: data.title, id: `${owner}/${repo}#${issueNumber}` };
        }
        break;
      }
      case 'github_repo': {
        const [, owner, repo] = match;
        const { GitHubMCPServer } = await import('../github/GitHubMCP');
        const mcp = new GitHubMCPServer(accessToken);
        const result = await mcp.callTool(fetchTool, { owner, repo });
        const data = result?.structuredContent as { title?: string; full_name?: string } | undefined;
        const title = data?.title || data?.full_name;
        if (title) {
          return { type: 'github_repo', title, id: `${owner}/${repo}` };
        }
        break;
      }
    }

    return null;
  }

  // ============================================
  // GITHUB OPERATIONS
  // ============================================

  /**
   * Get GitHub repos for a board
   */
  async getGitHubRepos(boardId: string): Promise<Response> {
    const accessToken = await this.credentialService.getCredentialValue(boardId, CREDENTIAL_TYPES.GITHUB_OAUTH);

    if (!accessToken) {
      return jsonResponse({
        success: false,
        error: { code: 'NOT_CONNECTED', message: 'GitHub not connected' }
      }, 400);
    }

    try {
      const response = await fetch(
        'https://api.github.com/user/repos?sort=updated&direction=desc&per_page=50',
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Weft-App',
          },
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          return jsonResponse({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'GitHub token expired or invalid' }
          }, 401);
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const repos = await response.json() as Array<{
        id: number;
        name: string;
        full_name: string;
        owner: { login: string };
        private: boolean;
        default_branch: string;
        description: string | null;
      }>;

      return jsonResponse({
        success: true,
        data: repos.map(repo => ({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          owner: repo.owner.login,
          private: repo.private,
          defaultBranch: repo.default_branch,
          description: repo.description,
        }))
      });
    } catch (error) {
      logger.board.error('GitHub repos error', { error: error instanceof Error ? error.message : String(error) });
      return jsonResponse({
        success: false,
        error: { code: 'GITHUB_ERROR', message: error instanceof Error ? error.message : 'Failed to fetch repos' }
      }, 500);
    }
  }
}
