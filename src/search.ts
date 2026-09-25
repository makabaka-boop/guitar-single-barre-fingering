/**
 * 离线指板和弦形状搜索引擎（纯 TypeScript，无运行时依赖）。
 *
 * 输入 n 根弦的开放弦 MIDI 音高（顺序：低音弦 -> 高音弦）、
 * 一组目标音级（pitch class, 0..11）与最大品位，
 * 枚举每根弦「闷音(x) 或 0..maxFret 品位」的全部组合，
 * 筛出可弹奏且音级集合恰好合法的方案，并按
 *   跨度 -> 品位总和 -> 形状向量字典序（闷音排在品位之后）
 * 排序，只保留前 20 个。
 */

/** 一根弦的取值：-1 表示闷音(x)，0..maxFret 表示该弦所按品位。 */
export type Fret = number;

/** 一个和弦形状：与开放弦数组等长、自低音弦向高音弦排列的品位向量。 */
export type Shape = Fret[];

/** 枚举失败时的排除原因（同一方案命中多条时，按枚举顺序只记第一条）。 */
export type ExclusionReason =
  | 'min_strings'
  | 'outside_target'
  | 'cover_target'
  | 'max_fingers'
  | 'span';

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  'min_strings',
  'outside_target',
  'cover_target',
  'max_fingers',
  'span',
];

export interface SearchInput {
  /** 各弦开放弦 MIDI 音高，低音弦在前、高音弦在后。 */
  tuning: number[];
  /** 目标音级（0=C .. 11=B），内部会去重。 */
  targets: number[];
  /** 最大品位（含），取值 3..9。 */
  maxFret: number;
  /** 至少需要弹响的弦数，默认 3。 */
  minStrings?: number;
  /** 最多可用手指数（按下的非零品位弦数，不计横按），默认 4。 */
  maxFingers?: number;
  /** 允许的非零品位最大最小差，默认 4；没有按弦时跨度算 0。 */
  maxSpan?: number;
  /** 返回结果上限，默认 20。 */
  limit?: number;
}

export interface ChordResult {
  /** 品位向量（-1 = 闷音），与 tuning 等长。 */
  shape: Shape;
  /** 非零品位的最大最小差；无按弦时为 0。 */
  span: number;
  /** 品位总和（闷音与 0 品均按 0 计）。 */
  fretSum: number;
  /** 按弦手指数（非零品位的弦数，不计横按）。 */
  fingers: number;
  /** 弹响弦数。 */
  ringing: number;
  /** 各弹响弦实际发出的 MIDI 音高（闷音弦对应位置为 null）。 */
  midi: (number | null)[];
}

export interface SearchOutput {
  results: ChordResult[];
  /** 枚举到的全部方案数（(maxFret+2)^n）。 */
  total: number;
  /** 合法方案总数（截断之前）。 */
  valid: number;
  /** 各排除原因对应的方案数。合法方案不在任何一类中。 */
  excluded: Record<ExclusionReason, number>;
  /** 合法方案是否超过 limit（即返回结果被截断）。 */
  truncated: boolean;
}

export interface ValidationIssue {
  field: 'tuning' | 'targets' | 'maxFret' | 'minStrings' | 'maxFingers' | 'maxSpan' | 'limit';
  message: string;
}

const PC_NAMES_SHARP = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

/** 常见降号音名（其余回退到升号名）。 */
const FLAT_NAMES: Record<number, string> = { 1: 'Db', 3: 'Eb', 6: 'Gb', 8: 'Ab', 10: 'Bb' };

export function pcName(pc: number, preferFlat = false): string {
  const p = ((pc % 12) + 12) % 12;
  return preferFlat && FLAT_NAMES[p] !== undefined ? FLAT_NAMES[p] : PC_NAMES_SHARP[p];
}

export function pcOfMidi(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** MIDI -> 音名 + 八度，例如 64 -> E4（MIDI 60 = C4）。 */
export function midiName(midi: number, preferFlat = false): string {
  return `${pcName(pcOfMidi(midi), preferFlat)}${Math.floor(midi / 12) - 1}`;
}

/** 供页面使用的输入校验（4..6 弦、2..5 个目标音级、3..9 品等任务给定范围）。 */
export function validateInput(input: SearchInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tuning = input.tuning;

  if (!Array.isArray(tuning) || tuning.length < 4 || tuning.length > 6) {
    issues.push({ field: 'tuning', message: '开放弦数量必须为 4 至 6 根' });
  } else if (!tuning.every((m) => Number.isInteger(m) && m >= 21 && m <= 108)) {
    issues.push({ field: 'tuning', message: '每根开放弦必须是 21..108 之间的整数 MIDI 音高（约 A0..C8）' });
  }

  const targets = Array.from(new Set(input.targets ?? []));
  if (targets.some((t) => !Number.isInteger(t) || t < 0 || t > 11)) {
    issues.push({ field: 'targets', message: '目标音级必须是 0..11 的整数' });
  } else if (targets.length < 2 || targets.length > 5) {
    issues.push({ field: 'targets', message: '目标音级数量必须为 2 至 5 个不同音级' });
  }

  if (!Number.isInteger(input.maxFret) || input.maxFret < 3 || input.maxFret > 9) {
    issues.push({ field: 'maxFret', message: '最大品位必须为 3 至 9 的整数' });
  }

  const minStrings = input.minStrings ?? 3;
  if (!Number.isInteger(minStrings) || minStrings < 1) {
    issues.push({ field: 'minStrings', message: '最少弹响弦数必须为正整数' });
  } else if (tuning.length >= 4 && tuning.length <= 6 && minStrings > tuning.length) {
    issues.push({ field: 'minStrings', message: '最少弹响弦数不能超过总弦数' });
  }

  const maxFingers = input.maxFingers ?? 4;
  if (!Number.isInteger(maxFingers) || maxFingers < 1) {
    issues.push({ field: 'maxFingers', message: '最大手指数必须为正整数' });
  }

  const maxSpan = input.maxSpan ?? 4;
  if (!Number.isInteger(maxSpan) || maxSpan < 0) {
    issues.push({ field: 'maxSpan', message: '最大跨度必须为非负整数' });
  }

  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    issues.push({ field: 'limit', message: '结果上限必须为正整数' });
  }

  return issues;
}

/**
 * 搜索核心自身的最小 sanity 校验：枚举器对任意弦数都成立，
 * 页面的 4..6 弦 / 2..5 音级 / 3..9 品范围由 validateInput 与 UI 保证，
 * 这样测试才能用三弦小样本做全枚举对拍。
 */
function validateSearchParams(rawInput: SearchInput): void {
  const tuning = rawInput.tuning;
  if (!Array.isArray(tuning) || tuning.length < 1 || tuning.length > 12) {
    throw new Error('tuning 必须为 1..12 根弦的数组');
  }
  if (!tuning.every((m) => Number.isInteger(m) && m >= 0 && m <= 127)) {
    throw new Error('开放弦必须是 0..127 的整数 MIDI 音高');
  }
  const targets = Array.from(new Set(rawInput.targets ?? []));
  if (targets.length < 1 || targets.some((t) => !Number.isInteger(t) || t < 0 || t > 11)) {
    throw new Error('targets 必须是 0..11 的非空整数数组');
  }
  if (!Number.isInteger(rawInput.maxFret) || rawInput.maxFret < 1 || rawInput.maxFret > 24) {
    throw new Error('maxFret 必须为 1..24 的整数');
  }
  const minStrings = rawInput.minStrings ?? 3;
  if (!Number.isInteger(minStrings) || minStrings < 1 || minStrings > tuning.length) {
    throw new Error('minStrings 必须为 1..弦数 的整数');
  }
  const maxFingers = rawInput.maxFingers ?? 4;
  if (!Number.isInteger(maxFingers) || maxFingers < 0) throw new Error('maxFingers 必须为非负整数');
  const maxSpan = rawInput.maxSpan ?? 4;
  if (!Number.isInteger(maxSpan) || maxSpan < 0) throw new Error('maxSpan 必须为非负整数');
  const limit = rawInput.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须为正整数');
}

function emptyExcluded(): Record<ExclusionReason, number> {
  return { min_strings: 0, outside_target: 0, cover_target: 0, max_fingers: 0, span: 0 };
}

/**
 * 形状向量字典序：逐弦比较，闷音(-1)排在所有品位之后；
 * 即同位置品位数字越小越靠前，品位在闷音之前。
 */
export function compareShape(a: Shape, b: Shape): number {
  for (let i = 0; i < a.length; i++) {
    // -1 映射到 +Infinity：任意有限品位都排在闷音前。
    const av = a[i] === -1 ? Number.POSITIVE_INFINITY : a[i];
    const bv = b[i] === -1 ? Number.POSITIVE_INFINITY : b[i];
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function compareResults(a: ChordResult, b: ChordResult): number {
  if (a.span !== b.span) return a.span - b.span;
  if (a.fretSum !== b.fretSum) return a.fretSum - b.fretSum;
  return compareShape(a.shape, b.shape);
}

export interface ShapeEvaluation {
  valid: boolean;
  /** 第一条失败的规则；valid 时为 null。与 searchChords 的排除桶一一对应。 */
  reason: ExclusionReason | null;
  ringing: number;
  fingers: number;
  span: number;
  fretSum: number;
  /** 各弹响弦的音级；闷音弦位置为 null。 */
  pcs: (number | null)[];
  midi: (number | null)[];
  /** 实际出现的音级集合。 */
  presentPcs: number[];
  /** 目标中未被覆盖的音级。 */
  missingPcs: number[];
  /** 弹响但不属于目标的音级（去重）。 */
  outsidePcs: number[];
}

/** 与全枚举相同的规则与优先级，评估单个形状（供页面解释排除原因）。 */
export function evaluateShape(
  shape: Shape,
  tuning: number[],
  targets: number[],
  opts: { minStrings?: number; maxFingers?: number; maxSpan?: number } = {},
): ShapeEvaluation {
  if (shape.length !== tuning.length) throw new Error('形状长度必须与弦数一致');
  const minStrings = opts.minStrings ?? 3;
  const maxFingers = opts.maxFingers ?? 4;
  const maxSpan = opts.maxSpan ?? 4;
  const targetSet = new Set(targets);

  const ringing = shape.filter((f) => f !== -1).length;
  const midi = shape.map((f, s) => (f === -1 ? null : tuning[s] + f));
  const pcs = midi.map((m) => (m === null ? null : pcOfMidi(m)));
  const presentPcs = Array.from(new Set(pcs.filter((p): p is number => p !== null))).sort((a, b) => a - b);
  const outsidePcs = presentPcs.filter((p) => !targetSet.has(p));
  const missingPcs = targets.filter((t) => !presentPcs.includes(t));

  const pressed = shape.filter((f): f is number => f > 0);
  const fingers = pressed.length;
  const span = fingers === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
  const fretSum = shape.reduce((a, f) => a + (f === -1 ? 0 : f), 0);

  let reason: ExclusionReason | null = null;
  if (ringing < minStrings) reason = 'min_strings';
  else if (outsidePcs.length > 0) reason = 'outside_target';
  else if (missingPcs.length > 0) reason = 'cover_target';
  else if (fingers > maxFingers) reason = 'max_fingers';
  else if (span > maxSpan) reason = 'span';

  return {
    valid: reason === null,
    reason,
    ringing,
    fingers,
    span,
    fretSum,
    pcs,
    midi,
    presentPcs,
    missingPcs,
    outsidePcs,
  };
}

export const REASON_LABELS: Record<ExclusionReason, string> = {
  min_strings: '弹响弦不足 3 根',
  outside_target: '出现了目标之外的音级',
  cover_target: '未覆盖全部目标音级',
  max_fingers: '按弦手指数超过 4 根',
  span: '按弦品位跨度超过 4',
};

export const REASON_DESCRIPTIONS: Record<ExclusionReason, string> = {
  min_strings: '至少需要弹响 3 根弦（闷音 x 不计）。',
  outside_target: '弹响弦发出的所有音级必须来自目标集合。',
  cover_target: '弹响弦的音级集合必须包含每一个目标音级。',
  max_fingers: '每根按下的非零品位弦算一根手指（不计横按），最多 4 根。',
  span: '非零品位的最大值减最小值不得超过 4；没有按弦时跨度为 0。',
};

/**
 * 全枚举搜索。n 根弦、每根 (maxFret+2) 种取值，
 * 6 弦 9 品时约 177 万个叶节点，单次亚秒级完成。
 */
export function searchChords(rawInput: SearchInput): SearchOutput {
  validateSearchParams(rawInput);

  const tuning = rawInput.tuning;
  const n = tuning.length;
  const targetSet = Array.from(new Set(rawInput.targets));
  const maxFret = rawInput.maxFret;
  const minStrings = rawInput.minStrings ?? 3;
  const maxFingers = rawInput.maxFingers ?? 4;
  const maxSpan = rawInput.maxSpan ?? 4;
  const limit = rawInput.limit ?? 20;

  // 目标音级位图，便于子集判断。
  let targetMask = 0;
  for (const t of targetSet) targetMask |= 1 << t;

  // table[string][fret+1] = 该弦取该值时发声的音级；闷音(索引0)给 -1。
  const table: Int8Array[] = [];
  for (let s = 0; s < n; s++) {
    const col = new Int8Array(maxFret + 2);
    col[0] = -1;
    for (let f = 0; f <= maxFret; f++) {
      col[f + 1] = pcOfMidi(tuning[s] + f);
    }
    table.push(col);
  }

  const excluded = emptyExcluded();
  const valid: ChordResult[] = [];
  const shape: Shape = new Array<number>(n).fill(-1);

  const dfs = (s: number, mask: number, ringing: number) => {
    if (s === n) {
      if (ringing < minStrings) {
        excluded.min_strings++;
        return;
      }
      if (mask & ~targetMask) {
        excluded.outside_target++;
        return;
      }
      if ((mask & targetMask) !== targetMask) {
        // 弹响弦全部来自目标，但未覆盖全部目标音级。
        excluded.cover_target++;
        return;
      }

      let fingers = 0;
      let fretSum = 0;
      let minPressed = Number.POSITIVE_INFINITY;
      let maxPressed = -1;
      const midi: (number | null)[] = new Array<null | number>(n).fill(null);
      for (let i = 0; i < n; i++) {
        const f = shape[i];
        if (f === -1) continue;
        if (f > 0) {
          fingers++;
          if (f < minPressed) minPressed = f;
          if (f > maxPressed) maxPressed = f;
        }
        fretSum += f;
        midi[i] = tuning[i] + f;
      }

      if (fingers > maxFingers) {
        excluded.max_fingers++;
        return;
      }
      // 无按弦时 minPressed 仍为 Infinity，跨度算 0。
      const span = fingers === 0 ? 0 : maxPressed - minPressed;
      if (span > maxSpan) {
        excluded.span++;
        return;
      }

      valid.push({ shape: shape.slice(), span, fretSum, fingers, ringing, midi });
      return;
    }

    const col = table[s];
    // 取值顺序 0..maxFret 然后闷音；结果最终会显式排序，此处顺序不影响输出。
    for (let idx = 1; idx < col.length; idx++) {
      const f = idx - 1;
      shape[s] = f;
      dfs(s + 1, mask | (1 << col[idx]), ringing + 1);
    }
    shape[s] = -1;
    dfs(s + 1, mask, ringing);
  };

  dfs(0, 0, 0);

  valid.sort(compareResults);
  const total = (maxFret + 2) ** n;
  const validCount = valid.length;
  const truncated = validCount > limit;
  return {
    results: truncated ? valid.slice(0, limit) : valid,
    total,
    valid: validCount,
    excluded,
    truncated,
  };
}
