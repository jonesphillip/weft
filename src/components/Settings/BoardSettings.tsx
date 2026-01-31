import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Modal } from '../common';
import { GeneralSection } from './sections/GeneralSection';
import { CredentialsSection } from './sections/CredentialsSection';
import { IntegrationsSection } from './sections/IntegrationsSection';
import { DangerSection } from './sections/DangerSection';
import { useBoard } from '../../context/BoardContext';
import type { BoardCredential, MCPServer } from '../../types';
import * as api from '../../api/client';
import './BoardSettings.css';

type SettingsTab = 'general' | 'credentials' | 'integrations' | 'danger';

const GEAR_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const LOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const INTEGRATIONS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <circle cx="9" cy="9" r="1.5" fill="currentColor" />
    <circle cx="15" cy="9" r="1.5" fill="currentColor" />
    <path d="M9 15h6" />
  </svg>
);

const WARNING_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'general', label: 'General', icon: GEAR_ICON },
  { id: 'credentials', label: 'Credentials', icon: LOCK_ICON },
  { id: 'integrations', label: 'Integrations', icon: INTEGRATIONS_ICON },
  { id: 'danger', label: 'Danger Zone', icon: WARNING_ICON },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function isSettingsTab(value: string): value is SettingsTab {
  return TAB_IDS.has(value);
}

const mainTabs = TABS.filter((t) => t.id !== 'danger');
const dangerTab = TABS.find((t) => t.id === 'danger')!;

interface BoardSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
}

export function BoardSettings({ isOpen, onClose, initialTab }: BoardSettingsProps) {
  const { activeBoard, renameBoard, deleteBoard } = useBoard();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [credentials, setCredentials] = useState<BoardCredential[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<'github' | 'google' | null>(null);

  const loadCredentials = useCallback(async () => {
    if (!activeBoard) return;
    setLoading(true);
    setError(null);
    const result = await api.getCredentials(activeBoard.id);
    if (result.success && result.data) {
      setCredentials(result.data);
    } else {
      setError(result.error?.message || 'Failed to load credentials');
    }
    setLoading(false);
  }, [activeBoard]);

  const loadMcpServers = useCallback(async () => {
    if (!activeBoard) return;
    const result = await api.getMCPServers(activeBoard.id);
    if (result.success && result.data) {
      setMcpServers(result.data);
    }
  }, [activeBoard]);

  useEffect(() => {
    const providers = [
      { key: 'github', label: 'GitHub' },
      { key: 'google', label: 'Google' },
    ];

    let changed = false;
    for (const { key, label } of providers) {
      if (searchParams.get(key) === 'connected') {
        if (activeBoard) loadCredentials();
        searchParams.delete(key);
        changed = true;
      }
      const errorParam = searchParams.get(`${key}_error`);
      if (errorParam) {
        setError(`${label} connection failed: ${errorParam}`);
        searchParams.delete(`${key}_error`);
        changed = true;
      }
    }
    if (changed) {
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, activeBoard, loadCredentials]);

  useEffect(() => {
    if (isOpen && activeBoard) {
      setActiveTab(initialTab && isSettingsTab(initialTab) ? initialTab : 'general');
      loadCredentials();
      loadMcpServers();
    }
  }, [isOpen, activeBoard, initialTab, loadCredentials, loadMcpServers]);

  const handleDeleteCredential = async (credentialId: string) => {
    if (!activeBoard) return;

    const result = await api.deleteCredential(activeBoard.id, credentialId);
    if (result.success) {
      setCredentials((prev) => prev.filter((c) => c.id !== credentialId));
    } else {
      setError(result.error?.message || 'Failed to delete credential');
    }
  };

  const handleConnect = async (provider: 'github' | 'google') => {
    if (!activeBoard) return;

    setConnecting(provider);
    setError(null);

    const getUrl = provider === 'github' ? api.getGitHubOAuthUrl : api.getGoogleOAuthUrl;
    const result = await getUrl(activeBoard.id);

    if (result.success && result.data) {
      window.location.href = result.data.url;
    } else {
      setError(result.error?.message || `Failed to connect ${provider}`);
      setConnecting(null);
    }
  };

  const handleCredentialAdded = (credential: BoardCredential) => {
    setCredentials((prev) => {
      const existing = prev.findIndex((c) => c.type === credential.type);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = credential;
        return updated;
      }
      return [...prev, credential];
    });
  };

  const handleMcpServerAdded = (server: MCPServer) => {
    setMcpServers((prev) => [...prev, server]);
  };

  const handleMcpServerDeleted = (serverId: string) => {
    setMcpServers((prev) => prev.filter((s) => s.id !== serverId));
  };

  if (!activeBoard) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Board Settings" width="settings">
      <div className="settings-layout">
        <nav className="settings-sidebar">
          <ul className="settings-nav">
            {mainTabs.map((tab) => (
              <li key={tab.id}>
                <button
                  className={`settings-nav-item ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="settings-nav-icon">{tab.icon}</span>
                  <span className="settings-nav-label">{tab.label}</span>
                </button>
              </li>
            ))}
          </ul>

          <ul className="settings-nav settings-nav-danger">
            <li>
              <button
                className={`settings-nav-item danger ${activeTab === 'danger' ? 'active' : ''}`}
                onClick={() => setActiveTab('danger')}
              >
                <span className="settings-nav-icon">{dangerTab.icon}</span>
                <span className="settings-nav-label">{dangerTab.label}</span>
              </button>
            </li>
          </ul>
        </nav>

        <div className="settings-content">
          {error && <div className="settings-error">{error}</div>}

          {activeTab === 'general' && (
            <GeneralSection
              board={activeBoard}
              onRename={(name) => renameBoard(activeBoard.id, name)}
            />
          )}

          {activeTab === 'credentials' && (
            <CredentialsSection
              boardId={activeBoard.id}
              credentials={credentials}
              loading={loading}
              connecting={connecting}
              onConnect={handleConnect}
              onDeleteCredential={handleDeleteCredential}
              onCredentialAdded={handleCredentialAdded}
            />
          )}

          {activeTab === 'integrations' && (
            <IntegrationsSection
              boardId={activeBoard.id}
              credentials={credentials}
              mcpServers={mcpServers}
              onMcpServerAdded={handleMcpServerAdded}
              onMcpServerDeleted={handleMcpServerDeleted}
              onConnectAccount={handleConnect}
              connectingAccount={connecting}
            />
          )}

          {activeTab === 'danger' && (
            <DangerSection
              board={activeBoard}
              onDelete={() => {
                deleteBoard(activeBoard.id);
                onClose();
                navigate('/');
              }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
