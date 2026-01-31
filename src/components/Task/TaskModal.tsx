import { useState, useEffect, useCallback, useRef, type ClipboardEvent } from 'react';
import type { Task, WorkflowPlan, WorkflowArtifact, ScheduleConfig as ScheduleConfigType } from '../../types';
import { useBoard } from '../../context/BoardContext';
import { Modal, Button, Input, RichTextEditor } from '../common';
import { PlanReviewView, WorkflowProgress, EmailViewer } from '../Workflow';
import { getApprovalView } from '../Approval';
import { AgentSection } from './AgentSection';
import { RunHistory } from './RunHistory';
import { useUrlDetection, extractUrl } from '../../hooks';
import * as api from '../../api/client';
import './TaskModal.css';

type TaskModalView = 'main' | 'plan-review' | 'checkpoint-review' | 'email-view';

interface TaskModalProps {
  task: Task;
  isOpen: boolean;
  onClose: () => void;
}

export function TaskModal({ task, isOpen, onClose }: TaskModalProps) {
  const {
    activeBoard,
    updateTask,
    deleteTask,
    getTaskById,
    getWorkflowPlan: getWorkflowPlanFromContext,
    updateWorkflowPlan: updateWorkflowPlanInContext,
    removeWorkflowPlan: removeWorkflowPlanFromContext,
  } = useBoard();

  // Get parent task if this is a child task
  const parentTask = task.parentTaskId ? getTaskById(task.parentTaskId) : null;

  const [currentView, setCurrentView] = useState<TaskModalView>('main');
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfigType | undefined>(task.scheduleConfig);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  const hasUnsavedChanges = title !== task.title || description !== (task.description || '');

  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [workflowPlan, setWorkflowPlan] = useState<WorkflowPlan | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [isApprovingPlan, setIsApprovingPlan] = useState(false);
  const [isRespondingToCheckpoint, setIsRespondingToCheckpoint] = useState(false);
  const [selectedEmailArtifact, setSelectedEmailArtifact] = useState<WorkflowArtifact | null>(null);
  const [isRunHistoryOpen, setIsRunHistoryOpen] = useState(false);
  const [childTasks, setChildTasks] = useState<Task[]>([]);

  const { pendingUrl, isLoading: isCheckingUrl, checkUrl, clear: clearPendingUrl, toPillSyntax } = useUrlDetection(task.boardId);
  const [pastedUrl, setPastedUrl] = useState<string | null>(null);
  const [pastedUrlEndIndex, setPastedUrlEndIndex] = useState<number | null>(null);

  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      const isInitialOpen = !wasOpenRef.current;
      wasOpenRef.current = true;

      setCurrentView('main');
      setTitle(task.title);
      setDescription(task.description || '');
      setScheduleConfig(task.scheduleConfig);
      setConfirmingDelete(false);
      setShowUnsavedWarning(false);
      setWorkflowError(null);
      setSelectedEmailArtifact(null);
      setIsRunHistoryOpen(false);
      setChildTasks([]);
      clearPendingUrl();
      setPastedUrl(null);
      setPastedUrlEndIndex(null);

      if (isInitialOpen) {
        setIsGeneratingPlan(false);
      }

      if (activeBoard) {
        api.getTaskWorkflowPlan(activeBoard.id, task.id).then((result) => {
          if (result.success && result.data) {
            setWorkflowPlan(result.data);
            updateWorkflowPlanInContext(result.data);
          }
        });

        // Fetch child tasks for scheduled tasks
        if (task.scheduleConfig?.enabled) {
          api.getChildTasks(activeBoard.id, task.id).then((result) => {
            if (result.success && result.data) {
              // Sort by createdAt desc and take recent ones
              const sorted = result.data.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
              );
              setChildTasks(sorted.slice(0, 10));
            }
          });
        }
      }
    } else {
      wasOpenRef.current = false;
      setCurrentView('main');
    }
  }, [isOpen, task.id, task.title, task.description, task.scheduleConfig, activeBoard, updateWorkflowPlanInContext]);

  // Sync local state from context (WebSocket updates)
  useEffect(() => {
    if (!workflowPlan?.id) return;
    const contextPlan = getWorkflowPlanFromContext(workflowPlan.id);
    if (contextPlan && contextPlan.updatedAt !== workflowPlan.updatedAt) {
      setWorkflowPlan(contextPlan);
      if (contextPlan.status === 'executing' || contextPlan.status === 'completed' || contextPlan.status === 'failed') {
        setIsGeneratingPlan(false);
      }
    }
  }, [workflowPlan?.id, workflowPlan?.updatedAt, getWorkflowPlanFromContext]);

  const getModalTitle = () => {
    switch (currentView) {
      case 'plan-review':
        return 'Review Workflow';
      case 'checkpoint-review':
        return 'Approval Required';
      case 'email-view':
        return selectedEmailArtifact?.title || 'Sent Email';
      default:
        return 'Edit Task';
    }
  };

  const showBackButton = currentView === 'plan-review' || currentView === 'checkpoint-review' || currentView === 'email-view';

  const handleBack = () => {
    setCurrentView('main');
  };

  const handleSave = async () => {
    setIsSaving(true);
    await updateTask(task.id, {
      title,
      description,
      scheduleConfig: scheduleConfig || null,
    });
    setIsSaving(false);
    onClose();
  };

  const handleDiscard = () => {
    setShowUnsavedWarning(false);
    onClose();
  };

  const preventClose = useCallback(() => {
    // Only prevent close on desktop (mobile takes full screen, actions are explicit)
    if (window.innerWidth <= 767) return false;
    return hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  const handleCloseBlocked = () => {
    setShowUnsavedWarning(true);
  };

  const handleDelete = async () => {
    await deleteTask(task.id);
    onClose();
  };

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLDivElement>) => {
      const pastedText = e.clipboardData?.getData('text') || '';
      const url = extractUrl(pastedText);

      if (!url) return;

      setPastedUrl(url);
      checkUrl(url);
    },
    [checkUrl]
  );

  const findPlainUrl = useCallback((text: string, url: string): number => {
    let searchStart = 0;
    let foundIndex = -1;
    while (true) {
      const idx = text.indexOf(url, searchStart);
      if (idx === -1) break;
      const prefix = text.slice(Math.max(0, idx - 2), idx);
      if (!prefix.endsWith('](')) {
        foundIndex = idx;
      }
      searchStart = idx + 1;
    }
    return foundIndex;
  }, []);

  const handleConvertToPill = useCallback(() => {
    if (!pendingUrl || !pastedUrl) return;

    const pillSyntax = toPillSyntax(pendingUrl);

    let startIndex: number;
    if (pastedUrlEndIndex !== null) {
      startIndex = pastedUrlEndIndex - pastedUrl.length;
      if (description.slice(startIndex, pastedUrlEndIndex) !== pastedUrl) {
        startIndex = findPlainUrl(description, pastedUrl);
      }
    } else {
      startIndex = findPlainUrl(description, pastedUrl);
    }

    if (startIndex === -1) return;

    const newDescription =
      description.slice(0, startIndex) +
      pillSyntax +
      description.slice(startIndex + pastedUrl.length);

    setDescription(newDescription);
    clearPendingUrl();
    setPastedUrl(null);
    setPastedUrlEndIndex(null);
  }, [pendingUrl, pastedUrl, pastedUrlEndIndex, description, toPillSyntax, clearPendingUrl, findPlainUrl]);

  const handleDismissPillPrompt = useCallback(() => {
    clearPendingUrl();
    setPastedUrl(null);
    setPastedUrlEndIndex(null);
  }, [clearPendingUrl]);

  const handleScheduleConfigChange = useCallback((config: ScheduleConfigType | null) => {
    setScheduleConfig(config || undefined);
  }, []);

  const handleStartAgent = async () => {
    setIsGeneratingPlan(true);
    setWorkflowError(null);

    if (description !== task.description) {
      await updateTask(task.id, { title, description });
    }

    if (!activeBoard) return;

    // Clear any existing workflow output before starting fresh
    if (workflowPlan) {
      await api.deleteWorkflowPlan(activeBoard.id, workflowPlan.id);
      removeWorkflowPlanFromContext(workflowPlan.id);
      setWorkflowPlan(null);
    }

    const result = await api.generateWorkflowPlan(activeBoard.id, task.id);

    if (result.success && result.data) {
      setWorkflowPlan(result.data);
      updateWorkflowPlanInContext(result.data);
    } else {
      setWorkflowError(result.error?.message || 'Failed to start agent');
      setIsGeneratingPlan(false);
    }
  };

  const handleApprovePlan = async () => {
    if (!workflowPlan || !activeBoard) return;

    setIsApprovingPlan(true);
    const result = await api.approveWorkflowPlan(activeBoard.id, workflowPlan.id);
    if (result.success && result.data) {
      setWorkflowPlan(result.data);
      updateWorkflowPlanInContext(result.data);
      setCurrentView('main');
    } else {
      setWorkflowError(result.error?.message || 'Failed to approve plan');
    }
    setIsApprovingPlan(false);
  };

  const handleDismissWorkflow = async () => {
    if (!workflowPlan || !activeBoard) return;
    await api.deleteWorkflowPlan(activeBoard.id, workflowPlan.id);
    removeWorkflowPlanFromContext(workflowPlan.id);
    setWorkflowPlan(null);
  };

  const handleCancelWorkflow = async () => {
    if (!workflowPlan || !activeBoard) return;
    const result = await api.cancelWorkflow(activeBoard.id, workflowPlan.id);
    if (result.success && result.data) {
      setWorkflowPlan(result.data);
      updateWorkflowPlanInContext(result.data);
    }
  };

  const handleApproveCheckpoint = async (responseData?: Record<string, unknown>) => {
    if (!workflowPlan || !activeBoard) return;
    setIsRespondingToCheckpoint(true);
    const result = await api.resolveWorkflowCheckpoint(activeBoard.id, workflowPlan.id, {
      action: 'approve',
      data: responseData,
    });
    if (result.success && result.data) {
      setWorkflowPlan(result.data);
      updateWorkflowPlanInContext(result.data);
      setCurrentView('main');
    } else {
      setWorkflowError(result.error?.message || 'Failed to approve checkpoint');
    }
    setIsRespondingToCheckpoint(false);
  };

  const handleRequestChanges = async (feedback: string) => {
    if (!workflowPlan || !activeBoard) return;
    setIsRespondingToCheckpoint(true);
    const result = await api.resolveWorkflowCheckpoint(activeBoard.id, workflowPlan.id, {
      action: 'request_changes',
      feedback,
    });
    if (result.success && result.data) {
      setWorkflowPlan(result.data);
      updateWorkflowPlanInContext(result.data);
      setCurrentView('main');
    } else {
      setWorkflowError(result.error?.message || 'Failed to request changes');
    }
    setIsRespondingToCheckpoint(false);
  };

  const handleCancelCheckpoint = async () => {
    if (!workflowPlan || !activeBoard) return;
    setIsRespondingToCheckpoint(true);
    const result = await api.resolveWorkflowCheckpoint(activeBoard.id, workflowPlan.id, { action: 'cancel' });
    if (result.success && result.data) {
      setWorkflowPlan(result.data);
      updateWorkflowPlanInContext(result.data);
      setCurrentView('main');
    } else {
      setWorkflowError(result.error?.message || 'Failed to cancel workflow');
    }
    setIsRespondingToCheckpoint(false);
  };

  // Render content based on current view
  const renderContent = () => {
    // Plan Review (wizard pattern)
    if (currentView === 'plan-review' && workflowPlan) {
      return (
        <PlanReviewView
          plan={workflowPlan}
          onBack={() => setCurrentView('main')}
          onApprove={handleApprovePlan}
          loading={isApprovingPlan}
        />
      );
    }

    // Checkpoint Review (wizard pattern)
    if (currentView === 'checkpoint-review' && workflowPlan) {
      // Use context plan for real-time updates, fallback to local state
      const contextPlan = getWorkflowPlanFromContext(workflowPlan.id);
      const plan = contextPlan || workflowPlan;

      const checkpointData = plan.checkpointData as {
        tool?: string;
        action?: string;
        data?: Record<string, unknown>;
      } | undefined;

      const toolName = checkpointData?.tool || '';
      const ApprovalView = getApprovalView(toolName);

      // Parse data - handle JSON string case
      let dataObj: Record<string, unknown> = {};
      if (checkpointData?.data) {
        if (typeof checkpointData.data === 'string') {
          try {
            dataObj = JSON.parse(checkpointData.data);
          } catch {
            dataObj = {};
          }
        } else {
          dataObj = checkpointData.data;
        }
      }

      return (
        <ApprovalView
          tool={toolName}
          action={checkpointData?.action || ''}
          data={dataObj}
          onApprove={handleApproveCheckpoint}
          onRequestChanges={handleRequestChanges}
          onCancel={handleCancelCheckpoint}
          isLoading={isRespondingToCheckpoint}
        />
      );
    }

    // Email View (from artifact dropdown)
    if (currentView === 'email-view' && selectedEmailArtifact?.content) {
      return <EmailViewer content={selectedEmailArtifact.content} />;
    }

    // Main view (default)
    return (
      <>
        <div className="task-modal-form">
          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title..."
          />

          <RichTextEditor
            label="Description / Instructions"
            value={description}
            onChange={setDescription}
            onPaste={handlePaste}
            onPasteUrlPosition={setPastedUrlEndIndex}
            placeholder="Describe the task or provide instructions for the agent..."
            rows={4}
            pendingUrl={pendingUrl}
            isCheckingUrl={isCheckingUrl}
            onAcceptPill={handleConvertToPill}
            onDismissPill={handleDismissPillPrompt}
          />
        </div>

        {/* Agent Section - always visible */}
        <div className="task-modal-agent">
          {workflowError && (
            <div className="task-modal-error">{workflowError}</div>
          )}

          {activeBoard && (
            <AgentSection
              boardId={task.boardId}
              taskId={task.id}
              onRun={handleStartAgent}
              isRunning={isGeneratingPlan || (workflowPlan?.status !== undefined && workflowPlan.status !== 'completed' && workflowPlan.status !== 'failed')}
              columns={activeBoard.columns}
              scheduleConfig={scheduleConfig}
              onScheduleChange={handleScheduleConfigChange}
              onViewHistory={() => setIsRunHistoryOpen(true)}
            />
          )}

          {/* Workflow output - shown below AgentSection when present */}
          {workflowPlan && (() => {
            const contextPlan = getWorkflowPlanFromContext(workflowPlan.id);
            const plan = contextPlan || workflowPlan;
            const isScheduled = !!scheduleConfig?.enabled;

            return (
              <div className="task-modal-workflow-output">
                <WorkflowProgress
                  plan={plan}
                  onCancel={handleCancelWorkflow}
                  onDismiss={handleDismissWorkflow}
                  onReviewCheckpoint={() => setCurrentView('checkpoint-review')}
                  onViewEmail={!isScheduled ? (artifact) => {
                    setSelectedEmailArtifact(artifact);
                    setCurrentView('email-view');
                  } : undefined}
                  childTasks={isScheduled ? childTasks : undefined}
                  onViewTask={isScheduled ? (childTask) => {
                    // Close this modal first, then open the child task
                    onClose();
                    requestAnimationFrame(() => {
                      window.dispatchEvent(new CustomEvent('open-task', { detail: { taskId: childTask.id } }));
                    });
                  } : undefined}
                  isScheduledTask={isScheduled}
                />
              </div>
            );
          })()}
        </div>

        <div className={`task-modal-footer${showUnsavedWarning ? ' has-warning' : ''}`}>
          <div className={`delete-action ${confirmingDelete ? 'confirming' : ''}`}>
            {confirmingDelete ? (
              <>
                <Button variant="danger" onClick={handleDelete}>
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            )}
          </div>
          {showUnsavedWarning && (
            <span className="task-modal-unsaved-hint">Unsaved changes</span>
          )}
          <div className="task-modal-footer-right">
            <Button variant="ghost" onClick={handleDiscard}>
              {hasUnsavedChanges ? 'Discard' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!title.trim() || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </>
    );
  };

  // Use full width for all approval/checkpoint views
  const needsFullWidth = currentView === 'checkpoint-review' || currentView === 'plan-review';
  const modalWidth = needsFullWidth ? 'full' : 'lg';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={getModalTitle()}
        titleBadge={parentTask && currentView === 'main' ? (
          <button
            className="modal-parent-badge"
            onClick={() => {
              onClose();
              requestAnimationFrame(() => {
                window.dispatchEvent(new CustomEvent('open-task', { detail: { taskId: parentTask.id } }));
              });
            }}
          >
            <span className="modal-parent-badge-label">created by</span>
            <span className="modal-parent-badge-title">{parentTask.title}</span>
          </button>
        ) : undefined}
        width={modalWidth}
        showBackButton={showBackButton}
        onBack={handleBack}
        preventClose={preventClose}
        onCloseBlocked={handleCloseBlocked}
      >
        <div className={`task-modal ${currentView !== 'main' ? `view-${currentView}` : ''}`}>
          {renderContent()}
        </div>
      </Modal>

      {activeBoard && (
        <RunHistory
          boardId={activeBoard.id}
          taskId={task.id}
          isOpen={isRunHistoryOpen}
          onClose={() => setIsRunHistoryOpen(false)}
        />
      )}
    </>
  );
}
