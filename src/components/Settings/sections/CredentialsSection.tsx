import { useState } from 'react';
import { Button, Input } from '../../common';
import { AccountsSection } from '../AccountsSection';
import { CREDENTIAL_TYPES, type BoardCredential } from '../../../types';
import * as api from '../../../api/client';

interface CredentialsSectionProps {
  boardId: string;
  credentials: BoardCredential[];
  loading: boolean;
  connecting: 'github' | 'google' | null;
  onConnect: (provider: 'github' | 'google') => void;
  onDeleteCredential: (credentialId: string) => void;
  onCredentialAdded: (credential: BoardCredential) => void;
}

export function CredentialsSection({
  boardId,
  credentials,
  loading,
  connecting,
  onConnect,
  onDeleteCredential,
  onCredentialAdded,
}: CredentialsSectionProps) {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyName, setApiKeyName] = useState('');
  const [showApiKeyForm, setShowApiKeyForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const anthropicKeys = credentials.filter(
    (c) => c.type === CREDENTIAL_TYPES.ANTHROPIC_API_KEY
  );
  const hasExistingKey = anthropicKeys.length > 0;

  function getSubmitLabel(): string {
    if (saving) return 'Saving...';
    if (hasExistingKey) return 'Replace';
    return 'Save';
  }

  const handleAddApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;

    setSaving(true);

    // Delete any existing Anthropic API key first (replace behavior)
    const existingKey = credentials.find(
      (c) => c.type === CREDENTIAL_TYPES.ANTHROPIC_API_KEY
    );
    if (existingKey) {
      await api.deleteCredential(boardId, existingKey.id);
    }

    const result = await api.createCredential(boardId, {
      type: CREDENTIAL_TYPES.ANTHROPIC_API_KEY,
      name: apiKeyName.trim() || 'Anthropic API Key',
      value: apiKeyInput.trim(),
    });

    if (result.success && result.data) {
      onCredentialAdded(result.data);
      setApiKeyInput('');
      setApiKeyName('');
      setShowApiKeyForm(false);
    }

    setSaving(false);
  };

  return (
    <div className="settings-page">
      {/* Anthropic API Key Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">Anthropic API Key</h2>
          <p className="settings-section-description">
            Required to power the AI agent for task execution
          </p>
        </div>

        {loading && (
          <div className="settings-loading">Loading...</div>
        )}

        {!loading && !showApiKeyForm && hasExistingKey && (
          <div className="settings-card">
            <div className="settings-card-left">
              <div className="settings-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <div className="settings-card-info">
                <span className="settings-card-name">{anthropicKeys[0].name}</span>
                <span className="settings-card-meta">sk-ant-...****</span>
              </div>
            </div>
            <div className="settings-card-actions">
              <button
                className="settings-text-btn"
                onClick={() => setShowApiKeyForm(true)}
              >
                Replace
              </button>
              <button
                className="settings-delete-btn"
                onClick={() => onDeleteCredential(anthropicKeys[0].id)}
                title="Remove API key"
              >
                &times;
              </button>
            </div>
          </div>
        )}

        {!loading && !showApiKeyForm && !hasExistingKey && (
          <div className="settings-empty">
            <p>No API key configured</p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowApiKeyForm(true)}
            >
              + Add API Key
            </Button>
          </div>
        )}

        {!loading && showApiKeyForm && (
          <form className="settings-form" onSubmit={handleAddApiKey}>
            <Input
              label="Name (optional)"
              placeholder="My API Key"
              value={apiKeyName}
              onChange={(e) => setApiKeyName(e.target.value)}
            />
            <Input
              label="API Key"
              type="password"
              placeholder="sk-ant-..."
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              autoFocus
            />
            <div className="settings-form-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowApiKeyForm(false);
                  setApiKeyInput('');
                  setApiKeyName('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!apiKeyInput.trim() || saving}
              >
                {getSubmitLabel()}
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className="settings-section-divider" />

      {/* Connected Accounts Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">Connected Accounts</h2>
          <p className="settings-section-description">
            Sign in to services that power multiple integrations
          </p>
        </div>

        <AccountsSection
          credentials={credentials}
          onConnect={(accountId) => onConnect(accountId as 'github' | 'google')}
          onDisconnect={onDeleteCredential}
          connecting={connecting}
        />
      </div>

    </div>
  );
}
