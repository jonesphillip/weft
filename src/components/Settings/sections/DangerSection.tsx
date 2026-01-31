import { useState } from 'react';
import { Button, Input } from '../../common';
import type { Board } from '../../../types';

interface DangerSectionProps {
  board: Board;
  onDelete: () => void;
}

export function DangerSection({ board, onDelete }: DangerSectionProps) {
  const [confirmText, setConfirmText] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  const canDelete = confirmText === board.name;

  const handleDelete = () => {
    if (canDelete) {
      onDelete();
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title" style={{ color: '#ef4444' }}>
            Danger Zone
          </h2>
          <p className="settings-section-description">
            Irreversible actions that affect this board
          </p>
        </div>

        <div className="danger-card">
          <h3 className="danger-card-header">Delete this board</h3>
          <p className="danger-card-description">
            Once you delete a board, there is no going back. This will permanently delete
            the board, all its columns, tasks, and associated data.
          </p>

          {!showConfirm ? (
            <div className="danger-card-actions">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowConfirm(true)}
              >
                Delete Board
              </Button>
            </div>
          ) : (
            <div className="danger-confirm">
              <p className="danger-confirm-text">
                To confirm, type <strong>{board.name}</strong> below:
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={board.name}
                autoFocus
              />
              <div className="danger-confirm-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowConfirm(false);
                    setConfirmText('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleDelete}
                  disabled={!canDelete}
                >
                  I understand, delete this board
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
