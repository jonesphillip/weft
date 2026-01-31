import { useState } from 'react';
import { Button, Input } from '../../common';
import type { BoardWithDetails } from '../../../api/client';

interface GeneralSectionProps {
  board: BoardWithDetails;
  onRename: (name: string) => Promise<void>;
}

export function GeneralSection({ board, onRename }: GeneralSectionProps) {
  const [name, setName] = useState(board.name);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const taskCountsByColumn = board.columns
    .sort((a, b) => a.position - b.position)
    .map((column) => ({
      name: column.name,
      count: board.tasks.filter((t) => t.columnId === column.id).length,
    }));
  const totalTasks = board.tasks.length;

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    setHasChanges(e.target.value !== board.name);
  };

  const handleSave = async () => {
    if (!name.trim() || name === board.name) return;
    setSaving(true);
    await onRename(name.trim());
    setSaving(false);
    setHasChanges(false);
  };

  return (
    <div className="settings-page">
      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">General</h2>
          <p className="settings-section-description">
            Basic settings for this board
          </p>
        </div>

        <div className="settings-form">
          <Input
            label="Board Name"
            value={name}
            onChange={handleNameChange}
            placeholder="Enter board name..."
          />

          {hasChanges && (
            <div className="settings-form-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setName(board.name);
                  setHasChanges(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={!name.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="settings-section-divider" />

      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">Board Information</h2>
        </div>

        <div className="settings-info-grid">
          <div className="settings-info-item">
            <span className="settings-info-label">Created</span>
            <span className="settings-info-value">
              {new Date(board.createdAt).toLocaleDateString()}
            </span>
          </div>
          <div className="settings-info-item">
            <span className="settings-info-label">Board ID</span>
            <span className="settings-info-value settings-info-mono">
              {board.id}
            </span>
          </div>
          <div className="settings-info-item">
            <span className="settings-info-label">Tasks</span>
            <span className="settings-info-value">
              {totalTasks} total
              {taskCountsByColumn.length > 0 && (
                <span className="settings-info-secondary">
                  {' — '}
                  {taskCountsByColumn.map((col, i) => (
                    <span key={col.name}>
                      {i > 0 && ' · '}
                      {col.count} {col.name}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
