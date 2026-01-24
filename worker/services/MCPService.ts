import { MCPClient, type MCPServerConfig } from '../mcp/MCPClient';
import { jsonResponse } from '../utils/response';
import { toCamelCase } from '../utils/transformations';
import type { CredentialService } from './CredentialService';

export class MCPService {
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
  // MCP SERVER CRUD
  // ============================================

  /**
   * Get all MCP servers for a board
   */
  getMCPServers(boardId: string): Response {
    const servers = this.sql.exec(
      'SELECT * FROM mcp_servers WHERE board_id = ? ORDER BY created_at DESC',
      boardId
    ).toArray();

    return jsonResponse({
      success: true,
      data: servers.map(s => this.transformServer(s as Record<string, unknown>))
    });
  }

  /**
   * Get a single MCP server by ID
   */
  getMCPServer(serverId: string): Response {
    const serverRow = this.sql.exec(
      'SELECT * FROM mcp_servers WHERE id = ?',
      serverId
    ).toArray()[0];

    if (!serverRow) {
      return jsonResponse({ error: 'MCP server not found' }, 404);
    }

    return jsonResponse({
      success: true,
      data: this.transformServer(serverRow as Record<string, unknown>)
    });
  }

  /**
   * Create a new MCP server
   */
  createMCPServer(boardId: string, data: {
    name: string;
    type: 'remote' | 'hosted';
    endpoint?: string;
    authType?: string;
    credentialId?: string;
    status?: string;
    transportType?: 'streamable-http' | 'sse';
    urlPatterns?: Array<{ pattern: string; type: string; fetchTool: string }>;
  }): Response {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO mcp_servers (id, board_id, name, type, endpoint, auth_type, credential_id, enabled, status, transport_type, url_patterns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      id,
      boardId,
      data.name,
      data.type,
      data.endpoint || null,
      data.authType || 'none',
      data.credentialId || null,
      data.status || 'disconnected',
      data.transportType || 'streamable-http',
      data.urlPatterns ? JSON.stringify(data.urlPatterns) : null,
      now,
      now
    );

    return this.getMCPServer(id);
  }

  /**
   * Create an account-based MCP server (Gmail, Google Docs, etc.)
   */
  async createAccountMCP(boardId: string, data: {
    accountId: string;
    mcpId: string;
  }): Promise<Response> {
    const { getAccountById, getMCPDefinition, getMCPTools } = await import('../mcp/AccountMCPRegistry');

    const account = getAccountById(data.accountId);
    if (!account) {
      return jsonResponse({
        success: false,
        error: { code: 'INVALID_ACCOUNT', message: `Unknown account: ${data.accountId}` }
      }, 400);
    }

    const mcpDef = getMCPDefinition(data.accountId, data.mcpId);
    if (!mcpDef) {
      return jsonResponse({
        success: false,
        error: { code: 'INVALID_MCP', message: `Unknown MCP: ${data.mcpId} for account ${data.accountId}` }
      }, 400);
    }

    const credentialId = this.credentialService.findCredentialId(boardId, account.credentialType);
    if (!credentialId) {
      return jsonResponse({
        success: false,
        error: { code: 'NO_CREDENTIAL', message: `${account.name} account not connected` }
      }, 400);
    }

    // Check if MCP already exists
    const existing = this.sql.exec(
      'SELECT id FROM mcp_servers WHERE board_id = ? AND name = ?',
      boardId,
      mcpDef.name
    ).toArray()[0];

    if (existing) {
      return jsonResponse({
        success: false,
        error: { code: 'ALREADY_EXISTS', message: `${mcpDef.name} MCP already exists` }
      }, 400);
    }

    // Create the MCP server
    const id = this.generateId();
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO mcp_servers (id, board_id, name, type, endpoint, auth_type, credential_id, enabled, status, url_patterns, created_at, updated_at)
       VALUES (?, ?, ?, 'hosted', NULL, 'oauth', ?, 1, 'connected', ?, ?, ?)`,
      id,
      boardId,
      mcpDef.name,
      credentialId,
      mcpDef.urlPatterns ? JSON.stringify(mcpDef.urlPatterns) : null,
      now,
      now
    );

    // Cache the tools
    const tools = getMCPTools(data.accountId, data.mcpId);
    for (const tool of tools) {
      const toolId = this.generateId();
      this.sql.exec(
        `INSERT INTO mcp_tool_schemas (id, server_id, name, description, input_schema, output_schema, approval_required_fields, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        toolId,
        id,
        tool.name,
        tool.description || null,
        JSON.stringify(tool.inputSchema),
        tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
        tool.approvalRequiredFields ? JSON.stringify(tool.approvalRequiredFields) : null,
        now
      );
    }

    return this.getMCPServer(id);
  }

  /**
   * Update an MCP server
   */
  updateMCPServer(serverId: string, data: {
    name?: string;
    endpoint?: string;
    authType?: string;
    credentialId?: string;
    enabled?: boolean;
    status?: string;
    transportType?: 'streamable-http' | 'sse';
  }): Response {
    const now = new Date().toISOString();
    const server = this.sql.exec('SELECT * FROM mcp_servers WHERE id = ?', serverId).toArray()[0];

    if (!server) {
      return jsonResponse({ error: 'MCP server not found' }, 404);
    }

    this.sql.exec(
      `UPDATE mcp_servers SET
        name = COALESCE(?, name),
        endpoint = COALESCE(?, endpoint),
        auth_type = COALESCE(?, auth_type),
        credential_id = COALESCE(?, credential_id),
        enabled = COALESCE(?, enabled),
        status = COALESCE(?, status),
        transport_type = COALESCE(?, transport_type),
        updated_at = ?
       WHERE id = ?`,
      data.name ?? null,
      data.endpoint ?? null,
      data.authType ?? null,
      data.credentialId ?? null,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : null,
      data.status ?? null,
      data.transportType ?? null,
      now,
      serverId
    );

    return this.getMCPServer(serverId);
  }

  /**
   * Delete an MCP server
   */
  deleteMCPServer(serverId: string): Response {
    const server = this.sql.exec('SELECT id FROM mcp_servers WHERE id = ?', serverId).toArray()[0];
    if (!server) {
      return jsonResponse({ error: 'MCP server not found' }, 404);
    }
    this.sql.exec('DELETE FROM mcp_tool_schemas WHERE server_id = ?', serverId);
    this.sql.exec('DELETE FROM mcp_servers WHERE id = ?', serverId);
    return jsonResponse({ success: true });
  }

  // ============================================
  // MCP TOOLS
  // ============================================

  /**
   * Get tools for an MCP server
   * For hosted MCPs, always returns fresh tools from the registry (no stale cache)
   * For external MCPs, returns cached tools
   */
  async getMCPServerTools(serverId: string): Promise<Response> {
    const server = this.sql.exec(
      'SELECT name, type FROM mcp_servers WHERE id = ?',
      serverId
    ).toArray()[0] as { name: string; type: string } | undefined;

    if (!server) {
      return jsonResponse({ success: true, data: [] });
    }

    if (server.type === 'hosted') {
      const { getAccountForMCPName, getMCPByName, getMCPTools } = await import('../mcp/AccountMCPRegistry');

      const account = getAccountForMCPName(server.name);
      const mcp = getMCPByName(server.name);

      if (account && mcp) {
        const tools = getMCPTools(account.id, mcp.id);
        return jsonResponse({
          success: true,
          data: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            approvalRequiredFields: t.approvalRequiredFields,
          }))
        });
      }
    }

    const tools = this.sql.exec(
      'SELECT * FROM mcp_tool_schemas WHERE server_id = ? ORDER BY name',
      serverId
    ).toArray();

    return jsonResponse({
      success: true,
      data: tools.map(t => this.transformTool(t as Record<string, unknown>))
    });
  }

  /**
   * Cache tools for an MCP server
   */
  async cacheMCPServerTools(serverId: string, data: {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: object;
      approvalRequiredFields?: string[];
    }>;
  }): Promise<Response> {
    const now = new Date().toISOString();

    this.sql.exec('DELETE FROM mcp_tool_schemas WHERE server_id = ?', serverId);

    for (const tool of data.tools) {
      const id = this.generateId();
      this.sql.exec(
        `INSERT INTO mcp_tool_schemas (id, server_id, name, description, input_schema, approval_required_fields, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        serverId,
        tool.name,
        tool.description || null,
        JSON.stringify(tool.inputSchema),
        tool.approvalRequiredFields ? JSON.stringify(tool.approvalRequiredFields) : null,
        now
      );
    }

    return await this.getMCPServerTools(serverId);
  }

  // ============================================
  // MCP CONNECTION
  // ============================================

  /**
   * Connect to a remote MCP server and discover tools
   */
  async connectMCPServer(serverId: string): Promise<Response> {
    const serverRow = this.sql.exec(
      'SELECT * FROM mcp_servers WHERE id = ?',
      serverId
    ).toArray()[0] as Record<string, unknown> | undefined;

    if (!serverRow) {
      return jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404);
    }

    const server = toCamelCase(serverRow) as {
      id: string;
      name: string;
      type: string;
      endpoint?: string;
      authType: string;
      credentialId?: string;
      transportType?: string;
    };

    if (server.type !== 'remote' || !server.endpoint) {
      return jsonResponse({
        success: false,
        error: { code: 'INVALID_SERVER', message: 'Only remote MCP servers can be connected' }
      }, 400);
    }

    try {
      const config: MCPServerConfig = {
        id: server.id,
        name: server.name,
        type: 'remote',
        endpoint: server.endpoint,
        authType: server.authType as MCPServerConfig['authType'],
        transportType: (server.transportType as MCPServerConfig['transportType']) || 'streamable-http',
      };

      // Get credentials if needed
      if (server.credentialId && ['bearer', 'api_key', 'oauth'].includes(server.authType)) {
        const credRow = this.credentialService.getCredentialRowById(server.credentialId);
        if (credRow) {
          const token = await this.credentialService.decrypt(credRow.encrypted_value);
          if (server.authType === 'oauth' || server.authType === 'bearer') {
            config.credentials = { token };
          } else {
            config.credentials = { apiKey: token };
          }
        }
      }

      const client = new MCPClient(config);
      await client.initialize();
      const tools = await client.listTools();

      // Cache discovered tools
      const now = new Date().toISOString();
      this.sql.exec('DELETE FROM mcp_tool_schemas WHERE server_id = ?', serverId);

      for (const tool of tools) {
        const id = this.generateId();
        this.sql.exec(
          `INSERT INTO mcp_tool_schemas (id, server_id, name, description, input_schema, approval_required_fields, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          serverId,
          tool.name,
          tool.description || null,
          JSON.stringify(tool.inputSchema),
          tool.approvalRequiredFields ? JSON.stringify(tool.approvalRequiredFields) : null,
          now
        );
      }

      // Update status
      this.sql.exec(
        "UPDATE mcp_servers SET status = 'connected', updated_at = ? WHERE id = ?",
        now,
        serverId
      );

      return jsonResponse({
        success: true,
        data: {
          status: 'connected',
          toolCount: tools.length,
          tools: tools.map(t => ({ name: t.name, description: t.description })),
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      const now = new Date().toISOString();
      this.sql.exec(
        "UPDATE mcp_servers SET status = 'error', updated_at = ? WHERE id = ?",
        now,
        serverId
      );

      return jsonResponse({
        success: false,
        error: { code: 'CONNECTION_FAILED', message }
      }, 500);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Get server row by ID (for OAuth service)
   */
  getServerRow(serverId: string): Record<string, unknown> | undefined {
    return this.sql.exec('SELECT * FROM mcp_servers WHERE id = ?', serverId).toArray()[0] as Record<string, unknown> | undefined;
  }

  /**
   * Update OAuth metadata for a server
   */
  updateOAuthMetadata(serverId: string, metadata: object): void {
    const now = new Date().toISOString();
    this.sql.exec(
      'UPDATE mcp_servers SET oauth_metadata = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(metadata),
      now,
      serverId
    );
  }

  /**
   * Update server credential and status
   */
  updateServerCredential(serverId: string, credentialId: string): void {
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE mcp_servers SET credential_id = ?, status = 'connected', updated_at = ? WHERE id = ?",
      credentialId,
      now,
      serverId
    );
  }

  private transformServer(row: Record<string, unknown>): Record<string, unknown> {
    const server = toCamelCase(row);
    if (typeof server.urlPatterns === 'string' && server.urlPatterns) {
      try {
        server.urlPatterns = JSON.parse(server.urlPatterns);
      } catch {
        server.urlPatterns = null;
      }
    }
    return server;
  }

  private transformTool(row: Record<string, unknown>): Record<string, unknown> {
    const tool = toCamelCase(row);
    if (typeof tool.inputSchema === 'string') {
      try {
        tool.inputSchema = JSON.parse(tool.inputSchema);
      } catch {
        // Leave as string
      }
    }
    if (typeof tool.approvalRequiredFields === 'string') {
      try {
        tool.approvalRequiredFields = JSON.parse(tool.approvalRequiredFields);
      } catch {
        // Leave as string
      }
    }
    return tool;
  }
}
