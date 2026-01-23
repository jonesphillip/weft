import { useState, useEffect, useMemo, useRef } from 'react';
import { Button, AgentIcon, McpIcon } from '../common';
import type { MCPServer, ScheduleConfig, Column } from '../../types';
import * as api from '../../api/client';
import './AgentSection.css';

interface AgentSectionProps {
  boardId: string;
  taskId: string;
  onRun: () => void;
  isRunning?: boolean;
  columns: Column[];
  scheduleConfig?: ScheduleConfig;
  onScheduleChange: (config: ScheduleConfig | null) => void;
  onViewHistory: () => void;
}

const PLAYFUL_SENTENCES = [
  "Tools at my disposal:",
  "I have access to:",
  "My toolkit includes:",
  "At my fingertips:",
  "I can tap into:",
  "Available to me:",
];

function getIconType(name: string): 'gmail' | 'google-docs' | 'google-sheets' | 'github' | 'sandbox' | 'claude-code' | 'generic' {
  const lower = name.toLowerCase();
  if (lower === 'gmail') return 'gmail';
  if (lower === 'google docs' || lower === 'google-docs') return 'google-docs';
  if (lower === 'google sheets' || lower === 'google-sheets') return 'google-sheets';
  if (lower === 'github') return 'github';
  if (lower === 'claude code' || lower === 'claude-code') return 'claude-code';
  if (lower === 'sandbox') return 'sandbox';
  return 'generic';
}

const BUILTIN_TOOLS = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'sandbox', name: 'Sandbox' },
];

const COMMON_TIMEZONES = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central European (CET)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
];

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

function formatScheduleSummary(config: ScheduleConfig): string {
  if (config.frequency === 'custom' && config.cron) {
    return config.cron;
  }
  const freq = config.frequency === 'daily' ? 'Daily' : 'Weekly';
  return `${freq} at ${config.time}`;
}

function parse24HourTime(time: string): { hour: number; minute: number; period: 'AM' | 'PM' } {
  const [h, m] = time.split(':').map(Number);
  const period: 'AM' | 'PM' = h >= 12 ? 'PM' : 'AM';
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return { hour, minute: m, period };
}

function to24HourTime(hour: number, minute: number, period: 'AM' | 'PM'): string {
  let h = hour;
  if (period === 'AM' && hour === 12) h = 0;
  else if (period === 'PM' && hour !== 12) h = hour + 12;
  return `${h.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

export function AgentSection({
  boardId,
  taskId,
  onRun,
  isRunning,
  columns,
  scheduleConfig,
  onScheduleChange,
  onViewHistory,
}: AgentSectionProps) {
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'custom'>(scheduleConfig?.frequency ?? 'daily');
  const [time, setTime] = useState(scheduleConfig?.time ?? '09:00');
  const [timezone, setTimezone] = useState(scheduleConfig?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(scheduleConfig?.daysOfWeek ?? [1, 2, 3, 4, 5]);
  const [cron, setCron] = useState(scheduleConfig?.cron ?? '0 9 * * *');
  const [targetColumnId, setTargetColumnId] = useState(scheduleConfig?.targetColumnId ?? columns[0]?.id ?? '');
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [hourInput, setHourInput] = useState<string | null>(null);
  const [minuteInput, setMinuteInput] = useState<string | null>(null);

  const isScheduled = scheduleConfig?.enabled;

  useEffect(() => {
    if (scheduleConfig) {
      setFrequency(scheduleConfig.frequency);
      setTime(scheduleConfig.time);
      setTimezone(scheduleConfig.timezone);
      if (scheduleConfig.daysOfWeek) setDaysOfWeek(scheduleConfig.daysOfWeek);
      if (scheduleConfig.cron) setCron(scheduleConfig.cron);
      setTargetColumnId(scheduleConfig.targetColumnId);
    }
  }, [scheduleConfig]);

  useEffect(() => {
    if (!isScheduleOpen) return;

    onScheduleChange({
      enabled: true,
      frequency,
      time,
      timezone,
      daysOfWeek: frequency === 'weekly' ? daysOfWeek : undefined,
      cron: frequency === 'custom' ? cron : undefined,
      targetColumnId,
    });
  }, [isScheduleOpen, frequency, time, timezone, daysOfWeek, cron, targetColumnId, onScheduleChange]);

  const sentence = useMemo(() => {
    return PLAYFUL_SENTENCES[Math.floor(Math.random() * PLAYFUL_SENTENCES.length)];
  }, []);

  useEffect(() => {
    async function loadServers() {
      const result = await api.getMCPServers(boardId);
      if (result.success && result.data) {
        setMcpServers(result.data);
      }
      setLoading(false);
    }
    loadServers();
  }, [boardId]);

  const allTools = [
    ...BUILTIN_TOOLS,
    ...mcpServers
      .filter(s => s.enabled)
      .map(s => ({ id: s.id, name: s.name })),
  ];

  const MAX_VISIBLE = isScheduled ? 2 : 3;
  const visibleTools = allTools.slice(0, MAX_VISIBLE);
  const hiddenTools = allTools.slice(MAX_VISIBLE);
  const hasMore = hiddenTools.length > 0;

  const handleScheduleClick = () => {
    setIsScheduleOpen(!isScheduleOpen);
  };

  const handleRemoveSchedule = () => {
    onScheduleChange(null);
    setIsScheduleOpen(false);
  };

  const handleToggleDay = (day: number) => {
    if (daysOfWeek.includes(day)) {
      setDaysOfWeek(daysOfWeek.filter(d => d !== day));
    } else {
      setDaysOfWeek([...daysOfWeek, day].sort());
    }
  };

  const handleRunNow = async () => {
    setIsRunningNow(true);
    try {
      await api.triggerScheduledRun(boardId, taskId);
    } finally {
      setIsRunningNow(false);
    }
  };

  function renderToolsList() {
    if (loading) return <span className="agent-tools-loading">...</span>;
    if (allTools.length === 0) return <span className="agent-tools-empty">No tools connected</span>;

    return (
      <>
        {visibleTools.map(tool => (
          <div
            key={tool.id}
            className="agent-tool"
            title={tool.name}
          >
            <McpIcon type={getIconType(tool.name)} size={12} />
            <span className="agent-tool-name">{tool.name}</span>
          </div>
        ))}
        {hasMore && (
          <div
            ref={moreRef}
            className="agent-tool agent-tool-more"
            onMouseEnter={() => {
              if (moreRef.current) {
                const rect = moreRef.current.getBoundingClientRect();
                setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
              }
            }}
            onMouseLeave={() => setTooltipPos(null)}
          >
            <span className="agent-tool-name">+{hiddenTools.length} more</span>
            {tooltipPos && (
              <div
                className="agent-tool-tooltip"
                style={{
                  position: 'fixed',
                  left: tooltipPos.x,
                  top: tooltipPos.y,
                  transform: 'translate(-50%, -100%)',
                }}
              >
                {hiddenTools.map(t => t.name).join(', ')}
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="agent-section">
      <div className="agent-section-content">
        <div className="agent-buttons">
          <Button
            variant="agent"
            onClick={onRun}
            disabled={isRunning}
            className="agent-run-button"
          >
            <AgentIcon size={16} />
            Run Now
          </Button>

          <button
            type="button"
            className={`agent-schedule-button ${isScheduled ? 'active' : ''} ${isScheduleOpen ? 'open' : ''}`}
            onClick={handleScheduleClick}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z"/>
              <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
            </svg>
            {isScheduled ? (
              <span className="agent-schedule-summary">{formatScheduleSummary(scheduleConfig!)}</span>
            ) : (
              <span>Schedule</span>
            )}
            {isScheduled && (
              <svg className="agent-schedule-check" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
              </svg>
            )}
          </button>
        </div>

        <div className="agent-tools-area">
          <span className="agent-sentence">{sentence}</span>
          <div className="agent-tools-list">
            {renderToolsList()}
          </div>
        </div>
      </div>

      {isScheduleOpen && (
        <div className="agent-schedule-panel">
          <div className="agent-schedule-row">
            <label className="agent-schedule-label">
              <span>Frequency</span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
                className="agent-schedule-select"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Custom (cron)</option>
              </select>
            </label>

            {frequency !== 'custom' && (
              <div className="agent-schedule-label">
                <span>Time</span>
                <div className="agent-schedule-time-picker">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={hourInput ?? parse24HourTime(time).hour.toString().padStart(2, '0')}
                    onFocus={(e) => {
                      setHourInput(parse24HourTime(time).hour.toString().padStart(2, '0'));
                      setTimeout(() => e.target.select(), 0);
                    }}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 2);
                      setHourInput(val);
                    }}
                    onBlur={() => {
                      const num = parseInt(hourInput || '', 10);
                      const { minute, period } = parse24HourTime(time);
                      if (!isNaN(num) && num >= 1 && num <= 12) {
                        setTime(to24HourTime(num, minute, period));
                      }
                      setHourInput(null);
                    }}
                    className="agent-schedule-input agent-schedule-time-hour"
                  />
                  <span className="agent-schedule-time-sep">:</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={minuteInput ?? parse24HourTime(time).minute.toString().padStart(2, '0')}
                    onFocus={(e) => {
                      setMinuteInput(parse24HourTime(time).minute.toString().padStart(2, '0'));
                      setTimeout(() => e.target.select(), 0);
                    }}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 2);
                      setMinuteInput(val);
                    }}
                    onBlur={() => {
                      const num = parseInt(minuteInput || '', 10);
                      const { hour, period } = parse24HourTime(time);
                      if (!isNaN(num) && num >= 0 && num <= 59) {
                        setTime(to24HourTime(hour, num, period));
                      }
                      setMinuteInput(null);
                    }}
                    className="agent-schedule-input agent-schedule-time-minute"
                  />
                  <select
                    value={parse24HourTime(time).period}
                    onChange={(e) => {
                      const { hour, minute } = parse24HourTime(time);
                      setTime(to24HourTime(hour, minute, e.target.value as 'AM' | 'PM'));
                    }}
                    className="agent-schedule-select agent-schedule-time-period"
                  >
                    <option value="AM">AM</option>
                    <option value="PM">PM</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {frequency === 'custom' && (
            <div className="agent-schedule-cron">
              <label className="agent-schedule-label">
                <span>Cron Expression</span>
                <input
                  type="text"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  className="agent-schedule-input"
                  placeholder="0 9 * * *"
                />
              </label>
              <span className="agent-schedule-hint">
                minute hour day month weekday
              </span>
            </div>
          )}

          {frequency === 'weekly' && (
            <div className="agent-schedule-days">
              <span className="agent-schedule-days-label">Days</span>
              <div className="agent-schedule-days-list">
                {DAYS_OF_WEEK.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className={`agent-schedule-day ${daysOfWeek.includes(value) ? 'selected' : ''}`}
                    onClick={() => handleToggleDay(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="agent-schedule-row">
            <label className="agent-schedule-label">
              <span>Timezone</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="agent-schedule-select"
              >
                {COMMON_TIMEZONES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>

            <label className="agent-schedule-label">
              <span>Create tasks in</span>
              <select
                value={targetColumnId}
                onChange={(e) => setTargetColumnId(e.target.value)}
                className="agent-schedule-select"
              >
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>{column.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="agent-schedule-actions">
            <div className="agent-schedule-actions-left">
              {isScheduled && (
                <>
                  <button
                    type="button"
                    className="agent-schedule-link"
                    onClick={onViewHistory}
                  >
                    View History
                  </button>
                  <button
                    type="button"
                    className="agent-schedule-link"
                    onClick={handleRunNow}
                    disabled={isRunningNow}
                  >
                    {isRunningNow ? 'Running...' : 'Run Now'}
                  </button>
                </>
              )}
            </div>
            <div className="agent-schedule-actions-right">
              <button
                type="button"
                className="agent-schedule-link danger"
                onClick={handleRemoveSchedule}
              >
                {isScheduled ? 'Remove Schedule' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
