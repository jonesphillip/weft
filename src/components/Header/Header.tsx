import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useBoard } from '../../context/BoardContext';
import { useAuth } from '../../context/AuthContext';
import { Modal, Input, Button } from '../common';
import { BoardSettings } from '../Settings';
import { WeftLogo } from './WeftLogo';
import * as api from '../../api/client';
import './Header.css';

export function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { boards, activeBoard, clearActiveBoard, createBoard, activeWorkflows, updateWorkflowPlan, removeWorkflowPlan } = useBoard();
  const { user, signOut } = useAuth();
  const [showBoardModal, setShowBoardModal] = useState(false);
  const [showSelector, setShowSelector] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showExecutions, setShowExecutions] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const executionsRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const isHome = location.pathname === '/';

  useEffect(() => {
    const githubConnected = searchParams.get('github');
    const githubError = searchParams.get('github_error');
    if ((githubConnected === 'connected' || githubError) && activeBoard) {
      setShowSettings(true);
    }
  }, [searchParams, activeBoard]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowSelector(false);
      }
      if (executionsRef.current && !executionsRef.current.contains(event.target as Node)) {
        setShowExecutions(false);
        setConfirmingCancel(null);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };

    if (showSelector || showExecutions || showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSelector, showExecutions, showUserMenu]);

  const handleGoHome = () => {
    clearActiveBoard();
    navigate('/');
  };

  const handleCreateBoard = async () => {
    if (newBoardName.trim()) {
      const boardId = await createBoard(newBoardName.trim());
      setNewBoardName('');
      setShowBoardModal(false);
      if (boardId) {
        navigate(`/board/${boardId}`);
      }
    }
  };

  const handleSelectBoard = (boardId: string) => {
    navigate(`/board/${boardId}`);
    setShowSelector(false);
  };

  const handleStopWorkflow = async (e: React.MouseEvent, workflowId: string) => {
    e.stopPropagation();
    if (confirmingCancel === workflowId && activeBoard) {
      const result = await api.cancelWorkflow(activeBoard.id, workflowId);
      if (result.success && result.data) {
        updateWorkflowPlan(result.data);
      } else {
        removeWorkflowPlan(workflowId);
      }
      setConfirmingCancel(null);
    } else {
      setConfirmingCancel(workflowId);
    }
  };

  return (
    <header className="header">
      <div className="header-left">
        <WeftLogo onClick={handleGoHome} />
      </div>

      <div className="header-center">
        {!isHome && (
          <div className="board-selector-wrapper" ref={dropdownRef}>
            <button
              className="board-selector-trigger"
              onClick={() => setShowSelector(!showSelector)}
            >
              <span className="board-selector-name">
                {activeBoard?.name || 'Select Board'}
              </span>
              <span className="board-selector-arrow">▼</span>
            </button>

            {showSelector && (
              <div className="board-selector-dropdown">
                {boards.length === 0 ? (
                  <div className="board-selector-empty">No boards yet</div>
                ) : (
                  boards.map((board) => (
                    <button
                      key={board.id}
                      className={`board-selector-item ${
                        activeBoard?.id === board.id ? 'active' : ''
                      }`}
                      onClick={() => handleSelectBoard(board.id)}
                    >
                      {board.name}
                    </button>
                  ))
                )}
                <div className="board-selector-divider" />
                <button
                  className="board-selector-item board-selector-new"
                  onClick={() => {
                    setShowSelector(false);
                    setShowBoardModal(true);
                  }}
                >
                  + New Board
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="header-right">
        {!isHome && activeBoard && (
          <div className="executions-wrapper" ref={executionsRef}>
            <button
              className={`executions-trigger ${activeWorkflows.length === 0 ? 'executions-trigger-empty' : ''}`}
              onClick={() => setShowExecutions(!showExecutions)}
              title="Running agents"
              aria-label={`Running agents: ${activeWorkflows.length}`}
            >
              <span className="executions-icon">⚡</span>
              <span className="executions-count">{activeWorkflows.length}</span>
            </button>

            {showExecutions && (
              <div className="executions-dropdown">
                <div className="executions-header">Running Agents</div>
                {activeWorkflows.length === 0 ? (
                  <div className="executions-empty">No agents running</div>
                ) : (
                  activeWorkflows.map((workflow) => {
                    const task = activeBoard?.tasks?.find((t) => t.id === workflow.taskId);
                    const taskTitle = task?.title || `Task ${workflow.taskId.slice(0, 8)}`;
                    const currentStep = workflow.steps?.[workflow.currentStepIndex || 0];
                    const isCheckpoint = workflow.status === 'checkpoint';
                    const isConfirming = confirmingCancel === workflow.id;

                    let secondaryText = '';
                    if (isCheckpoint) {
                      secondaryText = 'Awaiting approval';
                    } else if (workflow.status === 'executing' && currentStep?.name) {
                      secondaryText = currentStep.name;
                    } else if (workflow.status === 'planning') {
                      secondaryText = 'Starting...';
                    }

                    return (
                      <div key={workflow.id} className="executions-item">
                        <button
                          className="executions-item-main"
                          onClick={() => {
                            setShowExecutions(false);
                            window.dispatchEvent(new CustomEvent('open-task', { detail: { taskId: workflow.taskId } }));
                          }}
                        >
                          <span className={`executions-item-status ${isCheckpoint ? 'status-checkpoint' : ''}`}>
                            {isCheckpoint ? '⏸' : '●'}
                          </span>
                          <div className="executions-item-info">
                            <span className="executions-item-title">{taskTitle}</span>
                            {secondaryText && (
                              <span className="executions-item-step">{secondaryText}</span>
                            )}
                          </div>
                        </button>
                        <button
                          className={`executions-item-stop ${isConfirming ? 'confirming' : ''}`}
                          onClick={(e) => handleStopWorkflow(e, workflow.id)}
                          title={isConfirming ? 'Click to confirm' : 'Stop this agent'}
                        >
                          {isConfirming ? 'Confirm' : 'Stop'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {!isHome && activeBoard && (
          <button
            className="header-settings-btn"
            onClick={() => setShowSettings(true)}
            title="Board Settings"
          >
            Settings
          </button>
        )}

        {user && (
          <div className="user-menu-wrapper" ref={userMenuRef}>
            <button
              className="user-menu-trigger"
              onClick={() => setShowUserMenu(!showUserMenu)}
              title={user.email}
            >
              <span className="user-avatar-circle">
                {user.email.charAt(0).toUpperCase()}
              </span>
              <span className="user-menu-chevron">▼</span>
            </button>

            {showUserMenu && (
              <div className="user-menu-dropdown">
                <div className="user-menu-email">{user.email}</div>
                <div className="user-menu-divider" />
                <button
                  className="user-menu-item user-menu-signout"
                  onClick={() => {
                    setShowUserMenu(false);
                    signOut();
                  }}
                >
                  Sign Out
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <Modal
        isOpen={showBoardModal}
        onClose={() => setShowBoardModal(false)}
        title="Create New Board"
        width="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreateBoard();
          }}
        >
          <div className="modal-form">
            <Input
              label="Board Name"
              placeholder="My Project"
              value={newBoardName}
              onChange={(e) => setNewBoardName(e.target.value)}
              autoFocus
            />
            <div className="modal-actions">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowBoardModal(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Create Board
              </Button>
            </div>
          </div>
        </form>
      </Modal>

      <BoardSettings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </header>
  );
}
