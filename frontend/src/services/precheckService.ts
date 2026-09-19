import type {
  PrecheckIssue,
  PrecheckRecordResult,
  Problem,
  SampleType,
} from '../types';

/**
 * 发布前预检服务（纯本地执行）。
 *
 * 设计约束：
 * - 所有检查都在本地开发环境（浏览器）内完成，不调用后端；
 * - 预检结果只写入 localStorage，不会混入 Problem / testCases 数据，
 *   因此查看侧（面试房间、候选人视图）始终只展示已确认的题目内容；
 * - 结果以「题目 ID + 样例内容指纹」为键，人工修改过内容的样例
 *   会被视为新记录重新待处理，其余记录的结果保持不变。
 */

const STORAGE_KEY = 'code_interview_precheck_v1';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/** 常规 OJ 对数组 / 字符串长度的上限 */
const LENGTH_LIMIT = 10000;
/** 接近 32 位整数边界时给出提醒 */
const ELEMENT_WARN_LIMIT = 1e9;

// ---------- 样例类型识别 ----------

const tryParseJson = (raw: string): { ok: boolean; value?: unknown } => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

const isIntegerArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every(item => typeof item === 'number' && Number.isInteger(item));

const isIntegerMatrix = (v: unknown): v is number[][] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(row => Array.isArray(row) && row.every(item => typeof item === 'number' && Number.isInteger(item)));

/** 识别单个值（一行输入 / 预期输出）的样例类型 */
export const detectSampleType = (raw: string): SampleType => {
  const parsed = tryParseJson(raw.trim());
  if (!parsed.ok) return 'other';
  const value = parsed.value;
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (isIntegerMatrix(value)) return 'int-matrix';
  if (isIntegerArray(value)) return 'int-array';
  if (Array.isArray(value)) return 'array';
  return 'other';
};

const splitInputLines = (input: string): string[] =>
  input.split('\n').map(line => line.trim()).filter(line => line.length > 0);

/** 记录的主类型取输入首行的类型（如两数之和的首行是整数数组） */
export const detectRecordSampleType = (input: string): SampleType => {
  const firstLine = splitInputLines(input)[0];
  return firstLine ? detectSampleType(firstLine) : 'other';
};

// ---------- 内置题目的参考解（用于校验预期结果） ----------

type ReferenceSolution = (input: string) => string | null;

const parseFirstLine = (input: string): unknown => {
  const firstLine = splitInputLines(input)[0];
  if (!firstLine) return undefined;
  const parsed = tryParseJson(firstLine);
  return parsed.ok ? parsed.value : undefined;
};

const refTwoSum: ReferenceSolution = (input) => {
  const lines = splitInputLines(input);
  if (lines.length < 2) return null;
  const numsParsed = tryParseJson(lines[0]);
  const targetParsed = tryParseJson(lines[1]);
  if (!numsParsed.ok || !targetParsed.ok) return null;
  const nums = numsParsed.value;
  const target = targetParsed.value;
  if (!isIntegerArray(nums) || typeof target !== 'number') return null;
  const seen = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    const hit = seen.get(complement);
    if (hit !== undefined) return JSON.stringify([hit, i]);
    seen.set(nums[i], i);
  }
  return null;
};

const refValidParentheses: ReferenceSolution = (input) => {
  const s = parseFirstLine(input);
  if (typeof s !== 'string') return null;
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return 'false';
    }
  }
  return stack.length === 0 ? 'true' : 'false';
};

const refLongestSubstring: ReferenceSolution = (input) => {
  const s = parseFirstLine(input);
  if (typeof s !== 'string') return null;
  const lastSeen = new Map<string, number>();
  let best = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const prev = lastSeen.get(s[i]);
    if (prev !== undefined && prev >= start) start = prev + 1;
    lastSeen.set(s[i], i);
    best = Math.max(best, i - start + 1);
  }
  return String(best);
};

/** 内置题目（两数之和、有效的括号、无重复字符的最长子串）提供参考解校验 */
const REFERENCE_SOLUTIONS: Record<string, ReferenceSolution> = {
  两数之和: refTwoSum,
  有效的括号: refValidParentheses,
  无重复字符的最长子串: refLongestSubstring,
};

export const resolveReferenceKey = (problemTitle: string): string | null => {
  const title = problemTitle.trim();
  return REFERENCE_SOLUTIONS[title] ? title : null;
};

/** 两数之和允许任意顺序返回下标，比较前做归一化 */
const normalizeExpected = (referenceKey: string | null, raw: string): string => {
  const parsed = tryParseJson(raw.trim());
  if (!parsed.ok) return raw.trim();
  if (
    referenceKey === '两数之和' &&
    isIntegerArray(parsed.value) &&
    parsed.value.length === 2
  ) {
    return JSON.stringify([...parsed.value].sort((a, b) => a - b));
  }
  return JSON.stringify(parsed.value);
};

// ---------- 单条样例检查 ----------

export interface CheckContext {
  /** 题目内置参考解的键（按标题匹配），无参考解时仅做结构校验 */
  referenceKey: string | null;
  /** 其余样例预期输出的类型，用于发现类型不一致 */
  peerExpectedTypes: SampleType[];
}

const checkBoundaryValue = (value: unknown, label: string, issues: PrecheckIssue[]) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push({ level: 'error', category: '边界', message: `${label}包含非法数值` });
    } else if (!Number.isInteger(value)) {
      issues.push({ level: 'warning', category: '边界', message: `${label}包含非整数数值，请确认题目约束` });
    } else if (value > INT32_MAX || value < INT32_MIN) {
      issues.push({ level: 'error', category: '边界', message: `${label}超出 32 位整数范围` });
    } else if (Math.abs(value) > ELEMENT_WARN_LIMIT) {
      issues.push({ level: 'warning', category: '边界', message: `${label}接近 32 位整数边界，请确认题目约束` });
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      issues.push({ level: 'warning', category: '边界', message: `${label}为空字符串（边界用例）` });
    } else if (value.length > LENGTH_LIMIT) {
      issues.push({ level: 'warning', category: '边界', message: `${label}长度超过常规上限 10^4` });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      issues.push({ level: 'warning', category: '边界', message: `${label}为空数组（边界用例）` });
    } else if (value.length > LENGTH_LIMIT) {
      issues.push({ level: 'warning', category: '边界', message: `${label}长度超过常规上限 10^4` });
    }
    if (value.some(item => item === null)) {
      issues.push({ level: 'error', category: '空值', message: `${label}包含 null 元素` });
    }
    if (
      value.some(Array.isArray) &&
      new Set((value as unknown[][]).filter(Array.isArray).map(row => row.length)).size > 1
    ) {
      issues.push({ level: 'warning', category: '边界', message: `${label}各行长度不一致` });
    }
    value.forEach((item, i) => {
      if (typeof item === 'number') checkBoundaryValue(item, `${label}第 ${i + 1} 项`, issues);
    });
  }
};

/** 检查单条样例：空值、格式、边界、预期结果 */
export const checkTestCaseRecord = (
  input: string,
  expectedOutput: string,
  ctx: CheckContext,
): { status: 'passed' | 'failed'; issues: PrecheckIssue[] } => {
  const issues: PrecheckIssue[] = [];
  const trimmedInput = input.trim();
  const trimmedExpected = expectedOutput.trim();

  // 1. 空值检查
  if (!trimmedInput) {
    issues.push({ level: 'error', category: '空值', message: '输入内容为空' });
  }
  if (!trimmedExpected) {
    issues.push({ level: 'error', category: '空值', message: '预期输出为空' });
  }
  if (/\b(null|undefined)\b/.test(trimmedInput)) {
    issues.push({ level: 'error', category: '空值', message: '输入中包含 null / undefined 字面量' });
  }

  // 2. 输入格式与边界
  const lines = splitInputLines(trimmedInput);
  const parsedValues: unknown[] = [];
  let inputParseFailed = false;
  lines.forEach((line, i) => {
    const parsed = tryParseJson(line);
    if (!parsed.ok) {
      inputParseFailed = true;
      issues.push({ level: 'error', category: '格式', message: `第 ${i + 1} 行输入不是合法的 JSON 值：${line}` });
      return;
    }
    if (parsed.value === null) {
      issues.push({ level: 'error', category: '空值', message: `第 ${i + 1} 行输入解析结果为 null` });
    }
    parsedValues.push(parsed.value);
    checkBoundaryValue(parsed.value, `第 ${i + 1} 行输入`, issues);
  });

  // 3. 预期结果检查
  const parsedExpected = tryParseJson(trimmedExpected);
  if (trimmedExpected && !parsedExpected.ok) {
    issues.push({ level: 'error', category: '预期结果', message: '预期输出不是合法的 JSON 值' });
  } else if (parsedExpected.ok) {
    if (parsedExpected.value === null) {
      issues.push({ level: 'error', category: '空值', message: '预期输出解析结果为 null' });
    }
    const expectedType = detectSampleType(trimmedExpected);
    if (expectedType !== 'other' && ctx.peerExpectedTypes.length > 0) {
      const counts = new Map<SampleType, number>();
      ctx.peerExpectedTypes.filter(t => t !== 'other').forEach(t => counts.set(t, (counts.get(t) ?? 0) + 1));
      const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (majority && majority[0] !== expectedType && majority[1] >= 2) {
        issues.push({ level: 'warning', category: '预期结果', message: '预期输出类型与其他样例不一致，请确认' });
      }
    }
    checkBoundaryValue(parsedExpected.value, '预期输出', issues);
  }

  // 4. 内置参考解校验预期结果
  if (!inputParseFailed && trimmedExpected && parsedExpected.ok && ctx.referenceKey) {
    const reference = REFERENCE_SOLUTIONS[ctx.referenceKey];
    const actual = reference ? reference(trimmedInput) : null;
    if (actual === null) {
      issues.push({ level: 'warning', category: '预期结果', message: '参考解无法处理该输入，未校验预期结果' });
    } else if (normalizeExpected(ctx.referenceKey, trimmedExpected) !== normalizeExpected(ctx.referenceKey, actual)) {
      issues.push({ level: 'error', category: '预期结果', message: `预期输出与参考解计算结果不一致（参考解：${actual}）` });
    }
  }

  return { status: issues.some(issue => issue.level === 'error') ? 'failed' : 'passed', issues };
};

// ---------- 结果持久化（localStorage） ----------

/** 样例内容指纹：人工修改内容后指纹变化，旧结果自动失效 */
export const fingerprint = (input: string, expectedOutput: string): string => {
  const text = `${input} ${expectedOutput}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
};

type PrecheckStore = Record<string, Record<string, PrecheckRecordResult>>;

const readStore = (): PrecheckStore => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PrecheckStore;
  } catch (e) {
    console.warn('Failed to load precheck results:', e);
  }
  return {};
};

const writeStore = (store: PrecheckStore) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn('Failed to save precheck results:', e);
  }
};

export const loadPrecheckResults = (problemId: string): Record<string, PrecheckRecordResult> => {
  return readStore()[problemId] ?? {};
};

/**
 * 合并写入预检结果：只更新本次涉及的记录，其余记录（包括人工确认过的）保持不变；
 * 已不在题目中的指纹会被清理。
 */
export const savePrecheckResults = (
  problemId: string,
  updates: Record<string, PrecheckRecordResult>,
  validFingerprints: string[],
) => {
  const store = readStore();
  const existing = store[problemId] ?? {};
  const merged: Record<string, PrecheckRecordResult> = {};
  validFingerprints.forEach(fp => {
    if (updates[fp]) {
      merged[fp] = updates[fp];
    } else if (existing[fp]) {
      merged[fp] = existing[fp];
    }
  });
  store[problemId] = merged;
  writeStore(store);
};

export const clearPrecheckResults = (problemId: string) => {
  const store = readStore();
  delete store[problemId];
  writeStore(store);
};

// ---------- 汇总（题库列表展示用） ----------

export interface PrecheckSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  manual: number;
}

export const getPrecheckSummary = (problem: Problem): PrecheckSummary => {
  const stored = loadPrecheckResults(problem.id);
  const summary: PrecheckSummary = { total: problem.testCases.length, passed: 0, failed: 0, pending: 0, manual: 0 };
  problem.testCases.forEach(tc => {
    const result = stored[fingerprint(tc.input, tc.expectedOutput)];
    if (!result) {
      summary.pending += 1;
    } else if (result.status === 'passed') {
      summary.passed += 1;
      if (result.manual) summary.manual += 1;
    } else {
      summary.failed += 1;
    }
  });
  return summary;
};
