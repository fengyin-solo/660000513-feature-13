import type { Problem, SampleKind, TestCase, TestCaseReviewStatus } from '../types';
import { getReviewStatus } from '../types';

/**
 * 发布前预检引擎（纯本地执行，不依赖后端 / 沙箱）。
 *
 * 三类检查：
 *  1. 空值检查：输入或预期输出缺失；
 *  2. 边界与格式检查：识别整数数组、字符串等样例，校验格式是否可解析、
 *     并标注是否覆盖空值 / 单元素等边界；
 *  3. 预期结果检查：对内置题目用参考解重新计算，与面试官填写的预期输出比对。
 */

export interface CheckIssue {
  /** 失败原因（failed 时给出） */
  reason?: string;
  /** 非阻断性提示（如边界覆盖情况、未知题型跳过预期比对等） */
  warnings: string[];
}

export interface TestCaseCheckResult extends CheckIssue {
  index: number;
  status: Extract<TestCaseReviewStatus, 'passed' | 'failed'>;
  kind: SampleKind;
  /** 是否属于边界样例（空值 / 空串 / 单元素等） */
  isBoundary: boolean;
  /** 参考解算出的实际结果（仅可比对时存在） */
  actual?: string;
  checkedAt: string;
}

export interface SuiteCoverage {
  hasEmptyCase: boolean;
  hasBoundaryCase: boolean;
  warnings: string[];
}

/* ----------------------------- 样例类型识别 ----------------------------- */

const leadingQuotedString = (raw: string): string | null => {
  const s = raw.trimStart();
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0];
    const end = s.indexOf(quote, 1);
    // 末尾引号必须一直覆盖到行尾（允许尾随空白）
    if (end !== -1 && s.slice(end + 1).trim() === '') {
      return s.slice(1, end);
    }
  }
  return null;
};

/** 多输入行（如两数之和「数组 + target」）时判断首行是否为整数数组 */
const looksLikeIntArray = (literal: string): boolean => {
  const s = literal.trim();
  if (!s.startsWith('[')) return false;
  const inner = s.slice(1, s.endsWith(']') ? -1 : undefined).trim();
  if (inner === '') return true;
  return inner.split(',').every(part => /^[+-]?\d+$/.test(part.trim()));
};

export const inferSampleKind = (input: string): SampleKind => {
  if (leadingQuotedString(input) !== null) return 'string';
  // 取首个有效行判断，兼容「数组\n target」这类多行输入
  const firstLine = input.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  if (!firstLine) return 'other';
  if (!firstLine.startsWith('[')) return 'other';
  if (looksLikeIntArray(firstLine)) return 'integer-array';
  // 去掉外层数组后内部仍含 [，视为嵌套数组（链表数组等）
  const inner = firstLine.slice(1, firstLine.endsWith(']') ? -1 : undefined).trim();
  if (inner.includes('[')) return 'nested-array';
  return 'linked-list';
};

export const SAMPLE_KIND_OPTIONS: { value: SampleKind | 'all'; label: string }[] = [
  { value: 'all', label: '全部样例' },
  { value: 'integer-array', label: '整数数组' },
  { value: 'string', label: '字符串' },
  { value: 'linked-list', label: '链表' },
  { value: 'nested-array', label: '嵌套数组' },
  { value: 'other', label: '其他' },
];

/* ------------------------------- 解析工具 ------------------------------- */

const parseIntArray = (literal: string): number[] => {
  const s = literal.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) {
    throw new Error('数组需以 [ ] 包裹，元素为逗号分隔的整数');
  }
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map(part => {
    const t = part.trim();
    if (!/^[+-]?\d+$/.test(t)) {
      throw new Error(`「${t}」不是合法整数`);
    }
    return Number(t);
  });
};

const parseQuotedString = (input: string): string => {
  const value = leadingQuotedString(input);
  if (value === null) {
    throw new Error('字符串入参需使用引号包裹，例如 "abc"');
  }
  return value;
};

/** 预期输出：整形数组（下标 / 链表序列化结果） */
const expectIntArray = (literal: string): number[] => parseIntArray(literal.trim());

const boolOf = (literal: string): boolean | null => {
  const s = literal.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
};

/** 数组顺序无关时的比较（两数之和可按任意顺序返回下标） */
const sameIntArrayOrderAgnostic = (a: number[], b: number[]): boolean =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');

/* ------------------------------- 参考解 ------------------------------- */

const twoSumSolve = (nums: number[], target: number): number[] => {
  const seen = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const j = seen.get(target - nums[i]);
    if (j !== undefined) return [j, i];
    seen.set(nums[i], i);
  }
  return [];
};

const validParenthesesSolve = (s: string): boolean => {
  const stack: string[] = [];
  const closeToOpen: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else {
      if (stack.pop() !== closeToOpen[ch]) return false;
    }
  }
  return stack.length === 0;
};

const longestSubstringSolve = (s: string): number => {
  const last = new Map<string, number>();
  let left = 0;
  let best = 0;
  for (let right = 0; right < s.length; right++) {
    const prev = last.get(s[right]);
    if (prev !== undefined && prev >= left) left = prev + 1;
    last.set(s[right], right);
    best = Math.max(best, right - left + 1);
  }
  return best;
};

const addTwoNumbersSolve = (l1: number[], l2: number[]): number[] => {
  const result: number[] = [];
  let carry = 0;
  const n = Math.max(l1.length, l2.length);
  for (let i = 0; i < n || carry; i++) {
    const sum = (l1[i] ?? 0) + (l2[i] ?? 0) + carry;
    result.push(sum % 10);
    carry = Math.floor(sum / 10);
  }
  return result;
};

const mergeKSortedListsSolve = (lists: number[][]): number[] => {
  const merged: number[] = [];
  for (const list of lists) {
    for (const v of list) {
      if (!Number.isInteger(v)) throw new Error('链表节点必须是整数');
      merged.push(v);
    }
  }
  merged.sort((a, b) => a - b);
  return merged;
};

type SolverKind = 'two-sum' | 'valid-parentheses' | 'longest-substring' | 'add-two-numbers' | 'merge-k-lists';

const detectSolver = (problem: Problem): SolverKind | null => {
  const title = problem.title.replace(/\s/g, '');
  if (title.includes('两数之和')) return 'two-sum';
  if (title.includes('有效') && title.includes('括号')) return 'valid-parentheses';
  if (title.includes('无重复') || (title.includes('最长') && title.includes('子串'))) return 'longest-substring';
  if (title.includes('两数相加')) return 'add-two-numbers';
  if (title.includes('合并') && title.includes('升序链表')) return 'merge-k-lists';
  return null;
};

const parseNestedIntArrays = (literal: string): number[][] => {
  const s = literal.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) {
    throw new Error('链表数组需以 [ ] 包裹');
  }
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  const arrays: number[][] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (inner[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        arrays.push(parseIntArray(inner.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  if (depth !== 0) throw new Error('数组括号未闭合');
  return arrays;
};

interface ExpectedCheck {
  ok: boolean;
  actual?: string;
  reason?: string;
  /** true 表示该题型不支持参考解，跳过预期比对（非失败） */
  skipped?: boolean;
}

const checkExpected = (kind: SolverKind, testCase: TestCase): ExpectedCheck => {
  try {
    switch (kind) {
      case 'two-sum': {
        const lines = testCase.input.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) return { ok: false, reason: '输入需包含两行：整数数组与目标值 target' };
        const nums = parseIntArray(lines[0]);
        if (!/^[+-]?\d+$/.test(lines[1])) return { ok: false, reason: `目标值「${lines[1]}」不是合法整数` };
        const target = Number(lines[1]);
        let expected: number[];
        try {
          expected = expectIntArray(testCase.expectedOutput);
        } catch {
          return { ok: false, reason: '预期输出需为整数下标数组，例如 [0,1]' };
        }
        const actual = twoSumSolve(nums, target);
        return {
          ok: sameIntArrayOrderAgnostic(actual, expected),
          actual: JSON.stringify(actual),
          reason: sameIntArrayOrderAgnostic(actual, expected) ? undefined : `参考解返回 ${JSON.stringify(actual)}，与预期不一致`,
        };
      }
      case 'valid-parentheses': {
        const s = parseQuotedString(testCase.input);
        const expected = boolOf(testCase.expectedOutput);
        if (expected === null) return { ok: false, reason: '预期输出需为 true 或 false' };
        const actual = validParenthesesSolve(s);
        return {
          ok: actual === expected,
          actual: String(actual),
          reason: actual === expected ? undefined : `参考解返回 ${actual}，与预期 ${expected} 不一致`,
        };
      }
      case 'longest-substring': {
        const s = parseQuotedString(testCase.input);
        if (!/^[+-]?\d+$/.test(testCase.expectedOutput.trim())) {
          return { ok: false, reason: '预期输出需为非负整数' };
        }
        const expected = Number(testCase.expectedOutput.trim());
        const actual = longestSubstringSolve(s);
        return {
          ok: actual === expected,
          actual: String(actual),
          reason: actual === expected ? undefined : `参考解返回 ${actual}，与预期 ${expected} 不一致`,
        };
      }
      case 'add-two-numbers': {
        const lines = testCase.input.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) return { ok: false, reason: '输入需包含两行链表' };
        const l1 = parseIntArray(lines[0]);
        const l2 = parseIntArray(lines[1]);
        let expected: number[];
        try {
          expected = expectIntArray(testCase.expectedOutput);
        } catch {
          return { ok: false, reason: '预期输出需为整数数组' };
        }
        const actual = addTwoNumbersSolve(l1, l2);
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        return {
          ok,
          actual: JSON.stringify(actual),
          reason: ok ? undefined : `参考解返回 ${JSON.stringify(actual)}，与预期不一致`,
        };
      }
      case 'merge-k-lists': {
        const lists = parseNestedIntArrays(testCase.input);
        let expected: number[];
        try {
          expected = expectIntArray(testCase.expectedOutput);
        } catch {
          return { ok: false, reason: '预期输出需为合并后的整数数组' };
        }
        const actual = mergeKSortedListsSolve(lists);
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        return {
          ok,
          actual: JSON.stringify(actual),
          reason: ok ? undefined : `参考解返回 ${JSON.stringify(actual)}，与预期不一致`,
        };
      }
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '入参解析失败' };
  }
};

/* ----------------------------- 边界样例识别 ----------------------------- */

const isBoundaryCase = (kind: SampleKind, input: string): boolean => {
  try {
    if (kind === 'string') {
      const s = parseQuotedString(input);
      return s.length <= 1;
    }
    const firstLine = input.split('\n').map(l => l.trim()).find(Boolean) ?? '';
    if (kind === 'integer-array') {
      const arr = parseIntArray(firstLine);
      return arr.length <= 1;
    }
    if (kind === 'linked-list') {
      const arr = parseIntArray(firstLine);
      return arr.length <= 1;
    }
    if (kind === 'nested-array') {
      const lists = parseNestedIntArrays(firstLine);
      return lists.length === 0 || lists.some(l => l.length === 0);
    }
  } catch {
    /* 无法解析的样例不参与边界标注，格式问题会在检查中暴露 */
  }
  return false;
};

/* ------------------------------- 单条检查 ------------------------------- */

export const checkTestCase = (problem: Problem, testCase: TestCase, index: number): TestCaseCheckResult => {
  const warnings: string[] = [];
  const kind = inferSampleKind(testCase.input);
  const isBoundary = isBoundaryCase(kind, testCase.input);

  // 1) 空值检查
  if (!testCase.input.trim()) {
    return fail(index, kind, false, '输入为空：请补充样例输入', warnings);
  }
  if (!testCase.expectedOutput.trim()) {
    return fail(index, kind, false, '预期输出为空：请补充预期结果', warnings);
  }

  if (isBoundary) warnings.push('边界样例：已覆盖空值 / 单元素等边界场景');

  // 2) 格式检查（按样例类型）
  try {
    if (kind === 'string') {
      parseQuotedString(testCase.input);
    } else if (kind === 'integer-array') {
      const lines = testCase.input.split('\n').map(l => l.trim()).filter(Boolean);
      parseIntArray(lines[0]);
    } else if (kind === 'linked-list') {
      parseIntArray(testCase.input.split('\n').map(l => l.trim()).find(Boolean) ?? '');
    } else if (kind === 'nested-array') {
      parseNestedIntArrays(testCase.input.split('\n').map(l => l.trim()).find(Boolean) ?? '');
    }
  } catch (e) {
    return fail(index, kind, isBoundary, e instanceof Error ? `格式错误：${e.message}` : '格式错误', warnings);
  }

  // 3) 预期结果检查（仅内置题目有参考解；其他题型跳过，不阻断发布）
  const solver = detectSolver(problem);
  if (!solver) {
    warnings.push('未匹配到内置参考解，已跳过预期结果自动比对，请人工确认');
    return {
      index, status: 'passed', kind, isBoundary, warnings,
      checkedAt: new Date().toISOString(),
    };
  }

  const result = checkExpected(solver, testCase);
  if (result.skipped) warnings.push('该题型暂不支持预期结果自动比对，请人工确认');
  if (result.actual !== undefined) warnings.push(`参考解结果：${result.actual}`);

  if (!result.ok) {
    return fail(index, kind, isBoundary, result.reason ?? '预期结果不一致', warnings, result.actual);
  }
  return {
    index, status: 'passed', kind, isBoundary,
    actual: result.actual,
    warnings,
    checkedAt: new Date().toISOString(),
  };
};

const fail = (
  index: number,
  kind: SampleKind,
  isBoundary: boolean,
  reason: string,
  warnings: string[],
  actual?: string,
): TestCaseCheckResult => ({
  index,
  status: 'failed',
  kind,
  isBoundary,
  reason,
  actual,
  warnings,
  checkedAt: new Date().toISOString(),
});

/* ------------------------------- 批量检查 ------------------------------- */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 仅检查 indices 指向的记录；其余记录原样返回，保证“部分失败只重跑对应记录”，
 * 且检查过程只读，不覆盖人工修改的输入 / 预期输出。
 */
export const runPrecheck = async (
  problem: Problem,
  indices: number[],
): Promise<TestCase[]> => {
  await delay(450); // 模拟本地校验耗时
  const target = new Set(indices);
  return problem.testCases.map((testCase, index) => {
    if (!target.has(index)) return testCase;
    const result = checkTestCase(problem, testCase, index);
    return {
      ...testCase,
      reviewStatus: result.status,
      reviewNote: [result.reason, ...result.warnings].filter(Boolean).join('；'),
      sampleKind: result.kind,
      reviewedAt: result.checkedAt,
    };
  });
};

/** 整套用例的边界覆盖情况（套件级提示，不影响单条可发布结论） */
export const analyzeCoverage = (problem: Problem): SuiteCoverage => {
  const warnings: string[] = [];
  const valid = problem.testCases.filter(t => t.input.trim());
  const hasEmptyCase = valid.some(t => {
    const kind = inferSampleKind(t.input);
    try {
      if (kind === 'string') return parseQuotedString(t.input) === '';
      if (kind === 'integer-array') return parseIntArray(t.input.split('\n')[0]).length === 0;
      if (kind === 'nested-array') return parseNestedIntArrays(t.input.split('\n')[0]).length === 0;
    } catch {
      /* ignore */
    }
    return false;
  });
  const hasBoundaryCase = valid.some(t => isBoundaryCase(inferSampleKind(t.input), t.input));

  if (valid.length > 0 && !hasEmptyCase) warnings.push('未发现空值样例（如空数组 []、空字符串 ""），建议补充');
  if (valid.length > 0 && !hasBoundaryCase) warnings.push('未发现边界样例（如单元素、空集合），建议补充');
  return { hasEmptyCase, hasBoundaryCase, warnings };
};

export interface PrecheckSummary {
  total: number;
  pending: number;
  passed: number;
  failed: number;
}

export const summarizeProblem = (problem: Problem): PrecheckSummary => {
  const summary: PrecheckSummary = { total: problem.testCases.length, pending: 0, passed: 0, failed: 0 };
  for (const testCase of problem.testCases) {
    summary[getReviewStatus(testCase)]++;
  }
  return summary;
};
