import { useState, useEffect, useRef } from 'react';
import { MCPServerConnect } from '../../MCP/MCPServerConnect';
import { CREDENTIAL_TYPES, type BoardCredential, type MCPServer, type MCPTool } from '../../../types';
import * as api from '../../../api/client';

function ToolsMore({ count, tools }: { count: number; tools: string[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <span
      ref={ref}
      className="tools-more"
      onMouseEnter={() => {
        if (ref.current) {
          const rect = ref.current.getBoundingClientRect();
          setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
        }
      }}
      onMouseLeave={() => setTooltipPos(null)}
    >
      +{count} more
      {tooltipPos && (
        <span
          className="tools-tooltip"
          style={{
            position: 'fixed',
            left: tooltipPos.x,
            top: tooltipPos.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          {tools.join(', ')}
        </span>
      )}
    </span>
  );
}

const ACCOUNT_MCPS = [
  {
    accountId: 'google',
    credentialType: CREDENTIAL_TYPES.GOOGLE_OAUTH,
    mcps: [
      { id: 'gmail', name: 'Gmail', description: 'Read, send, and search emails' },
      { id: 'google-docs', name: 'Google Docs', description: 'Create and edit documents' },
      { id: 'google-sheets', name: 'Google Sheets', description: 'Create and edit spreadsheets' },
    ],
  },
  {
    accountId: 'github',
    credentialType: CREDENTIAL_TYPES.GITHUB_OAUTH,
    mcps: [
      { id: 'github', name: 'GitHub', description: 'Repositories, issues, pull requests' },
    ],
  },
];

const GITHUB_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
  </svg>
);

const MCP_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <circle cx="9" cy="9" r="1.5" fill="currentColor" />
    <circle cx="15" cy="9" r="1.5" fill="currentColor" />
    <path d="M9 15h6" />
  </svg>
);

const GOOGLE_ICON = (
  <svg viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

const MAX_VISIBLE_TOOLS = 3;

const GOOGLE_SERVICES = new Set(['Gmail', 'Google Docs', 'Google Sheets']);

const ACCOUNT_DESCRIPTIONS: Record<string, { name: string; description: string }> = {
  github: { name: 'GitHub', description: 'Connect to add repositories, issues, pull requests' },
  google: { name: 'Google', description: 'Connect to add Gmail, Docs, Sheets' },
};

function AddIntegrationView({
  boardId,
  unconnectedAccounts,
  availableAccountMCPs,
  onBack,
  onConnectAccount,
  connectingAccount,
  onAddAccountMCP,
  addingAccountMCP,
  onServerAdded,
}: {
  boardId: string;
  unconnectedAccounts: { accountId: 'github' | 'google'; name: string; description: string }[];
  availableAccountMCPs: { accountId: string; mcpId: string; name: string; description: string }[];
  onBack: () => void;
  onConnectAccount: (provider: 'github' | 'google') => void;
  connectingAccount: 'github' | 'google' | null;
  onAddAccountMCP: (accountId: string, mcpId: string) => void;
  addingAccountMCP: string | null;
  onServerAdded: (server: MCPServer) => void;
}) {
  const [showMCPForm, setShowMCPForm] = useState(false);

  if (showMCPForm) {
    return (
      <div className="settings-page">
        {/* Back navigation */}
        <button className="detail-back-btn" onClick={() => setShowMCPForm(false)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back
        </button>

        {/* Header */}
        <div className="detail-header">
          <h2 className="detail-title">Custom MCP Server</h2>
        </div>

        <div className="settings-section">
          <MCPServerConnect
            boardId={boardId}
            onClose={() => setShowMCPForm(false)}
            onServerAdded={(server) => {
              onServerAdded(server);
              onBack();
            }}
            inline
          />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      {/* Back navigation */}
      <button className="detail-back-btn" onClick={onBack}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Back to Integrations
      </button>

      {/* Header */}
      <div className="detail-header">
        <h2 className="detail-title">Add Integration</h2>
      </div>

      {/* Integration Options */}
      <div className="settings-section">
        <div className="settings-section-header">
          <p className="settings-section-description">
            Choose a service to connect to your board
          </p>
        </div>

        <div className="add-options-list">
          {/* Unconnected accounts - need OAuth first */}
          {unconnectedAccounts.map((account) => (
            <button
              key={account.accountId}
              className="settings-card integration-card clickable"
              onClick={() => onConnectAccount(account.accountId)}
              disabled={connectingAccount === account.accountId}
            >
              <div className="settings-card-left">
                <div className={`settings-card-icon ${account.accountId}`}>
                  {account.accountId === 'github' ? GITHUB_ICON : GOOGLE_ICON}
                </div>
                <div className="settings-card-info">
                  <span className="settings-card-name">{account.name}</span>
                  <span className="settings-card-meta">{account.description}</span>
                </div>
              </div>
              {connectingAccount === account.accountId && (
                <span className="add-option-spinner" />
              )}
            </button>
          ))}

          {/* Account-based MCPs (already connected) */}
          {availableAccountMCPs.map((mcp) => (
            <button
              key={mcp.mcpId}
              className="settings-card integration-card clickable"
              onClick={() => onAddAccountMCP(mcp.accountId, mcp.mcpId)}
              disabled={addingAccountMCP === mcp.mcpId}
            >
              <div className="settings-card-left">
                <div className={`settings-card-icon ${mcp.accountId}`}>
                  {mcp.accountId === 'github' ? GITHUB_ICON : GOOGLE_ICON}
                </div>
                <div className="settings-card-info">
                  <span className="settings-card-name">{mcp.name}</span>
                  <span className="settings-card-meta">{mcp.description}</span>
                </div>
              </div>
              {addingAccountMCP === mcp.mcpId && (
                <span className="add-option-spinner" />
              )}
            </button>
          ))}

          {/* Custom MCP option */}
          <button
            className="settings-card integration-card clickable"
            onClick={() => setShowMCPForm(true)}
          >
            <div className="settings-card-left">
              <div className="settings-card-icon">{MCP_ICON}</div>
              <div className="settings-card-info">
                <span className="settings-card-name">Custom MCP Server</span>
                <span className="settings-card-meta">Connect any MCP-compatible server</span>
              </div>
            </div>
            <svg className="settings-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

interface IntegrationsSectionProps {
  boardId: string;
  credentials: BoardCredential[];
  mcpServers: MCPServer[];
  onMcpServerAdded: (server: MCPServer) => void;
  onMcpServerDeleted: (serverId: string) => void;
  onConnectAccount: (provider: 'github' | 'google') => void;
  connectingAccount: 'github' | 'google' | null;
}

export function IntegrationsSection({
  boardId,
  credentials,
  mcpServers,
  onMcpServerAdded,
  onMcpServerDeleted,
  onConnectAccount,
  connectingAccount,
}: IntegrationsSectionProps) {
  const [showAddView, setShowAddView] = useState(false);
  const [serverTools, setServerTools] = useState<Record<string, MCPTool[]>>({});
  const [addingAccountMCP, setAddingAccountMCP] = useState<string | null>(null);

  const loadServerTools = async (serverId: string) => {
    const result = await api.getMCPServerTools(boardId, serverId);
    if (result.success && result.data) {
      setServerTools((prev) => ({ ...prev, [serverId]: result.data! }));
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- only fetch tools when the server list changes
  useEffect(() => {
    mcpServers.forEach((server) => {
      if (!serverTools[server.id]) {
        loadServerTools(server.id);
      }
    });
  }, [mcpServers]);

  const handleDeleteMCP = async (serverId: string) => {
    const result = await api.deleteMCPServer(boardId, serverId);
    if (result.success) {
      onMcpServerDeleted(serverId);
    }
  };

  const handleAddAccountMCP = async (accountId: string, mcpId: string) => {
    setAddingAccountMCP(mcpId);
    try {
      const result = await api.createAccountMCP(boardId, accountId, mcpId);
      if (result.success && result.data) {
        onMcpServerAdded(result.data);
        loadServerTools(result.data.id);
        setShowAddView(false);
      }
    } finally {
      setAddingAccountMCP(null);
    }
  };

  const getAccountInfo = (server: MCPServer): string | null => {
    if (!server.credentialId) return null;
    const cred = credentials.find((c) => c.id === server.credentialId);
    if (cred?.type === CREDENTIAL_TYPES.GOOGLE_OAUTH) {
      return cred.metadata?.email as string || null;
    }
    if (cred?.type === CREDENTIAL_TYPES.GITHUB_OAUTH) {
      const login = cred.metadata?.login as string | undefined;
      return login ? `@${login}` : null;
    }
    return null;
  };

  const getServerBranding = (server: MCPServer): { iconClass: string; icon: React.ReactNode } => {
    if (server.name === 'GitHub') {
      return { iconClass: 'github', icon: GITHUB_ICON };
    }
    if (GOOGLE_SERVICES.has(server.name)) {
      return { iconClass: 'google', icon: GOOGLE_ICON };
    }
    return { iconClass: '', icon: MCP_ICON };
  };

  const renderTools = (tools: string[]) => {
    if (tools.length === 0) return null;
    if (tools.length <= MAX_VISIBLE_TOOLS) return tools.join(', ');

    const visible = tools.slice(0, MAX_VISIBLE_TOOLS);
    const hidden = tools.slice(MAX_VISIBLE_TOOLS);

    return (
      <>
        {visible.join(', ')}{' '}
        <ToolsMore count={hidden.length} tools={hidden} />
      </>
    );
  };

  const handleMCPServerAdded = (server: MCPServer) => {
    onMcpServerAdded(server);
    setShowAddView(false);
    loadServerTools(server.id);
  };

  const getAvailableAccountMCPs = () => {
    const available: Array<{
      accountId: string;
      mcpId: string;
      name: string;
      description: string;
    }> = [];

    for (const account of ACCOUNT_MCPS) {
      const credential = credentials.find((c) => c.type === account.credentialType);
      if (!credential) continue;

      for (const mcp of account.mcps) {
        const alreadyAdded = mcpServers.some(
          (s) => s.name === mcp.name || s.name.toLowerCase() === mcp.id
        );
        if (!alreadyAdded) {
          available.push({
            accountId: account.accountId,
            mcpId: mcp.id,
            name: mcp.name,
            description: mcp.description,
          });
        }
      }
    }

    return available;
  };

  const getUnconnectedAccounts = () => {
    return ACCOUNT_MCPS
      .filter((account) => !credentials.find((c) => c.type === account.credentialType))
      .map((account) => ({
        accountId: account.accountId as 'github' | 'google',
        ...ACCOUNT_DESCRIPTIONS[account.accountId],
      }));
  };

  const availableAccountMCPs = getAvailableAccountMCPs();
  const unconnectedAccounts = getUnconnectedAccounts();

  if (showAddView) {
    return (
      <AddIntegrationView
        boardId={boardId}
        unconnectedAccounts={unconnectedAccounts}
        availableAccountMCPs={availableAccountMCPs}
        onBack={() => setShowAddView(false)}
        onConnectAccount={onConnectAccount}
        connectingAccount={connectingAccount}
        onAddAccountMCP={handleAddAccountMCP}
        addingAccountMCP={addingAccountMCP}
        onServerAdded={handleMCPServerAdded}
      />
    );
  }

  return (
    <div className="settings-page">
      {/* Built-in Integrations Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">Built-in Integrations</h2>
          <p className="settings-section-description">
            Pre-configured tool providers for common services
          </p>
        </div>

        <div className="integrations-list">
          <button
            className="settings-card integration-card clickable integration-add-card"
            onClick={() => setShowAddView(true)}
          >
            <div className="settings-card-left">
              <div className="settings-card-icon integration-add-icon">+</div>
              <div className="settings-card-info">
                <span className="settings-card-name">Add Integration</span>
              </div>
            </div>
          </button>

          {mcpServers.map((server) => {
            const tools = serverTools[server.id] || [];
            const toolNames = tools.map((t) => t.name);
            const accountInfo = getAccountInfo(server);
            const branding = getServerBranding(server);

            return (
              <div key={server.id} className="settings-card integration-card">
                <div className="settings-card-left">
                  <div className={`settings-card-icon ${branding.iconClass}`}>
                    {branding.icon}
                  </div>
                  <div className="settings-card-info">
                    <span className="settings-card-name">
                      {server.name}
                      {accountInfo && (
                        <span className="settings-card-account"> ({accountInfo})</span>
                      )}
                    </span>
                    <span className="settings-card-meta">
                      {toolNames.length > 0
                        ? renderTools(toolNames)
                        : server.status}
                    </span>
                  </div>
                </div>
                <button
                  className="settings-delete-btn"
                  onClick={() => handleDeleteMCP(server.id)}
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            );
          })}

        </div>
      </div>
    </div>
  );
}
