/**
 * SchemaConverter - Convert MCP tool schemas to TypeScript declarations
 *
 * Takes MCP tool schemas (JSON Schema format) and generates TypeScript
 * declarations that can be used by the planning agent to generate code.
 */

import type { MCPToolSchema, JSONSchema } from './MCPClient';

export interface TypeScriptDeclaration {
  serverId: string;
  serverName: string;
  declaration: string;
}

/**
 * Convert a collection of MCP tool schemas to TypeScript declarations
 */
export function mcpToolsToTypeScript(
  serverTools: Map<string, { name: string; tools: MCPToolSchema[] }>
): string {
  const declarations: string[] = [];

  declarations.push('// Auto-generated TypeScript declarations from MCP tool schemas');
  declarations.push('// Do not edit manually - regenerate from MCP servers');
  declarations.push('');

  for (const [serverId, { name, tools }] of serverTools) {
    const serverDeclaration = generateServerDeclaration(serverId, name, tools);
    declarations.push(serverDeclaration);
    declarations.push('');
  }

  // Add the workflow context declaration
  declarations.push(generateWorkflowContextDeclaration());

  return declarations.join('\n');
}

/**
 * Generate TypeScript declaration for a single MCP server
 */
function generateServerDeclaration(
  serverId: string,
  serverName: string,
  tools: MCPToolSchema[]
): string {
  const lines: string[] = [];

  // Sanitize server name for use as variable name
  const varName = sanitizeIdentifier(serverName);

  lines.push(`/** MCP Server: ${serverName} (${serverId}) */`);
  lines.push(`declare const ${varName}: {`);

  for (const tool of tools) {
    const methodDeclaration = generateToolMethodDeclaration(tool);
    lines.push(methodDeclaration);
  }

  lines.push('};');

  return lines.join('\n');
}

/**
 * Generate TypeScript method declaration for a single tool
 */
function generateToolMethodDeclaration(tool: MCPToolSchema): string {
  const lines: string[] = [];
  const methodName = sanitizeIdentifier(tool.name);

  // Add JSDoc comment
  if (tool.description) {
    lines.push(`  /**`);
    lines.push(`   * ${tool.description}`);

    // Add parameter descriptions from schema
    if (tool.inputSchema.properties) {
      for (const [propName, prop] of Object.entries(tool.inputSchema.properties)) {
        if (prop.description) {
          const required = tool.inputSchema.required?.includes(propName) ? '' : ' (optional)';
          lines.push(`   * @param ${propName} - ${prop.description}${required}`);
        }
      }
    }

    // Add return type info if we have outputSchema
    if (tool.outputSchema) {
      lines.push(`   * @returns ${tool.outputSchema.description || 'Tool result in structuredContent'}`);
    }

    lines.push(`   */`);
  }

  // Generate the method signature with specific return type if outputSchema is present
  const inputType = jsonSchemaToTypeScript(tool.inputSchema, 2);
  let returnType = 'MCPToolResult';

  if (tool.outputSchema) {
    const outputType = jsonSchemaToTypeScript(tool.outputSchema, 2);
    returnType = `MCPToolResult<${outputType}>`;
  }

  lines.push(`  ${methodName}(params: ${inputType}): Promise<${returnType}>;`);

  return lines.join('\n');
}

/**
 * Convert JSON Schema to TypeScript type string
 */
function jsonSchemaToTypeScript(schema: JSONSchema, indent = 0): string {
  // Handle union types
  if (schema.anyOf) {
    const types = schema.anyOf.map(s => jsonSchemaToTypeScript(s, indent));
    return types.join(' | ');
  }
  if (schema.oneOf) {
    const types = schema.oneOf.map(s => jsonSchemaToTypeScript(s, indent));
    return types.join(' | ');
  }

  // Handle enum types
  if (schema.enum) {
    const enumValues = schema.enum.map(v => {
      if (typeof v === 'string') return `'${v}'`;
      return String(v);
    });
    return enumValues.join(' | ');
  }

  switch (schema.type) {
    case 'object':
      return generateObjectType(schema, indent);

    case 'array':
      if (schema.items) {
        const itemType = jsonSchemaToTypeScript(schema.items, indent);
        return `${itemType}[]`;
      }
      return 'unknown[]';

    case 'string':
      if (schema.format === 'date-time') return 'string'; // ISO date string
      if (schema.format === 'uri') return 'string';
      return 'string';

    case 'number':
    case 'integer':
      return 'number';

    case 'boolean':
      return 'boolean';

    case 'null':
      return 'null';

    default:
      return 'unknown';
  }
}

/**
 * Generate TypeScript object type from JSON Schema
 */
function generateObjectType(schema: JSONSchema, indent: number): string {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return 'Record<string, unknown>';
  }

  const indentStr = '  '.repeat(indent);
  const propIndent = '  '.repeat(indent + 1);
  const lines: string[] = ['{'];

  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    const isRequired = schema.required?.includes(propName);
    const optional = isRequired ? '' : '?';
    const propType = jsonSchemaToTypeScript(propSchema, indent + 1);

    // Add property description as inline comment if short
    let comment = '';
    if (propSchema.description && propSchema.description.length < 60) {
      comment = ` // ${propSchema.description}`;
    }

    lines.push(`${propIndent}${sanitizePropertyName(propName)}${optional}: ${propType};${comment}`);
  }

  lines.push(`${indentStr}}`);
  return lines.join('\n');
}

/**
 * Generate the workflow context declaration
 */
function generateWorkflowContextDeclaration(): string {
  return `
/** Result from an MCP tool call */
interface MCPToolResult<T = unknown> {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** Typed result data - use this instead of parsing content[0].text */
  structuredContent: T;
  isError?: boolean;
}

/** Sandbox session info returned from createSession */
interface SandboxSession {
  sessionId: string;
  workDir: string;
  branch?: string;
}

/** Claude Code execution result */
interface ClaudeRunResult {
  success: boolean;
  output: string;
  filesModified: string[];
  exitCode: number;
}

/** Git diff result */
interface DiffResult {
  diff: string;
  stats: {
    files: number;
    additions: number;
    deletions: number;
  };
}

/** Git commit result */
interface CommitResult {
  success: boolean;
  commitHash: string;
}

/** Git push result */
interface PushResult {
  success: boolean;
  ref: string;
}

/** Sandbox MCP Server - always available for code execution tasks */
declare const Sandbox: {
  /** Create a sandbox session, optionally clone a repository */
  createSession(params: {
    repoUrl?: string;  // GitHub URL (token auto-injected)
    branch?: string;   // Branch to checkout (default: main)
    workDir?: string;  // Directory name (default: repo)
  }): Promise<MCPToolResult<SandboxSession>>;

  /** Execute Claude Code CLI with a task */
  runClaude(params: {
    sessionId: string;
    task: string;        // Task description
    context?: string;    // Additional context from previous steps
    timeout?: number;    // Timeout in seconds (default: 600)
  }): Promise<MCPToolResult<ClaudeRunResult>>;

  /** Get git diff of uncommitted changes */
  getDiff(params: {
    sessionId: string;
    staged?: boolean;    // Only staged changes (default: false)
  }): Promise<MCPToolResult<DiffResult>>;

  /** Commit current changes */
  commit(params: {
    sessionId: string;
    message: string;
  }): Promise<MCPToolResult<CommitResult>>;

  /** Push commits to remote */
  push(params: {
    sessionId: string;
    branch?: string;
  }): Promise<MCPToolResult<PushResult>>;

  /** Read a file from the sandbox */
  readFile(params: {
    sessionId: string;
    path: string;
  }): Promise<MCPToolResult<{ content: string }>>;

  /** Write a file to the sandbox */
  writeFile(params: {
    sessionId: string;
    path: string;
    content: string;
  }): Promise<MCPToolResult<{ success: boolean; bytesWritten: number }>>;

  /** Execute a shell command */
  exec(params: {
    sessionId: string;
    command: string;
    cwd?: string;
    timeout?: number;
  }): Promise<MCPToolResult<{ stdout: string; stderr: string; exitCode: number }>>;

  /** Cleanup and destroy a sandbox session */
  destroySession(params: {
    sessionId: string;
  }): Promise<MCPToolResult<{ success: boolean }>>;
};

/** Workflow execution context */
declare const ctx: {
  /** Mark the start of a named step for progress tracking */
  step(id: string): void;

  /** Log a message during workflow execution */
  log(message: string): void;

  /** Pause workflow for human approval */
  checkpoint(options: {
    message: string;
    data?: Record<string, unknown>;
    actions?: string[];
  }): Promise<{ action: string; [key: string]: unknown }>;

  /** Input parameters passed to the workflow */
  input: Record<string, unknown>;

  /** Results from previous steps, keyed by step ID */
  stepResults: Record<string, unknown>;
};
`;
}

/**
 * Sanitize a string to be a valid TypeScript identifier
 */
function sanitizeIdentifier(name: string): string {
  // Replace non-alphanumeric characters with underscores
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');

  // Ensure it doesn't start with a number
  if (/^[0-9]/.test(sanitized)) {
    sanitized = '_' + sanitized;
  }

  // Handle reserved words
  const reserved = ['break', 'case', 'catch', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'finally', 'for', 'function', 'if', 'in',
    'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'class', 'const', 'enum',
    'export', 'extends', 'import', 'super', 'implements', 'interface',
    'let', 'package', 'private', 'protected', 'public', 'static', 'yield'];

  if (reserved.includes(sanitized.toLowerCase())) {
    sanitized = sanitized + '_';
  }

  return sanitized;
}

/**
 * Sanitize a property name (may need quoting)
 */
function sanitizePropertyName(name: string): string {
  // If it's a valid identifier, use as-is
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return name;
  }

  // Otherwise, quote it
  return `'${name.replace(/'/g, "\\'")}'`;
}

/**
 * Generate a summary of available tools for the planning prompt
 */
export function generateToolsSummary(
  serverTools: Map<string, { name: string; tools: MCPToolSchema[] }>
): string {
  const lines: string[] = [];
  lines.push('## Available MCP Tools\n');

  for (const [serverId, { name, tools }] of serverTools) {
    lines.push(`### ${name} (${serverId})`);
    lines.push('');

    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description || 'No description'}`);

      // List parameters
      if (tool.inputSchema.properties) {
        const params = Object.entries(tool.inputSchema.properties)
          .map(([pName]) => {
            const required = tool.inputSchema.required?.includes(pName) ? '' : '?';
            return `\`${pName}${required}\``;
          })
          .join(', ');

        if (params) {
          lines.push(`  - Parameters: ${params}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
