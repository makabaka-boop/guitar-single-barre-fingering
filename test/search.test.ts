import { describe, expect, it } from 'vitest';
import {
  compareShape,
  pcOfMidi,
  searchChords,
  validateInput,
  type ChordResult,
  type ExclusionReason,
} from '../src/search';

/**
 * 参考实现：独立、直白的笛卡尔积全枚举（不剪枝、不共享状态），
 * 搜索核心必须与它在小样本上逐字段对拍。
 * 注意：参考实现刻意放宽了弦数限制（支持 3 弦），仅用于测试。
 */
function referenceSearch(opts: {
  tuning: number[];
  targets: number[];
  maxFret: number;
  minStrings?: number;
  maxFingers?: number;
  maxSpan?: number;
  limit?: number;
}) {
  const { tuning, maxFret } = opts;
  const minStrings = opts.minStrings ?? 3;
  const maxFingers = opts.maxFingers ?? 4;
  const maxSpan = opts.maxSpan ?? 4;
  const limit = opts.limit ?? 20;
  const targetSet = new Set(opts.targets);

  const choices: number[] = [
    -1,
    ...Array.from({ length: maxFret + 1 }, (_, f) => f),
  ];

  let combos: number[][] = [[]];
  for (let s = 0; s < tuning.length; s++) {
    combos = combos.flatMap((prefix) => choices.map((c) => [...prefix, c]));
  }

  const excluded: Record<ExclusionReason, number> = {
    min_strings: 0,
    outside_target: 0,
    cover_target: 0,
    max_fingers: 0,
    span: 0,
  };
  const valid: ChordResult[] = [];

  for (const shape of combos) {
    const ringing = shape.filter((f) => f !== -1);
    if (ringing.length < minStrings) {
      excluded.min_strings++;
      continue;
    }
    const midi = shape.map((f, s) => (f === -1 ? null : tuning[s] + f));
    const pcs = midi.filter((m): m is number => m !== null).map(pcOfMidi);

    if (pcs.some((p) => !targetSet.has(p))) {
      excluded.outside_target++;
      continue;
    }
    if (![...targetSet].every((t) => pcs.includes(t))) {
      excluded.cover_target++;
      continue;
    }

    const pressed = ringing.filter((f) => f > 0);
    const fingers = pressed.length;
    if (fingers > maxFingers) {
      excluded.max_fingers++;
      continue;
    }
    const span = pressed.length === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
    if (span > maxSpan) {
      excluded.span++;
      continue;
    }

    valid.push({
      shape,
      span,
      fretSum: ringing.reduce((a, f) => a + f, 0),
      fingers,
      ringing: ringing.length,
      midi,
    });
  }

  valid.sort((a, b) => {
    if (a.span !== b.span) return a.span - b.span;
    if (a.fretSum !== b.fretSum) return a.fretSum - b.fretSum;
    return compareShape(a.shape, b.shape);
  });

  return {
    results: valid.slice(0, limit),
    total: combos.length,
    valid: valid.length,
    excluded,
    truncated: valid.length > limit,
  };
}

const TUNINGS_3 = {
  /** G-B-E（前三根弦，MIDI 67/71/76），40/44/49 = 低 3 个八度。 */
  gbeHigh: [67, 71, 76],
  gbeLow: [40, 44, 49],
  /** E-A-D（低三根弦 E2/A2/D2） */
  ead: [40, 45, 50],
};

const REASON_KEYS: ExclusionReason[] = [
  'min_strings',
  'outside_target',
  'cover_target',
  'max_fingers',
  'span',
];

describe('三弦小样本全枚举对拍', () => {
  const cases: { tuning: number[]; targets: number[]; maxFret: number }[] = [
    { tuning: TUNINGS_3.gbeHigh, targets: [4, 7, 11], maxFret: 3 }, // E 大三和弦
    { tuning: TUNINGS_3.gbeHigh, targets: [0, 4, 7], maxFret: 5 }, // C
    { tuning: TUNINGS_3.gbeLow, targets: [9, 0, 4], maxFret: 4 }, // A
    { tuning: TUNINGS_3.ead, targets: [2, 6, 9], maxFret: 6 }, // D
    { tuning: TUNINGS_3.gbeHigh, targets: [2, 5, 9], maxFret: 7 }, // Em
    { tuning: TUNINGS_3.gbeLow, targets: [7, 11, 2], maxFret: 9 }, // G，最大品位边界
    { tuning: TUNINGS_3.ead, targets: [0, 3], maxFret: 3 }, // 只有两个目标音级
    { tuning: TUNINGS_3.gbeHigh, targets: [1, 3, 6, 8, 10], maxFret: 4 }, // 五个目标音级（全降号）
  ];

  for (const c of cases) {
    it(`tuning=[${c.tuning}] targets={${c.targets}} maxFret=${c.maxFret}`, () => {
      const got = searchChords({ ...c, minStrings: 1 });
      const want = referenceSearch({ ...c, minStrings: 1 });

      expect(got.total).toBe(want.total);
      expect(got.total).toBe((c.maxFret + 2) ** 3);
      expect(got.valid).toBe(want.valid);
      expect(got.truncated).toBe(want.truncated);
      for (const k of REASON_KEYS) {
        expect(got.excluded[k], `excluded.${k}`).toBe(want.excluded[k]);
      }
      // 所有方案恰好归入「合法」或某一排除原因之一，不漏不重。
      const accounted = got.valid + REASON_KEYS.reduce((a, k) => a + got.excluded[k], 0);
      expect(accounted).toBe(got.total);

      expect(got.results.length).toBe(want.results.length);
      got.results.forEach((r, i) => {
        const w = want.results[i];
        expect(r.shape, `#${i} shape`).toEqual(w.shape);
        expect(r.span, `#${i} span`).toBe(w.span);
        expect(r.fretSum, `#${i} fretSum`).toBe(w.fretSum);
        expect(r.fingers, `#${i} fingers`).toBe(w.fingers);
        expect(r.ringing, `#${i} ringing`).toBe(w.ringing);
        expect(r.midi, `#${i} midi`).toEqual(w.midi);
      });
    });
  }

  it('默认约束（>=3 响弦、<=4 指、跨度<=4）也与参考实现一致', () => {
    const c = { tuning: TUNINGS_3.gbeHigh, targets: [4, 7, 11], maxFret: 5 };
    const got = searchChords(c);
    const want = referenceSearch(c);
    expect({
      results: got.results,
      valid: got.valid,
      excluded: got.excluded,
      truncated: got.truncated,
      total: got.total,
    }).toEqual({
      results: want.results,
      valid: want.valid,
      excluded: want.excluded,
      truncated: want.truncated,
      total: want.total,
    });
  });
});

describe('搜索约束语义', () => {
  it('所有结果都满足响弦 >=3、音级合法且覆盖目标', () => {
    const out = searchChords({ tuning: [64, 60, 64, 59], targets: [7, 11, 2], maxFret: 7 });
    const targetSet = new Set([7, 11, 2]);
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.ringing).toBeGreaterThanOrEqual(3);
      const pcs = r.midi.filter((m): m is number => m !== null).map(pcOfMidi);
      expect(pcs.every((p) => targetSet.has(p))).toBe(true);
      for (const t of targetSet) expect(pcs).toContain(t);
      expect(r.fingers).toBeLessThanOrEqual(4);
      expect(r.span).toBeLessThanOrEqual(4);
    }
  });

  it('排序：跨度升序，其次品位总和，其次向量字典序（闷音在品位之后）', () => {
    const out = searchChords({ tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 9 });
    expect(out.results.length).toBeGreaterThan(1);
    for (let i = 1; i < out.results.length; i++) {
      const a = out.results[i - 1];
      const b = out.results[i];
      // 跨度优先，其次品位总和。
      if (a.span !== b.span) {
        expect(a.span).toBeLessThan(b.span);
      } else if (a.fretSum !== b.fretSum) {
        expect(a.fretSum).toBeLessThan(b.fretSum);
      } else {
        // 前两键相同：形状向量必须非递减。
        expect(compareShape(a.shape, b.shape)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('最多返回 20 个，并报告 truncated；放宽限制可看全量', () => {
    const out = searchChords({ tuning: [40, 45, 50, 55, 59, 64], targets: [0, 4, 7], maxFret: 9 });
    expect(out.results.length).toBeLessThanOrEqual(20);
    expect(out.truncated).toBe(out.valid > 20);
    if (out.truncated) expect(out.results.length).toBe(20);

    const all = searchChords({ tuning: [40, 45, 50, 55, 59, 64], targets: [0, 4, 7], maxFret: 9, limit: 10_000 });
    expect(all.results.length).toBe(all.valid);
    expect(all.truncated).toBe(false);
  });

  it('闷音排在品位之后：同形状把某弦 x 换成 0 品后字典序更靠前', () => {
    expect(compareShape([-1, 0, 0], [0, 0, 0])).toBe(1);
    expect(compareShape([0, -1, 0], [0, 0, 0])).toBe(1);
    expect(compareShape([2, -1], [2, 0])).toBe(1);
    expect(compareShape([2, 3], [2, 4])).toBe(-1);
    expect(compareShape([2, 3], [2, 3])).toBe(0);
  });

  it('无按弦时跨度算 0；开放弦恰好覆盖目标时存在零按弦方案', () => {
    // E2 A2 D3 G3 开放音级 = {4,9,2,7}，恰好为目标：全开放形状合法。
    const out = searchChords({ tuning: [40, 45, 50, 55], targets: [4, 9, 2, 7], maxFret: 5 });
    const allOpen = out.results.find(
      (r) => r.fingers === 0 && r.ringing === 4 && r.shape.every((f) => f === 0),
    );
    expect(allOpen).toBeDefined();
    expect(allOpen!.span).toBe(0);
    expect(allOpen!.fretSum).toBe(0);

    // 含目标音级 C(0) 时开放弦无法覆盖，不存在零按弦方案，
    // 且所有按弦方案跨度按最大最小品位差计算。
    const out2 = searchChords({ tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 5 });
    expect(out2.results.every((r) => r.fingers > 0)).toBe(true);
    for (const r of out2.results) {
      const pressed = r.shape.filter((f): f is number => f > 0);
      expect(r.span).toBe(Math.max(...pressed) - Math.min(...pressed));
    }
  });

  it('排除原因计数完备：合法 + 各排除 = 总枚举数', () => {
    for (const [tuning, maxFret] of [
      [[40, 45, 50, 55], 3],
      [[40, 45, 50, 55, 59, 64], 6],
    ] as const) {
      const out = searchChords({ tuning: [...tuning], targets: [0, 4, 7], maxFret });
      const excludedSum = REASON_KEYS.reduce((a, k) => a + out.excluded[k], 0);
      expect(out.valid + excludedSum).toBe(out.total);
      expect(out.total).toBe((maxFret + 2) ** tuning.length);
    }
  });
});

describe('移调不变性', () => {
  /** 把所有开放弦与目标音级同时平移 k 半音（弦间音程不变）。 */
  const transposeInput = (
    input: { tuning: number[]; targets: number[]; maxFret: number },
    k: number,
  ) => ({
    tuning: input.tuning.map((m) => m + k),
    targets: input.targets.map((t) => (t + k + 1200) % 12),
    maxFret: input.maxFret,
  });

  it('定弦与目标同时移调：同一品位向量的合法性不变，结果逐向量相同', () => {
    const base = { tuning: [40, 45, 50, 55, 59, 64], targets: [4, 7, 11], maxFret: 9 };
    for (const k of [-4, -1, 1, 3, 7, 12]) {
      const a = searchChords({ ...base, limit: 100_000 });
      const b = searchChords({ ...transposeInput(base, k), limit: 100_000 });

      // 品位向量、排序、各项统计全部一致：合法性只取决于「相对开放弦的偏移」。
      expect(b.valid).toBe(a.valid);
      expect(b.total).toBe(a.total);
      expect(b.excluded).toEqual(a.excluded);
      expect(b.results.map((r) => r.shape)).toEqual(a.results.map((r) => r.shape));
      b.results.forEach((rb, i) => {
        const ra = a.results[i];
        expect(rb.span).toBe(ra.span);
        expect(rb.fretSum).toBe(ra.fretSum);
        expect(rb.fingers).toBe(ra.fingers);
        expect(rb.ringing).toBe(ra.ringing);
        // 发出的实际音高整体平移 k 半音（八度也跟着走）。
        expect(rb.midi).toEqual(ra.midi.map((m) => (m === null ? null : m + k)));
      });
    }
  });

  it('不同目标音级集合与品位范围下移调同样保持形状不变', () => {
    for (const base of [
      { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 6 },
      { tuning: [38, 45, 50, 55, 59], targets: [0, 3, 6, 10], maxFret: 4 },
      { tuning: [40, 45, 50, 55, 59, 64], targets: [1, 5, 8], maxFret: 3 },
    ]) {
      const a = searchChords({ ...base, limit: 100_000 });
      const b = searchChords({ ...transposeInput(base, 5), limit: 100_000 });
      expect(b.results.map((r) => r.shape)).toEqual(a.results.map((r) => r.shape));
      // 每个结果发声音级确实是原音级 +k。
      for (const r of b.results) {
        const pcs = r.midi.filter((m): m is number => m !== null).map(pcOfMidi);
        const expected = new Set(base.targets.map((t) => (t + 5) % 12));
        for (const p of pcs) expect(expected.has(p)).toBe(true);
      }
    }
  });
});

describe('输入校验', () => {
  it('接受任务给定范围内的输入', () => {
    expect(
      validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 3 }),
    ).toEqual([]);
    expect(
      validateInput({ tuning: [38, 45, 50, 55, 59, 64], targets: [1, 2], maxFret: 9 }),
    ).toEqual([]);
  });

  it('拒绝越界的弦数、目标音级数与最大品位', () => {
    expect(validateInput({ tuning: [40, 45, 50], targets: [0, 4], maxFret: 5 }).some((i) => i.field === 'tuning')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55, 55, 55, 55], targets: [0, 4], maxFret: 5 }).some((i) => i.field === 'tuning')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0], maxFret: 5 }).some((i) => i.field === 'targets')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 1, 2, 3, 4, 5], maxFret: 5 }).some((i) => i.field === 'targets')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4], maxFret: 2 }).some((i) => i.field === 'maxFret')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4], maxFret: 10 }).some((i) => i.field === 'maxFret')).toBe(true);
  });

  it('目标音级去重后计数；非法 MIDI/音级被拒绝', () => {
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 4, 4, 7], maxFret: 5 })).toEqual([]);
    expect(validateInput({ tuning: [40, 45, 50, 55], targets: [0, 12], maxFret: 5 }).some((i) => i.field === 'targets')).toBe(true);
    expect(validateInput({ tuning: [40, 45, 200, 55], targets: [0, 4], maxFret: 5 }).some((i) => i.field === 'tuning')).toBe(true);
    expect(validateInput({ tuning: [28, 33, 38, 43], targets: [0, 4], maxFret: 5 })).toEqual([]);
  });
});
