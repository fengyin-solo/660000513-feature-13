import React, { useEffect, useMemo, useState } from 'react';
import type { PrecheckIssue, PrecheckStatus, Problem, SampleType } from '../types';
import { SAMPLE_TYPE_LABELS } from '../types';
import {
  checkTestCaseRecord,
  detectRecordSampleType,
  detectSampleType,
  fingerprint,
  loadPrecheckResults,
  resolveReferenceKey,
  savePrecheckResults,
} from '../services/precheckService';
import { useToastStore } from '../store/toast';

interface ProblemPrecheckModalProps {
  isOpen: boolean;
  problem: Problem | null;
  onClose: () => void;
}

interface PrecheckRecord {
  index: number;
  fp: string;
  input: string;
  expectedOutput: string;
  hidden: boolean;
  sampleType: SampleType;
  selected: boolean;
  status: PrecheckStatus;
  issues: PrecheckIssue[];
  checkedAt?: string;
  manual: boolean;
}

const STATUS_CONFIG: Record<PrecheckStatus, { label: string; color: string; bg: string }> = {
  pending: { label: '待处理', color: '#9e9e9e', bg: 'rgba(158, 158, 158, 0.15)' },
  passed: { label: '可发布', color: '#4caf50', bg: 'rgba(76, 175, 80, 0.15)' },
  failed: { label: '需修正', color: '#f44336', bg: 'rgba(244, 67, 54, 0.15)' },
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const ProblemPrecheckModal: React.FC<ProblemPrecheckModalProps> = ({ isOpen, problem, onClose }) => {
  const { success, warning, info } = useToastStore();
  const [records, setRecords] = useState<PrecheckRecord[]>([]);
  const [running, setRunning] = useState(false);

  // 打开时按内容指纹恢复历史结果；未检查过的记录保持待处理
  useEffect(() => {
    if (!isOpen || !problem) return;
    const stored = loadPrecheckResults(problem.id);
    setRecords(
      problem.testCases.map((tc, index) => {
        const fp = fingerprint(tc.input, tc.expectedOutput);
        const saved = stored[fp];
        return {
          index,
          fp,
          input: tc.input,
          expectedOutput: tc.expectedOutput,
          hidden: tc.hidden,
          sampleType: detectRecordSampleType(tc.input),
          selected: false,
          status: saved?.status ?? 'pending',
          issues: saved?.issues ?? [],
          checkedAt: saved?.checkedAt,
          manual: saved?.manual ?? false,
        };
      }),
    );
  }, [isOpen, problem]);

  const referenceKey = useMemo(
    () => (problem ? resolveReferenceKey(problem.title) : null),
    [problem],
  );

  if (!isOpen || !problem) return null;

  const persist = (next: PrecheckRecord[]) => {
    const updates: Record<string, { status: 'passed' | 'failed'; issues: PrecheckIssue[]; checkedAt: string; manual?: boolean }> = {};
    next.forEach(r => {
      if (r.status !== 'pending') {
        updates[r.fp] = { status: r.status, issues: r.issues, checkedAt: r.checkedAt ?? new Date().toISOString(), manual: r.manual || undefined };
      }
    });
    savePrecheckResults(problem.id, updates, next.map(r => r.fp));
  };

  /** 只重跑指定记录；人工确认过的记录不会被覆盖 */
  const runChecks = async (targets: PrecheckRecord[]) => {
    const runnable = targets.filter(r => !r.manual);
    if (runnable.length === 0) {
      info('没有可检查的记录（人工确认的记录不会被重跑覆盖）');
      return;
    }
    setRunning(true);
    const peerExpectedTypes = records.map(r => detectSampleType(r.expectedOutput));
    const targetIndexes = new Set(runnable.map(r => r.index));
    const next = records.map(r => {
      if (!targetIndexes.has(r.index)) return r;
      const { status, issues } = checkTestCaseRecord(r.input, r.expectedOutput, {
        referenceKey,
        peerExpectedTypes,
      });
      return { ...r, status, issues, checkedAt: new Date().toISOString(), manual: false };
    });
    await delay(400); // 模拟本地执行耗时
    setRecords(next);
    persist(next);
    setRunning(false);
    const ran = next.filter(r => targetIndexes.has(r.index));
    const failed = ran.filter(r => r.status === 'failed').length;
    if (failed > 0) {
      warning(`预检完成：${ran.length - failed} 条可发布，${failed} 条需修正`);
    } else {
      success(`预检完成：${ran.length} 条样例全部可发布`);
    }
  };

  const handleCheckSelected = () => runChecks(records.filter(r => r.selected));
  const handleCheckAll = () => runChecks(records);
  const handleRerunFailed = () => runChecks(records.filter(r => r.status === 'failed'));

  const handleManualConfirm = (index: number) => {
    const next = records.map(r =>
      r.index === index
        ? { ...r, status: 'passed' as PrecheckStatus, manual: true, checkedAt: new Date().toISOString() }
        : r,
    );
    setRecords(next);
    persist(next);
    success(`样例 ${index + 1} 已人工确认为可发布，重跑不会覆盖该记录`);
  };

  const handleRevokeManual = (index: number) => {
    const next = records.map(r =>
      r.index === index
        ? { ...r, status: 'pending' as PrecheckStatus, manual: false, issues: [], checkedAt: undefined }
        : r,
    );
    setRecords(next);
    persist(next);
  };

  const toggleSelectAll = () => {
    const allSelected = records.length > 0 && records.every(r => r.selected);
    setRecords(prev => prev.map(r => ({ ...r, selected: !allSelected })));
  };

  const selectByType = (type: SampleType) => {
    setRecords(prev => prev.map(r => ({ ...r, selected: r.sampleType === type })));
  };

  const selectedCount = records.filter(r => r.selected).length;
  const passedCount = records.filter(r => r.status === 'passed').length;
  const failedCount = records.filter(r => r.status === 'failed').length;
  const pendingCount = records.filter(r => r.status === 'pending').length;
  const manualCount = records.filter(r => r.manual).length;
  const rerunnableFailed = records.filter(r => r.status === 'failed' && !r.manual).length;
  const presentTypes = Array.from(new Set(records.map(r => r.sampleType)));

  const actionButtonStyle = (enabled: boolean, color: string) => ({
    padding: '8px 16px',
    borderRadius: '6px',
    border: `1px solid ${enabled ? color : '#444'}`,
    background: 'transparent',
    color: enabled ? color : '#666',
    cursor: enabled && !running ? 'pointer' : 'not-allowed',
    fontSize: '13px',
    opacity: running ? 0.6 : 1,
  });

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#1e1e1e', borderRadius: '8px', width: '960px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', border: '1px solid #333' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ color: '#fff', margin: 0, fontSize: '20px' }}>发布前预检 · {problem.title}</h2>
            <p style={{ color: '#888', margin: '6px 0 0 0', fontSize: '13px' }}>
              在本地开发环境逐条检查样例的空值、边界和预期结果
              {referenceKey
                ? `；当前题目内置参考解，将同时校验预期输出是否正确`
                : '；当前题目无内置参考解，仅做结构校验'}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#888', fontSize: '24px', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: '16px 24px', borderBottom: '1px solid #333', background: '#1a1a1a', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', fontSize: '13px' }}>
            <span style={{ color: '#4caf50' }}>✅ 可发布 {passedCount}{manualCount > 0 ? `（含人工确认 ${manualCount}）` : ''}</span>
            <span style={{ color: '#f44336' }}>❌ 需修正 {failedCount}</span>
            <span style={{ color: '#9e9e9e' }}>⏳ 待处理 {pendingCount}</span>
            <span style={{ color: '#666' }}>共 {records.length} 条样例</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={toggleSelectAll} style={actionButtonStyle(records.length > 0, '#667eea')}>
              {records.every(r => r.selected) && records.length > 0 ? '取消全选' : '全选'}
            </button>
            {presentTypes.map(type => (
              <button key={type} onClick={() => selectByType(type)} style={actionButtonStyle(true, '#888')}>
                选{SAMPLE_TYPE_LABELS[type]}
              </button>
            ))}
            <span style={{ width: '1px', height: '20px', background: '#333', margin: '0 4px' }} />
            <button
              onClick={handleCheckSelected}
              disabled={running || selectedCount === 0}
              style={actionButtonStyle(selectedCount > 0, '#667eea')}
            >
              检查选中（{selectedCount}）
            </button>
            <button onClick={handleCheckAll} disabled={running || records.length === 0} style={actionButtonStyle(records.length > 0, '#4caf50')}>
              全部检查
            </button>
            <button onClick={handleRerunFailed} disabled={running || rerunnableFailed === 0} style={actionButtonStyle(rerunnableFailed > 0, '#ff9800')}>
              重跑失败项（{rerunnableFailed}）
            </button>
            {running && <span style={{ color: '#888', fontSize: '13px' }}>检查中...</span>}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {records.length === 0 && (
            <div style={{ textAlign: 'center', color: '#888', padding: '48px 0' }}>该题目暂无测试用例，请先在「编辑」中添加</div>
          )}
          {records.map(record => {
            const statusCfg = STATUS_CONFIG[record.status];
            return (
              <div key={record.fp} style={{ background: '#252525', borderRadius: '8px', border: `1px solid ${record.status === 'failed' ? 'rgba(244,67,54,0.4)' : '#333'}`, padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={record.selected}
                    onChange={() => setRecords(prev => prev.map(r => r.index === record.index ? { ...r, selected: !r.selected } : r))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ color: '#fff', fontWeight: 500 }}>样例 {record.index + 1}</span>
                  <span style={{ padding: '2px 10px', borderRadius: '10px', fontSize: '11px', background: 'rgba(102, 126, 234, 0.15)', color: '#667eea' }}>
                    {SAMPLE_TYPE_LABELS[record.sampleType]}
                  </span>
                  {record.hidden && (
                    <span style={{ padding: '2px 10px', borderRadius: '10px', fontSize: '11px', background: 'rgba(158,158,158,0.15)', color: '#9e9e9e' }}>隐藏用例</span>
                  )}
                  <span style={{ padding: '2px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: 500, background: statusCfg.bg, color: statusCfg.color }}>
                    {statusCfg.label}{record.manual ? ' · 人工确认' : ''}
                  </span>
                  {record.checkedAt && (
                    <span style={{ color: '#666', fontSize: '11px' }}>
                      检查于 {new Date(record.checkedAt).toLocaleString('zh-CN')}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {record.manual ? (
                    <button onClick={() => handleRevokeManual(record.index)} style={{ background: 'transparent', border: '1px solid #555', borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '12px', padding: '4px 12px' }}>
                      撤销人工确认
                    </button>
                  ) : (
                    record.status === 'failed' && (
                      <button onClick={() => handleManualConfirm(record.index)} style={{ background: 'transparent', border: '1px solid rgba(76,175,80,0.5)', borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '12px', padding: '4px 12px' }}>
                        人工确认为可发布
                      </button>
                    )
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <div style={{ color: '#888', fontSize: '11px', marginBottom: '4px' }}>输入</div>
                    <pre style={{ margin: 0, padding: '10px 12px', background: '#1e1e1e', borderRadius: '4px', border: '1px solid #333', color: '#ce9178', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '120px', overflowY: 'auto' }}>{record.input}</pre>
                  </div>
                  <div>
                    <div style={{ color: '#888', fontSize: '11px', marginBottom: '4px' }}>预期输出</div>
                    <pre style={{ margin: 0, padding: '10px 12px', background: '#1e1e1e', borderRadius: '4px', border: '1px solid #333', color: '#4ec9b0', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '120px', overflowY: 'auto' }}>{record.expectedOutput}</pre>
                  </div>
                </div>
                {record.issues.length > 0 && (
                  <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {record.issues.map((issue, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: issue.level === 'error' ? '#f44336' : '#ff9800' }}>
                        <span>{issue.level === 'error' ? '❌' : '⚠️'}</span>
                        <span style={{ padding: '1px 8px', borderRadius: '8px', fontSize: '11px', border: `1px solid ${issue.level === 'error' ? 'rgba(244,67,54,0.4)' : 'rgba(255,152,0,0.4)'}` }}>
                          {issue.category}
                        </span>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {record.status === 'passed' && record.issues.length === 0 && (
                  <div style={{ marginTop: '12px', color: '#4caf50', fontSize: '12px' }}>✅ 空值、边界、预期结果检查均通过</div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ padding: '14px 24px', borderTop: '1px solid #333', background: '#1a1a1a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
          <span style={{ color: '#666', fontSize: '12px' }}>
            预检结果仅保存在本机浏览器，不会写入题目数据；查看侧（面试房间、候选人视图）仍只展示已确认的题目内容
          </span>
          <button
            onClick={onClose}
            style={{ padding: '10px 24px', borderRadius: '4px', border: 'none', background: '#4caf50', color: '#fff', cursor: 'pointer', fontSize: '14px', flexShrink: 0 }}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
