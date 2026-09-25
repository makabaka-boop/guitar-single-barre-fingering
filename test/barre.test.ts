import { describe, expect, it } from 'vitest';
import {
  bestFingering,
  compareFingering,
  compareShape,
  evaluateShape,
  pcOfMidi,
  searchChords,
  type ChordResult,
  type ExclusionReason,
  type Fingering,
  type Shape,
} from '../src/search';

/**
 * 独立参考实现：直白地枚举全部横按区间 [from, to] × 横按品位 b，
 * 按规则直接计算手指数（1 + 区间内更高品位弦数 + 区间外非零品位弦数），
 * 最后用 (手指数, 无横按优先, 横按品位, 起止弦下标) 元组取最优。
 * 与被测的 bestFingering 不共享枚举与计数逻辑，用于对拍。
 */
function referenceBestFingering(shape: Shape): Fingering {
  const n = shape.length;
  const pressed = shape.filter((f) => f > 0).length;
  const maxFret = Math.max(0, ...shape);

  const cands: Fingering[] = [{ fingers: pressed, barre: null }];
  for (let b = 1; b <= maxFret; b++) {
    for (let from = 0; from + 1 < n; from++) {
      for (let to = from + 1; to < n; to++) {
        let blocked = false;
        let exact = 0;
        let higher = 0;
        for (let s = from; s <= to; s++) {
          const f = shape[s];
          if (f < b) {
            // 闷音(-1)、空弦(0) 与低于横按品位的弦都阻断区间
            blocked = true;
            break;
          }
          if (f === b) exact++;
          else higher++;
        }
        if (blocked || exact < 2) continue;
        let outside = 0;
        for (let s = 0; s < n; s++) {
          if (s >= from && s <= to) continue;
          if (shape[s] > 0) outside++;
        }
        cands.push({ fingers: 1 + higher + outside, barre: { fret: b, from, to } });
      }
    }
  }

  // 独立的裁决元组：手指数 -> 无横按优先 -> 横按品位 -> 起始弦 -> 终止弦
  const key = (f: Fingering): number[] =>
    f.barre === null
      ? [f.fingers, 0, 0, 0, 0]
      : [f.fingers, 1, f.barre.fret, f.barre.from, f.barre.to];
  cands.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
  return cands[0];
}

/** 笛卡尔积枚举全部 n 弦形状。 */
function* allShapes(n: number, values: number[]): Generator<Shape> {
  if (n === 0) {
    yield [];
    return;
  }
  for (const rest of allShapes(n - 1, values)) {
    for (const v of values) yield [v, ...rest];
  }
}

/** 开启横按模式的独立参考搜索：与 searchChords 不共享任何枚举/计数代码。 */
function referenceSearchBarre(opts: {
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

  const choices = [-1, ...Array.from({ length: maxFret + 1 }, (_, f) => f)];
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
    const fing = referenceBestFingering(shape);
    if (fing.fingers > maxFingers) {
      excluded.max_fingers++;
      continue;
    }
    const pressedFrets = ringing.filter((f) => f > 0);
    const span = pressedFrets.length === 0 ? 0 : Math.max(...pressedFrets) - Math.min(...pressedFrets);
    if (span > maxSpan) {
      excluded.span++;
      continue;
    }
    valid.push({
      shape,
      span,
      fretSum: ringing.reduce((a, f) => a + f, 0),
      fingers: fing.fingers,
      ringing: ringing.length,
      midi,
      barre: fing.barre,
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

const REASON_KEYS: ExclusionReason[] = [
  'min_strings',
  'outside_target',
  'cover_target',
  'max_fingers',
  'span',
];

const STD = [40, 45, 50, 55, 59, 64];

describe('bestFingering：小指板独立枚举横按区间对拍', () => {
  it('4 弦 × {-1,0..4} 全部 1296 个形状与参考实现逐项一致', () => {
    for (const shape of allShapes(4, [-1, 0, 1, 2, 3, 4])) {
      expect(bestFingering(shape), `shape=[${shape}]`).toEqual(referenceBestFingering(shape));
    }
  });

  it('5 弦 × {-1,0..3} 全部 3125 个形状与参考实现逐项一致', () => {
    for (const shape of allShapes(5, [-1, 0, 1, 2, 3])) {
      expect(bestFingering(shape), `shape=[${shape}]`).toEqual(referenceBestFingering(shape));
    }
  });

  it('最优指法手指数永不超过无横按的朴素手指数', () => {
    for (const shape of allShapes(4, [-1, 0, 1, 2, 3])) {
      const naive = shape.filter((f) => f > 0).length;
      expect(bestFingering(shape).fingers).toBeLessThanOrEqual(naive);
    }
  });
});

describe('bestFingering：无横按兼容', () => {
  it('没有两根弦同品位时不存在横按，回退为朴素手指数', () => {
    expect(bestFingering([1, 2, 3, 4])).toEqual({ fingers: 4, barre: null });
    expect(bestFingering([0, 1, 2, 3])).toEqual({ fingers: 3, barre: null });
    expect(bestFingering([2, -1, 3, 0])).toEqual({ fingers: 2, barre: null });
  });

  it('无按弦 / 全闷音形状手指数为 0 且无横按', () => {
    expect(bestFingering([0, 0, 0])).toEqual({ fingers: 0, barre: null });
    expect(bestFingering([-1, -1, -1, -1])).toEqual({ fingers: 0, barre: null });
    expect(bestFingering([0, -1, 0])).toEqual({ fingers: 0, barre: null });
  });

  it('同品位弦被闷音隔开时，同侧两根弦仍可横按', () => {
    expect(bestFingering([-1, -1, 3, 3])).toEqual({
      fingers: 1,
      barre: { fret: 3, from: 2, to: 3 },
    });
    expect(bestFingering([0, 0, 2, 2])).toEqual({
      fingers: 1,
      barre: { fret: 2, from: 2, to: 3 },
    });
  });
});

describe('bestFingering：闷音 / 空弦 / 更低品位阻断横按区间', () => {
  it('区间内的闷音阻断横按，横按只能取一侧', () => {
    expect(bestFingering([2, 2, -1, 2, 2])).toEqual({
      fingers: 3,
      barre: { fret: 2, from: 0, to: 1 },
    });
  });

  it('区间内的空弦阻断横按', () => {
    expect(bestFingering([2, 2, 0, 2, 2])).toEqual({
      fingers: 3,
      barre: { fret: 2, from: 0, to: 1 },
    });
  });

  it('区间内低于横按品位的弦阻断横按', () => {
    expect(bestFingering([2, 2, 1, 2, 2])).toEqual({
      fingers: 4,
      barre: { fret: 2, from: 0, to: 1 },
    });
  });

  it('区间内高于横按品位的弦不阻断，但另占一根手指', () => {
    // 横按 2 品盖 0/1/3/4 弦，2 弦的 3 品另用一指
    expect(bestFingering([2, 2, 3, 2, 2])).toEqual({
      fingers: 2,
      barre: { fret: 2, from: 0, to: 4 },
    });
  });
});

describe('bestFingering：并列指法裁决', () => {
  it('compareFingering：手指数少者优；并列时无横按优先', () => {
    const noBarre: Fingering = { fingers: 2, barre: null };
    const withBarre: Fingering = { fingers: 2, barre: { fret: 2, from: 0, to: 1 } };
    expect(compareFingering({ fingers: 1, barre: null }, withBarre)).toBeLessThan(0);
    expect(compareFingering(noBarre, withBarre)).toBeLessThan(0);
    expect(compareFingering(withBarre, noBarre)).toBeGreaterThan(0);
    expect(compareFingering(noBarre, { fingers: 2, barre: null })).toBe(0);
  });

  it('compareFingering：横按之间按 (品位, 起始弦, 终止弦) 升序', () => {
    const mk = (fret: number, from: number, to: number): Fingering => ({
      fingers: 3,
      barre: { fret, from, to },
    });
    expect(compareFingering(mk(2, 3, 4), mk(3, 0, 1))).toBeLessThan(0); // 品位小优先
    expect(compareFingering(mk(2, 0, 3), mk(2, 1, 2))).toBeLessThan(0); // 起始弦小优先
    expect(compareFingering(mk(2, 0, 1), mk(2, 0, 2))).toBeLessThan(0); // 终止弦小优先
  });

  it('手指数并列时取更小的横按品位', () => {
    // 横按 2 品（弦 1–4，3 品的弦 1–2 另用手指）与横按 3 品（弦 1–2）都是 3 指，取 2 品
    expect(bestFingering([3, 3, 2, 2])).toEqual({
      fingers: 3,
      barre: { fret: 2, from: 0, to: 3 },
    });
  });

  it('横按品位并列时取更小的起始弦下标', () => {
    // [0,2] 与 [1,2] 都是 2 指，取 from=0
    expect(bestFingering([3, 2, 2])).toEqual({
      fingers: 2,
      barre: { fret: 2, from: 0, to: 2 },
    });
  });

  it('起止弦并列时取更小的终止弦下标', () => {
    // [0,1] 与 [0,3] 都是 3 指，取 to=1
    expect(bestFingering([2, 2, 3, 3])).toEqual({
      fingers: 3,
      barre: { fret: 2, from: 0, to: 1 },
    });
  });
});

describe('搜索：默认关闭横按模式时逐项不变', () => {
  it('barre 缺省与 barre:false 的输出完全一致，且结果不带 barre 字段', () => {
    for (const input of [
      { tuning: STD, targets: [0, 4, 7], maxFret: 5 },
      { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 6 },
      { tuning: [67, 71, 76], targets: [4, 7, 11], maxFret: 3, minStrings: 1 },
    ]) {
      const a = searchChords(input);
      const b = searchChords({ ...input, barre: false });
      expect(b).toEqual(a);
      for (const r of a.results) expect('barre' in r).toBe(false);
    }
  });

  it('evaluateShape 默认模式：手指数为朴素计数，barre 为 null', () => {
    const ev = evaluateShape([2, 2, 2, 2], [40, 45, 50, 55], [0, 4, 7]);
    expect(ev.fingers).toBe(4);
    expect(ev.barre).toBeNull();
  });
});

describe('搜索：开启横按模式后与小指板参考实现全量对拍', () => {
  const cases: {
    tuning: number[];
    targets: number[];
    maxFret: number;
    minStrings?: number;
  }[] = [
    { tuning: [40, 45, 50], targets: [0, 4, 7], maxFret: 4, minStrings: 1 },
    { tuning: [67, 71, 76], targets: [4, 7, 11], maxFret: 3 },
    { tuning: [40, 44, 49], targets: [9, 0, 4], maxFret: 4, minStrings: 2 },
    { tuning: [40, 45, 50, 55], targets: [2, 6, 9], maxFret: 3, minStrings: 2 },
    { tuning: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 4 },
  ];

  for (const c of cases) {
    it(`tuning=[${c.tuning}] targets={${c.targets}} maxFret=${c.maxFret}`, () => {
      const got = searchChords({ ...c, barre: true });
      const want = referenceSearchBarre(c);

      expect(got.total).toBe(want.total);
      expect(got.valid).toBe(want.valid);
      expect(got.truncated).toBe(want.truncated);
      for (const k of REASON_KEYS) {
        expect(got.excluded[k], `excluded.${k}`).toBe(want.excluded[k]);
      }
      const accounted = got.valid + REASON_KEYS.reduce((a, k) => a + got.excluded[k], 0);
      expect(accounted).toBe(got.total);

      expect(got.results.length).toBe(want.results.length);
      got.results.forEach((r, i) => {
        const w = want.results[i];
        expect(r.shape, `#${i} shape`).toEqual(w.shape);
        expect(r.fingers, `#${i} fingers`).toBe(w.fingers);
        expect(r.barre ?? null, `#${i} barre`).toEqual(w.barre);
        expect(r.span, `#${i} span`).toBe(w.span);
        expect(r.fretSum, `#${i} fretSum`).toBe(w.fretSum);
        expect(r.ringing, `#${i} ringing`).toBe(w.ringing);
        expect(r.midi, `#${i} midi`).toEqual(w.midi);
      });
    });
  }
});

describe('搜索：横按模式的语义', () => {
  const input = { tuning: STD, targets: [0, 4, 7], maxFret: 5 };

  it('原本超指的横按形状 x35553 在开启后合法，且三处结论一致', () => {
    const shape = [-1, 3, 5, 5, 5, 3];

    // 默认模式：5 根手指，被 max_fingers 排除
    const evOff = evaluateShape(shape, STD, [0, 4, 7]);
    expect(evOff.valid).toBe(false);
    expect(evOff.reason).toBe('max_fingers');
    expect(evOff.fingers).toBe(5);

    // 横按模式：横按 5 品（弦 3–5）+ 弦 2/6 各一指，共 3 指
    const conclusion: Fingering = { fingers: 3, barre: { fret: 5, from: 2, to: 4 } };
    expect(bestFingering(shape)).toEqual(conclusion);

    const evOn = evaluateShape(shape, STD, [0, 4, 7], { barre: true });
    expect(evOn.valid).toBe(true);
    expect(evOn.fingers).toBe(conclusion.fingers);
    expect(evOn.barre).toEqual(conclusion.barre);

    // 搜索结果中的同一形状携带同一指法结论；默认模式搜索结果不包含它
    const off = searchChords({ ...input, limit: 100_000 });
    expect(off.results.some((r) => r.shape.join() === shape.join())).toBe(false);
    const on = searchChords({ ...input, barre: true, limit: 100_000 });
    const hit = on.results.find((r) => r.shape.join() === shape.join());
    expect(hit).toBeDefined();
    expect(hit!.fingers).toBe(conclusion.fingers);
    expect(hit!.barre).toEqual(conclusion.barre);
  });

  it('排除计数：前三个桶不变，max_fingers 下降，总计数仍完备', () => {
    const off = searchChords({ ...input, limit: 100_000 });
    const on = searchChords({ ...input, barre: true, limit: 100_000 });

    expect(on.total).toBe(off.total);
    expect(on.valid).toBeGreaterThan(off.valid);
    expect(on.excluded.min_strings).toBe(off.excluded.min_strings);
    expect(on.excluded.outside_target).toBe(off.excluded.outside_target);
    expect(on.excluded.cover_target).toBe(off.excluded.cover_target);
    expect(on.excluded.max_fingers).toBeLessThan(off.excluded.max_fingers);
    // 新通过手指检查的形状可能落入 span 桶
    expect(on.excluded.span).toBeGreaterThanOrEqual(off.excluded.span);
    for (const out of [off, on]) {
      const sum = out.valid + REASON_KEYS.reduce((a, k) => a + out.excluded[k], 0);
      expect(sum).toBe(out.total);
    }
  });

  it('排序键不变、形状不重复、共有形状相对顺序保持', () => {
    const off = searchChords({ ...input, limit: 100_000 });
    const on = searchChords({ ...input, barre: true, limit: 100_000 });

    // 排序仍按 跨度 -> 品位总和 -> 形状向量字典序
    for (let i = 1; i < on.results.length; i++) {
      const a = on.results[i - 1];
      const b = on.results[i];
      if (a.span !== b.span) expect(a.span).toBeLessThan(b.span);
      else if (a.fretSum !== b.fretSum) expect(a.fretSum).toBeLessThan(b.fretSum);
      else expect(compareShape(a.shape, b.shape)).toBeLessThan(0);
    }

    // 同一形状不因多种指法重复出现
    const keys = on.results.map((r) => r.shape.join(','));
    expect(new Set(keys).size).toBe(keys.length);

    // 两种模式都合法的形状，相对顺序完全一致（排序键不含手指数）
    const offKeys = off.results.map((r) => r.shape.join(','));
    const offSet = new Set(offKeys);
    expect(keys.filter((k) => offSet.has(k))).toEqual(offKeys);
  });

  it('每个结果都携带与 bestFingering/evaluateShape 一致的合法指法结论', () => {
    const on = searchChords({ ...input, barre: true, limit: 100_000 });
    expect(on.results.length).toBeGreaterThan(0);
    for (const r of on.results) {
      expect(r.fingers).toBeLessThanOrEqual(4);
      expect(bestFingering(r.shape)).toEqual({ fingers: r.fingers, barre: r.barre ?? null });
      const ev = evaluateShape(r.shape, STD, [0, 4, 7], { barre: true });
      expect(ev.valid).toBe(true);
      expect(ev.fingers).toBe(r.fingers);
      expect(ev.barre).toEqual(r.barre ?? null);
      if (r.barre) {
        // 横按区间合法：无闷音/空弦/更低品位，且至少两弦恰为横按品位
        const seg = r.shape.slice(r.barre.from, r.barre.to + 1);
        expect(seg.every((f) => f >= r.barre!.fret)).toBe(true);
        expect(seg.filter((f) => f === r.barre!.fret).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('自定义形状解释与搜索共用同一指法结论（逐形状对拍）', () => {
    const tuning = [40, 45, 50, 55];
    for (const shape of allShapes(4, [-1, 0, 1, 2, 3])) {
      const ev = evaluateShape(shape, tuning, [0, 4, 7], { barre: true });
      const want = bestFingering(shape);
      expect(ev.fingers, `shape=[${shape}]`).toBe(want.fingers);
      expect(ev.barre, `shape=[${shape}]`).toEqual(want.barre);
    }
  });
});
