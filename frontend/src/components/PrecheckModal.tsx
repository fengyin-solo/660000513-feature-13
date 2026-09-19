import React, { useEffect, useMemo, useState } from 'react';
import type { Problem, SampleKind, TestCase, TestCaseReviewStatus } from '../types';
import { getReviewStatus } from '../types';
import { updateProblem } from '../services/problemService';
import {
  analyzeCoverage,
  checkTestCase,
  inferSampleKind,
  runPrecheck,
  SAMPLE_KIND_OPTIONS,
  summarizeProblem,
} from '../services/precheckService';
import { useInterviewStore } from '../store/interview';
import { useToastStore } from '../store/toast';

interface PrecheckModalProps {
  isOpen: boolean;
  problem: Problem | null;
  onClose: () => void;
  onSaved: (problem: Problem) => void;
}

const KIND_LABELS: Record<SampleKind, string> = {
  'integer-array': '整数数组',
  'string': '字符串',
  'linked-list': '链表',
  'nested-array': '嵌套数组',
  'other': '其他',
};

const STATUS_META: Record<TestCaseReviewStatus, { label: string; color: string; bg: string; border: string; icon: string }> = {
  pending: { label: '待处理', color: '#ff9800', bg: 'rgba(255, 152, 0, 0.12)', border: 'rgba(255, 152, 0, 0.4)', icon: '⏳' },
  passed: { label: '可发布', color: '#4caf50', bg: 'rgba(76, 175, 80, 0.12)', border: 'rgba(76, 175, 80, 0.4)', icon: '✅' },
  failed: { label: '需修正', color: '#f44336', bg: 'rgba(244, 67, 54, 0.12)', border: 'rgba(244, 67, 54, 0.4)', icon: '❌' },
};

const STATUS_FILTERS: { value: TestCaseReviewStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'passed', label: '可发布' },
  { value: 'failed', label: '需修正' },
];

export const PrecheckModal: React.FC<PrecheckModalProps> = ({ isOpen, problem, onClose, onSaved }) => {
  const updateProblemInStore = useInterviewStore(s => s.updateProblem);
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToastStore();

  const [cases, setCases] = useState<TestCase[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [kindFilter, setKindFilter] = useState<SampleKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TestCaseReviewStatus | 'all'>('all');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (isOpen && problem) {
      // 打开时以服务端已持久化的内容为准，未检查记录保持“待处理”
      setCases(problem.testCases.map(t => ({ ...t, sampleKind: t.sampleKind ?? inferSampleKind(t.input) })));
      setSelected(new Set(problem.testCases.map((_, i) => i)));
      setKindFilter('all');
      setStatusFilter('all');
      setDirty(false);
      setRunning(false);
      setSaving(false);
    }
  }, [isOpen, problem]);

  const summary = useMemo(
    () => (problem ? summarizeProblem({ ...problem, testCases: cases }) : { total: 0, pending: 0, passed: 0, failed: 0 }),
    [problem, cases],
  );

  const coverage = useMemo(
    () => (problem ? analyzeCoverage({ ...problem, testCases: cases }) : { hasEmptyCase: false, hasBoundaryCase: false, warnings: [] }),
    [problem, cases],
  );

  const visibleIndices = useMemo(() => {
    return cases
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => {
        const kind = t.sampleKind ?? inferSampleKind(t.input);
        if (kindFilter !== 'all' && kind !== kindFilter) return false;
        if (statusFilter !== 'all' && getReviewStatus(t) !== statusFilter) return false;
        return true;
      })
      .map(({ i }) => i);
  }, [cases, kindFilter, statusFilter]);

  const failedIndices = useMemo(
    () => cases.map((t, i) => ({ t, i })).filter(({ t }) => getReviewStatus(t) === 'failed').map(({ i }) => i),
    [cases],
  );

  if (!isOpen || !problem) return null;

  const toggleSelect = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const allVisibleSelected = visibleIndices.length > 0 && visibleIndices.every(i => selected.has(i));

  const toggleSelectAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleIndices.forEach(i => next.delete(i));
      } else {
        visibleIndices.forEach(i => next.add(i));
      }
      return next;
    });
  };

  const markRan = (updated: TestCase[], indices: number[]) => {
    const ran = new Set(indices);
    const passed = updated.filter((t, i) => ran.has(i) && getReviewStatus(t) === 'passed').length;
    const failed = updated.filter((t, i) => ran.has(i) && getReviewStatus(t) === 'failed').length;
    if (failed > 0) {
      toastInfo(`本次检查完成：${passed} 条可发布，${failed} 条需修正`);
    } else {
      toastSuccess(`本次检查的 ${passed} 条记录均可发布`);
    }
  };

  const handleRunSelected = async (indices: number[]) => {
    if (indices.length === 0 || running) return;
    setRunning(true);
    try {
      // runPrecheck 只更新指定记录的审核字段，输入 / 预期输出等人工内容原样保留
      const updated = await runPrecheck({ ...problem, testCases: cases }, indices);
      setCases(updated);
      setDirty(true);
      markRan(updated, indices);
    } finally {
      setRunning(false);
    }
  };

  const handleRerunFailed = async () => {
    if (failedIndices.length === 0 || running) return;
    setSelected(new Set(failedIndices));
    await handleRunSelected(failedIndices);
  };

  /** 人工修改后该条回到待处理，避免把旧结论当作已确认内容 */
  const handleFieldEdit = (index: number, field: keyof TestCase, value: string | boolean) => {
    setCases(prev => prev.map((t, i) => {
      if (i !== index) return t;
      const next = { ...t, [field]: value };
      if (field === 'input') next.sampleKind = inferSampleKind(String(value));
      next.reviewStatus = 'pending';
      next.reviewNote = '内容已人工修改，尚未重新检查';
      next.reviewedAt = undefined;
      return next;
    }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await updateProblem(problem.id, {
        id: problem.id,
        title: problem.title,
        difficulty: problem.difficulty,
        description: problem.description,
        examples: problem.examples,
        testCases: cases,
        tags: problem.tags,
        timeLimit: problem.timeLimit,
        memoryLimit: problem.memoryLimit,
      });
      updateProblemInStore(saved);
      onSaved(saved);
      setDirty(false);
      toastSuccess(`「${problem.title}」预检结果已保存`);
    } catch (err) {
      console.error('Failed to save precheck results:', err);
      toastError('保存预检结果失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (dirty && !window.confirm('有尚未保存的检查结果或修改，关闭后将丢失。确定关闭吗？')) return;
    onClose();
  };

  const cardStyle: React.CSSProperties = {
    background: '#252525',
    borderRadius: '8px',
    padding: '14px 16px',
    border: '1px solid #333',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '4px',
    border: '1px solid #555',
    background: '#2d2d2d',
    color: '#fff',
    fontSize: '13px',
    fontFamily: 'monospace',
    boxSizing: 'border-box',
    resize: 'vertical',
  };

  const selectable = !running;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}>
      <div style={{ background: '#1e1e1e', borderRadius: '8px', width: '980px', maxWidth: '94vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', border: '1px solid #333' }}>
        {/* Header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ color: '#fff', margin: 0, fontSize: '18px' }}>发布前预检 · {problem.title}</h2>
            <p style={{ color: '#888', margin: '4px 0 0', fontSize: '12px' }}>
              在本地开发环境检查空值、边界与预期结果；仅已确认（可发布）的用例会对候选人可见
            </p>
          </div>
          <button onClick={handleClose} style={{ background: 'transparent', border: 'none', color: '#888', fontSize: '24px', cursor: 'pointer' }}>×</button>
        </div>

        {/* Summary */}
        <div style={{ padding: '14px 24px', borderBottom: '1px solid #333', background: '#1a1a1a', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
          <SummaryPill label="总记录" value={summary.total} color="#ccc" />
          <SummaryPill label="待处理" value={summary.pending} color="#ff9800" />
          <SummaryPill label="可发布" value={summary.passed} color="#4caf50" />
          <SummaryPill label="需修正" value={summary.failed} color="#f44336" />
          <span style={{ color: '#666', fontSize: '12px', marginLeft: 'auto' }}>
            已选 {selected.size}/{summary.total} 条
          </span>
        </div>

        {coverage.warnings.length > 0 && (
          <div style={{ padding: '10px 24px', background: 'rgba(255, 152, 0, 0.08)', borderBottom: '1px solid rgba(255, 152, 0, 0.25)' }}>
            {coverage.warnings.map((w, i) => (
              <div key={i} style={{ color: '#ffb74d', fontSize: '12px', lineHeight: 1.6 }}>⚠️ {w}</div>
            ))}
          </div>
        )}

        {/* Toolbar */}
        <div style={{ padding: '12px 24px', borderBottom: '1px solid #333', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {SAMPLE_KIND_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setKindFilter(opt.value)}
                style={{
                  padding: '5px 12px',
                  borderRadius: '14px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  border: `1px solid ${kindFilter === opt.value ? '#667eea' : '#444'}`,
                  background: kindFilter === opt.value ? 'rgba(102, 126, 234, 0.15)' : 'transparent',
                  color: kindFilter === opt.value ? '#a5b4fc' : '#888',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as TestCaseReviewStatus | 'all')}
            style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #444', background: '#2d2d2d', color: '#ccc', fontSize: '12px' }}
          >
            {STATUS_FILTERS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button
              onClick={() => handleRunSelected([...selected])}
              disabled={!selectable || selected.size === 0}
              style={toolbarButton('#667eea', !selectable || selected.size === 0)}
            >
              {running ? '检查中…' : `▶ 检查选中（${selected.size}）`}
            </button>
            <button
              onClick={handleRerunFailed}
              disabled={!selectable || failedIndices.length === 0}
              style={toolbarButton('#ff9800', !selectable || failedIndices.length === 0)}
            >
              ↻ 只重跑需修正（{failedIndices.length}）
            </button>
          </div>
        </div>

        {/* Records */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {cases.length === 0 && (
            <div style={{ textAlign: 'center', color: '#888', padding: '48px', fontSize: '13px' }}>该题目暂无测试用例，请先在题目编辑中添加。</div>
          )}
          {visibleIndices.length === 0 && cases.length > 0 && (
            <div style={{ textAlign: 'center', color: '#888', padding: '48px', fontSize: '13px' }}>当前筛选条件下没有记录</div>
          )}
          {visibleIndices.map(index => {
            const testCase = cases[index];
            const status = getReviewStatus(testCase);
            const meta = STATUS_META[status];
            const kind = testCase.sampleKind ?? inferSampleKind(testCase.input);
            const probe = testCase.input.trim() && testCase.expectedOutput.trim()
              ? checkTestCase(problem, testCase, index)
              : null;
            const isBoundary = probe?.isBoundary ?? false;
            return (
              <div key={index} style={{ ...cardStyle, borderColor: status === 'failed' ? 'rgba(244,67,54,0.4)' : status === 'passed' ? 'rgba(76,175,80,0.3)' : '#333' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => toggleSelect(index)}
                    disabled={!selectable}
                  />
                  <span style={{ color: '#fff', fontWeight: 500, fontSize: '13px' }}>#{index + 1}</span>
                  <span style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '11px', background: 'rgba(102,126,234,0.12)', color: '#a5b4fc' }}>
                    {KIND_LABELS[kind]}
                  </span>
                  {isBoundary && (
                    <span style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '11px', background: 'rgba(0,188,212,0.12)', color: '#4dd0e1' }}>
                      边界样例
                    </span>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#888', fontSize: '11px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={testCase.hidden} onChange={e => handleFieldEdit(index, 'hidden', e.target.checked)} />
                    隐藏用例
                  </label>
                  <span style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}>
                    {meta.icon} {meta.label}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label style={{ display: 'block', color: '#888', fontSize: '11px', marginBottom: '4px' }}>输入</label>
                    <textarea
                      rows={2}
                      value={testCase.input}
                      onChange={e => handleFieldEdit(index, 'input', e.target.value)}
                      placeholder="样例输入，如 [2,7,11,15]&#10;9"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', color: '#888', fontSize: '11px', marginBottom: '4px' }}>预期输出</label>
                    <textarea
                      rows={2}
                      value={testCase.expectedOutput}
                      onChange={e => handleFieldEdit(index, 'expectedOutput', e.target.value)}
                      placeholder="预期结果，如 [0,1]"
                      style={inputStyle}
                    />
                  </div>
                </div>

                {testCase.reviewNote && (
                  <div style={{
                    marginTop: '10px',
                    padding: '8px 12px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    lineHeight: 1.6,
                    color: status === 'failed' ? '#ef9a9a' : status === 'passed' ? '#a5d6a7' : '#ffb74d',
                    background: status === 'failed' ? 'rgba(244,67,54,0.08)' : status === 'passed' ? 'rgba(76,175,80,0.07)' : 'rgba(255,152,0,0.08)',
                    border: `1px solid ${meta.border}`,
                  }}>
                    {meta.icon} {testCase.reviewNote}
                    {testCase.reviewedAt && (
                      <span style={{ display: 'block', marginTop: '4px', color: '#777', fontSize: '11px' }}>
                        最近检查：{new Date(testCase.reviewedAt).toLocaleString('zh-CN')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1a1a1a' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#888', fontSize: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} disabled={!selectable || visibleIndices.length === 0} />
            全选当前筛选（{visibleIndices.length}）
          </label>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleClose}
              disabled={saving}
              style={{ padding: '9px 22px', borderRadius: '4px', border: '1px solid #555', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: '13px' }}
            >
              关闭
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || saving || running}
              title={dirty ? '保存检查结论与人工修改' : '没有待保存的变更'}
              style={{
                padding: '9px 22px', borderRadius: '4px', border: 'none', fontSize: '13px',
                background: (!dirty || saving || running) ? '#3a3a3a' : '#4caf50',
                color: (!dirty || saving || running) ? '#777' : '#fff',
                cursor: (!dirty || saving || running) ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? '保存中…' : '保存检查结果'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const SummaryPill: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <span style={{
    padding: '5px 12px',
    borderRadius: '14px',
    fontSize: '12px',
    fontWeight: 600,
    color,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid #333',
  }}>
    {label} {value}
  </span>
);

const toolbarButton = (color: string, disabled: boolean): React.CSSProperties => ({
  padding: '7px 14px',
  borderRadius: '6px',
  fontSize: '12px',
  fontWeight: 500,
  border: `1px solid ${disabled ? '#444' : color}`,
  background: disabled ? 'transparent' : `${color}22`,
  color: disabled ? '#666' : color,
  cursor: disabled ? 'not-allowed' : 'pointer',
});
