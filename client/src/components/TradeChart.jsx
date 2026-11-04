import { useEffect, useMemo, useRef, useState } from 'react';
import { api, money } from '../api.js';
import { analyze } from '../lib/chartAnalysis.js';
import {
  DRAW_COLORS, FIB_LEVELS, NOTE_MAX, TOOLS, alertHit, distToSegment, indexAtTime, loadDrawings, measure, newId, saveDrawings, timeAtIndex,
} from '../lib/drawings.js';
import { BACKGROUND, GRID, INDICATOR_STYLES, TEXT, TEXT_STRONG, paletteFor, PALETTES } from '../lib/palette.js';
import {
  EMA_PERIODS, INDICATOR_KEYS, SMA_PERIODS, TIMEFRAMES, candlesQuery, loadPrefs, savePrefs,
} from '../lib/chartPrefs.js';
import { extent, indexAt, seriesPath } from '../lib/chartMath.js';

const POLL_MS = 3000;
const PAD = { top: 12, right: 76, bottom: 24, left: 8 };
const SUB_H = 90; // height of each RSI / MACD panel
const GAP = 14;
const LABELS = { volume: 'Volume', sma: 'SMA', ema: 'EMA', bb: 'Bollinger', rsi: 'RSI', macd: 'MACD' };

const fmtTime = (t, tf) => {
  const d = new Date(t);
  return tf === '1H' || tf === '1D'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
// A closed shape between two series, over the candles where both have values.
const bandPath = (upper, lower, xOf, yOf) => {
  const idx = upper.map((_, i) => i).filter((i) => upper[i] !== null && lower[i] !== null);
  if (!idx.length) return '';
  const pts = [...idx.map((i) => [i, upper[i]]), ...idx.reverse().map((i) => [i, lower[i]])];
  return `${pts.map(([i, v], n) => `${n ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')} Z`;
};
const compact = (v) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(v);
const num = (v) => (typeof v === 'number' ? v.toFixed(2) : '–');

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const Chip = ({ on, onClick, children, ...rest }) => (
  <button type="button" onClick={onClick} aria-pressed={on} {...rest}
    className={`rounded-md px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 ${on ? 'bg-slate-200 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
    {children}
  </button>
);

export default function TradeChart({ symbol, height = 340, onPrice }) {
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [full, setFull] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [hover, setHover] = useState(null);
  const [wrapRef, width] = useWidth();
  const [winH, setWinH] = useState(() => window.innerHeight);
  const onPriceRef = useRef(onPrice);
  onPriceRef.current = onPrice;
  const svgRef = useRef(null);
  const drag = useRef(null);
  const [tool, setTool] = useState('select');
  const [drawings, setDrawings] = useState(() => loadDrawings(symbol, loadPrefs().tf));
  const [draft, setDraft] = useState(null); // a drawing waiting for its second point
  const [selected, setSelected] = useState(null);
  const [cursor, setCursor] = useState(null); // pointer position in SVG pixels
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [showLevels, setShowLevels] = useState(false);

  const { tf, mode, indicators: on } = prefs;
  const colors = paletteFor(prefs.palette);
  const update = (patch) => setPrefs((p) => ({ ...p, ...patch }));
  const toggle = (k) => setPrefs((p) => ({ ...p, indicators: { ...p.indicators, [k]: !p.indicators[k] } }));
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  const query = candlesQuery(prefs);
  useEffect(() => {
    let live = true;
    setData(null);
    const load = () =>
      api(`/markets/${symbol}/candles?${query}`)
        .then((d) => {
          if (!live) return;
          setData(d);
          setError('');
          onPriceRef.current?.(d.price);
        })
        .catch((e) => live && setError(e.message));
    load();
    const id = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [symbol, query]);

  // Drawings belong to a symbol and timeframe.
  useEffect(() => {
    setDrawings(loadDrawings(symbol, tf));
    setDraft(null);
    setSelected(null);
  }, [symbol, tf]);

  const commit = (next) => { setDrawings(next); saveDrawings(symbol, tf, next); };
  const removeSelected = () => { if (selected) { commit(drawings.filter((d) => d.id !== selected)); setSelected(null); } };
  const pickTool = (key) => { setTool(key); setDraft(null); if (key !== 'select') setSelected(null); };

  // Delete removes the selected drawing; Escape cancels a drawing in progress.
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeSelected(); }
      if (e.key === 'Escape' && (draft || tool !== 'select')) { setDraft(null); setTool('select'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Full screen: Escape closes it, and the page behind stops scrolling.
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => e.key === 'Escape' && setFull(false);
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.body.style.overflow = prev;
    };
  }, [full]);

  const candles = data?.candles ?? [];
  const ind = data?.indicators ?? {};
  const rsi = on.rsi ? ind.rsi : null;
  const macd = on.macd ? ind.macd : null;
  const subs = [rsi && 'rsi', macd && 'macd'].filter(Boolean);
  const analysis = useMemo(
    () => analyze(candles, { rsi, macd, sma: on.sma ? ind.sma : null, ema: on.ema ? ind.ema : null, bollinger: on.bb ? ind.bollinger : null }),
    [data, prefs], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const totalH = full ? Math.max(320, winH - 190) : height + subs.length * (SUB_H + GAP);
  const priceH = totalH - subs.length * (SUB_H + GAP);
  const plotW = width - PAD.left - PAD.right;
  const plotH = priceH - PAD.top - PAD.bottom;
  const step = candles.length ? plotW / candles.length : 1;
  const x = (i) => PAD.left + step * (i + 0.5);

  const sma = on.sma ? ind.sma : null;
  const ema = on.ema ? ind.ema : null;
  const bb = on.bb ? ind.bollinger : null;
  const range = extent(candles.map((c) => c.low), candles.map((c) => c.high), sma?.values, ema?.values, bb?.upper, bb?.lower) ?? [0, 1];
  const span = range[1] - range[0] || 1;
  const min = range[0] - span * 0.05 - (on.volume ? span * 0.2 : 0); // leave the bottom fifth for volume bars
  const max = range[1] + span * 0.05;
  const y = (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;
  const maxVol = Math.max(...candles.map((c) => c.volume ?? 0), 1);
  const volH = plotH * 0.16;

  const last = candles[candles.length - 1];
  const first = candles[0];
  const shown = hover != null ? candles[hover] : last;
  const gridValues = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
  const xLabels = candles.length
    ? (width < 520 ? [0, 0.5, 1] : [0, 0.33, 0.66, 1]).map((f) => Math.min(candles.length - 1, Math.round(f * (candles.length - 1))))
    : [];
  const up = last && first ? last.close >= first.open : true;
  const trend = up ? colors.up : colors.down;

  const plotBottom = PAD.top + plotH;
  const plotRight = width - PAD.right;
  const svgPoint = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * width, py: ((e.clientY - r.top) / r.height) * totalH };
  };
  const inPlot = ({ px, py }) => px >= PAD.left && px <= plotRight && py >= PAD.top && py <= plotBottom;
  const toData = ({ px, py }) => ({
    t: Math.round(timeAtIndex(candles, (px - PAD.left) / step - 0.5)),
    price: min + ((max - min) * (plotBottom - py)) / plotH,
  });
  const toPx = (p) => ({ x: x(indexAtTime(candles, p.t)), y: y(p.price) });

  // Straight pieces of a drawing in pixels, for picking it with the pointer.
  const segmentsOf = (d) => {
    const [a, b] = d.points.map(toPx);
    if (d.type === 'hline' || d.type === 'alert') return [[PAD.left, a.y, plotRight, a.y]];
    if (d.type === 'note') return [[a.x - 4, a.y, a.x + 24 + (d.text?.length ?? 4) * 6.2, a.y]];
    if (d.type === 'trend') return [[a.x, a.y, b.x, b.y]];
    if (d.type === 'fib') return FIB_LEVELS.map((l) => { const yy = y(d.points[0].price + (d.points[1].price - d.points[0].price) * l); return [Math.min(a.x, b.x), yy, plotRight, yy]; });
    const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]];
  };
  const pick = (pt) => {
    let best = null; let bestD = 8;
    for (const d of [...drawings].reverse()) {
      const dist = Math.min(...segmentsOf(d).map(([ax, ay, bx, by]) => distToSegment(pt.px, pt.py, ax, ay, bx, by)));
      if (dist < bestD) { best = d.id; bestD = dist; }
    }
    return best;
  };

  const onMove = (e) => {
    const pt = svgPoint(e);
    setHover(indexAt(pt.px, PAD.left, step, candles.length));
    setCursor(pt);
    if (drag.current) {
      const at = toData({ px: Math.min(Math.max(pt.px, PAD.left), plotRight), py: Math.min(Math.max(pt.py, PAD.top), plotBottom) });
      const { id, idx } = drag.current;
      setDrawings((list) => list.map((d) => (d.id === id ? { ...d, points: d.points.map((p, i) => (i === idx ? at : p)) } : d)));
    }
  };
  const onDown = (e) => {
    if (e.button !== 0 || !candles.length) return;
    const pt = svgPoint(e);
    if (!inPlot(pt)) return;
    if (tool === 'select') { setSelected(pick(pt)); return; }
    const spec = TOOLS.find((t) => t.key === tool);
    const at = toData(pt);
    if (draft) {
      const made = { id: newId(), type: tool, color: DRAW_COLORS[drawings.length % DRAW_COLORS.length], points: [draft.points[0], at] };
      commit([...drawings, made]);
      setDraft(null); setTool('select'); setSelected(made.id);
    } else if (spec.points === 1) {
      const extra = tool === 'note' ? { text: 'Note' } : tool === 'alert' ? { side: data && at.price < data.price ? 'below' : 'above' } : {};
      const made = { id: newId(), type: tool, color: DRAW_COLORS[drawings.length % DRAW_COLORS.length], points: [at], ...extra };
      commit([...drawings, made]);
      setTool('select'); setSelected(made.id);
    } else setDraft({ type: tool, points: [at] });
  };
  const onUp = () => { if (drag.current) { drag.current = null; saveDrawings(symbol, tf, drawings); } };
  const startDrag = (e, id, idx) => {
    e.stopPropagation();
    svgRef.current.setPointerCapture?.(e.pointerId);
    drag.current = { id, idx };
    setSelected(id);
  };

  const panelTop = (n) => priceH + GAP + n * (SUB_H + GAP);
  const subY = (n, lo, hi) => (v) => panelTop(n) + SUB_H - ((v - lo) / (hi - lo || 1)) * SUB_H;

  const macdVals = macd ? extent(macd.macd, macd.signalLine, macd.histogram, [0]) : [0, 1];
  const macdPad = (macdVals[1] - macdVals[0]) * 0.1 || 1;
  const macdY = subY(subs.indexOf('macd'), macdVals[0] - macdPad, macdVals[1] + macdPad);
  const rsiY = subY(subs.indexOf('rsi'), 0, 100);

  // Everything the tooltip and the screen-reader summary report for the candle under the pointer.
  const lines = [];
  if (shown) {
    const i = candles.indexOf(shown);
    if (on.volume) lines.push(`Volume ${compact(shown.volume)}`);
    if (sma) lines.push(`SMA ${sma.period}: ${num(sma.values[i])}`);
    if (ema) lines.push(`EMA ${ema.period}: ${num(ema.values[i])}`);
    if (bb) lines.push(`Bollinger (${bb.period}, ${bb.deviations}): ${num(bb.lower[i])} / ${num(bb.middle[i])} / ${num(bb.upper[i])}`);
    if (rsi) lines.push(`RSI ${rsi.period}: ${num(rsi.values[i])}`);
    if (macd) lines.push(`MACD ${num(macd.macd[i])} · signal ${num(macd.signalLine[i])} · histogram ${num(macd.histogram[i])}`);
  }
  const tipOnRight = hover != null && x(hover) < width / 2;

  const line = (series, style, key) => (
    <path key={key} d={seriesPath(series, x, y)} fill="none" stroke={style.color} strokeWidth="1.5" strokeDasharray={style.dash} />
  );

  const drawingLayer = (d, preview = false) => {
    const sel = d.id === selected && !preview;
    const pts = d.points.map(toPx);
    const [a, b] = pts;
    const op = preview ? 0.6 : 1;
    const tag = (yy, text, fill) => (
      <g>
        <rect x={plotRight} y={yy - 10} width={PAD.right} height={20} rx="3" fill={fill} />
        <text x={plotRight + 6} y={yy + 4} fontSize="11" fontWeight="600" fill="#020617">{text}</text>
      </g>
    );
    let shape = null;
    if (d.type === 'hline') {
      shape = <>
        <line x1={PAD.left} x2={plotRight} y1={a.y} y2={a.y} stroke={d.color} strokeWidth={sel ? 2 : 1.25} />
        {a.y >= PAD.top && a.y <= plotBottom && tag(a.y, money(d.points[0].price), d.color)}
      </>;
    } else if (d.type === 'trend' && b) {
      const m = measure(d.points[0], d.points[1], candles);
      shape = <>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={d.color} strokeWidth={sel ? 2.5 : 1.75} strokeLinecap="round" />
        <text x={(a.x + b.x) / 2} y={Math.min(a.y, b.y) - 8} fontSize="11" fontWeight="600" textAnchor="middle" fill={d.color}>
          {m.pct >= 0 ? '+' : ''}{m.pct.toFixed(2)}%
        </text>
      </>;
    } else if (d.type === 'fib' && b) {
      const [p0, p1] = d.points;
      const x1 = Math.min(a.x, b.x);
      shape = FIB_LEVELS.map((l, n) => {
        const price = p0.price + (p1.price - p0.price) * l;
        const yy = y(price);
        return (
          <g key={l}>
            {n < FIB_LEVELS.length - 1 && (
              <rect x={x1} y={Math.min(yy, y(p0.price + (p1.price - p0.price) * FIB_LEVELS[n + 1]))} width={Math.max(0, plotRight - x1)}
                height={Math.abs(y(p0.price + (p1.price - p0.price) * FIB_LEVELS[n + 1]) - yy)} fill={d.color} opacity={n % 2 ? 0.05 : 0.1} />
            )}
            <line x1={x1} x2={plotRight} y1={yy} y2={yy} stroke={d.color} strokeWidth={sel ? 1.5 : 1} strokeDasharray={l === 0 || l === 1 ? undefined : '4 3'} />
            <text x={x1 + 4} y={yy - 3} fontSize="10" fill={d.color}>{(l * 100).toFixed(1)}% · {money(price)}</text>
          </g>
        );
      });
    } else if (d.type === 'alert') {
      const hit = data ? alertHit(d, data.price) : false;
      shape = <>
        <line x1={PAD.left} x2={plotRight} y1={a.y} y2={a.y} stroke={d.color} strokeWidth={sel || hit ? 2 : 1.25} strokeDasharray="8 4" />
        <text x={plotRight - 6} y={a.y - 5} fontSize="11" fontWeight="600" textAnchor="end" fill={d.color}>
          {hit ? '✔ Alert reached' : `🔔 Alert: ${d.side === 'below' ? 'falls to' : 'rises to'} ${money(d.points[0].price)}`}
        </text>
        {a.y >= PAD.top && a.y <= plotBottom && tag(a.y, money(d.points[0].price), d.color)}
      </>;
    } else if (d.type === 'note') {
      const text = d.text || 'Note';
      const w = text.length * 6.2 + 14;
      shape = <>
        <circle cx={a.x} cy={a.y} r="4" fill={d.color} />
        <rect x={a.x + 8} y={a.y - 11} width={w} height="22" rx="4" fill="#0f172a" stroke={d.color} strokeWidth={sel ? 2 : 1} />
        <text x={a.x + 15} y={a.y + 4} fontSize="11" fill={TEXT_STRONG}>{text}</text>
      </>;
    } else if (d.type === 'rect' && b) {
      shape = <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)}
        fill={d.color} fillOpacity="0.14" stroke={d.color} strokeWidth={sel ? 2 : 1.25} />;
    } else if (d.type === 'measure' && b) {
      const m = measure(d.points[0], d.points[1], candles);
      const tone = m.delta >= 0 ? colors.up : colors.down;
      const cx = (a.x + b.x) / 2;
      shape = <>
        <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill={tone} opacity="0.12" stroke={tone} strokeDasharray="4 3" />
        <g>
          <rect x={cx - 70} y={Math.min(a.y, b.y) - 24} width="140" height="20" rx="4" fill={tone} />
          <text x={cx} y={Math.min(a.y, b.y) - 10} fontSize="11" fontWeight="600" textAnchor="middle" fill="#020617">
            {m.delta >= 0 ? '+' : ''}{m.delta.toFixed(2)} ({m.pct.toFixed(2)}%) · {m.bars} bars
          </text>
        </g>
      </>;
    }
    return (
      <g key={d.id} opacity={op} clipPath="url(#plot-clip)" style={{ pointerEvents: 'none' }}>
        {shape}
        {sel && pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="5" fill={BACKGROUND} stroke={d.color} strokeWidth="2"
            style={{ pointerEvents: 'all', cursor: 'grab' }} onPointerDown={(e) => startDrag(e, d.id, i)} />
        ))}
      </g>
    );
  };
  const draftDrawing = draft && cursor && inPlot(cursor) ? { id: 'draft', type: draft.type, color: DRAW_COLORS[0], points: [draft.points[0], toData(cursor)] } : null;
  const selectedDrawing = drawings.find((d) => d.id === selected);
  const crosshairOn = cursor && inPlot(cursor) && candles.length > 0;
  const priceChange = analysis?.changePct ?? 0;
  const A = analysis;
  const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const toneColor = { bull: colors.up, bear: colors.down, neutral: TEXT };

  const body = (
    <div className={full ? 'fixed inset-0 z-50 overflow-auto bg-slate-900 p-4' : ''}
      {...(full ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${symbol} chart, full screen` } : {})}>
      {data && (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold text-slate-100">{symbol}</span>
          <span className="text-2xl font-semibold tabular-nums" style={{ color: TEXT_STRONG }}>{money(data.price)}</span>
          <span className="text-sm font-medium tabular-nums" style={{ color: trend }}>{up ? '▲' : '▼'} {fmtPct(priceChange)}</span>
          <span className="text-xs text-slate-400">over {tf}</span>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: colors.up }} />Live
          </span>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => <Chip key={t} on={tf === t} onClick={() => update({ tf: t })}>{t}</Chip>)}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Chart type">
          {[['candles', 'Candles'], ['line', 'Line']].map(([m, label]) => <Chip key={m} on={mode === m} onClick={() => update({ mode: m })}>{label}</Chip>)}
          <select aria-label="Colour palette" value={prefs.palette} onChange={(e) => update({ palette: e.target.value })}
            className="rounded-md bg-slate-800 px-2 py-1 text-sm text-slate-200">
            {Object.entries(PALETTES).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
          <Chip on={full} onClick={() => setFull((f) => !f)} aria-label={full ? 'Exit full screen' : 'Full screen'}>{full ? 'Exit full screen' : 'Full screen'}</Chip>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1" role="group" aria-label="Indicators">
        {INDICATOR_KEYS.map((k) => <Chip key={k} on={on[k]} onClick={() => toggle(k)}>{LABELS[k]}</Chip>)}
        {on.sma && (
          <select aria-label="SMA period" value={prefs.smaPeriod} onChange={(e) => update({ smaPeriod: Number(e.target.value) })} className="rounded-md bg-slate-800 px-2 py-1 text-sm text-slate-200">
            {SMA_PERIODS.map((p) => <option key={p} value={p}>SMA {p}</option>)}
          </select>
        )}
        {on.ema && (
          <select aria-label="EMA period" value={prefs.emaPeriod} onChange={(e) => update({ emaPeriod: Number(e.target.value) })} className="rounded-md bg-slate-800 px-2 py-1 text-sm text-slate-200">
            {EMA_PERIODS.map((p) => <option key={p} value={p}>EMA {p}</option>)}
          </select>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1" role="group" aria-label="Drawing tools">
        {TOOLS.map((t) => <Chip key={t.key} on={tool === t.key} onClick={() => pickTool(t.key)}>{t.label}</Chip>)}
        <span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
        <Chip on={showLevels} onClick={() => setShowLevels((v) => !v)}>Support / resistance</Chip>
        <Chip on={showAnalysis} onClick={() => setShowAnalysis((v) => !v)}>Analysis</Chip>
        {selectedDrawing && (
          <>
            <span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
            {DRAW_COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => commit(drawings.map((d) => (d.id === selected ? { ...d, color: c } : d)))}
                className={`h-6 w-6 rounded-full border-2 ${selectedDrawing.color === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} />
            ))}
            {selectedDrawing.type === 'note' && (
              <input aria-label="Note text" value={selectedDrawing.text ?? ''} maxLength={NOTE_MAX}
                onChange={(e) => commit(drawings.map((d) => (d.id === selected ? { ...d, text: e.target.value } : d)))}
                className="w-48 rounded-md bg-slate-800 px-2 py-1 text-sm text-slate-100" />
            )}
            <button type="button" onClick={removeSelected} className="rounded-md bg-rose-900/70 px-3 py-1 text-sm text-rose-100 hover:bg-rose-800">Delete</button>
          </>
        )}
        {drawings.length > 0 && (
          <button type="button" onClick={() => { commit([]); setSelected(null); }} className="ml-auto rounded-md bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700">Clear all ({drawings.length})</button>
        )}
      </div>
      {tool !== 'select' && (
        <p className="mb-2 text-xs text-sky-300" role="status">
          {draft ? 'Click the chart again to finish.' : `Click the chart to place the ${TOOLS.find((t) => t.key === tool).label.toLowerCase()}.`} Esc cancels.
        </p>
      )}
      {tool === 'select' && drawings.length > 0 && !selectedDrawing && <p className="mb-2 text-xs text-slate-400">Click a drawing to edit it: drag its handles, change its colour, or press Delete.</p>}

      <p className="mb-2 min-h-5 text-xs" style={{ color: TEXT }} data-testid="chart-readout" aria-live="off">
        {shown && (
          <>
            {fmtTime(shown.t, tf)} · O <b style={{ color: TEXT_STRONG }}>{money(shown.open)}</b> H <b style={{ color: TEXT_STRONG }}>{money(shown.high)}</b> L <b style={{ color: TEXT_STRONG }}>{money(shown.low)}</b> C <b style={{ color: TEXT_STRONG }}>{money(shown.close)}</b>
          </>
        )}
      </p>

      <div ref={wrapRef} className="relative w-full select-none overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60" style={{ height: totalH }}>
        {error && !data && <p className="absolute inset-0 grid place-items-center text-sm text-rose-300">{error}</p>}
        {!data && !error && <p className="absolute inset-0 grid place-items-center text-sm text-slate-400">Loading chart…</p>}
        {data && (
          <svg ref={svgRef} width={width} height={totalH} viewBox={`0 0 ${width} ${totalH}`} role="img"
            aria-label={`Price chart${shown ? `. ${fmtTime(shown.t, tf)}: open ${money(shown.open)}, high ${money(shown.high)}, low ${money(shown.low)}, close ${money(shown.close)}` : ''}${lines.length ? `. ${lines.join('. ')}` : ''}`}
            onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp}
            onPointerLeave={() => { setHover(null); setCursor(null); }}
            style={{ touchAction: tool === 'select' ? 'pan-y' : 'none', maxWidth: '100%', cursor: tool === 'select' ? 'default' : 'crosshair' }}>
            <defs>
              <clipPath id="plot-clip"><rect x={PAD.left} y={PAD.top} width={Math.max(0, plotW)} height={Math.max(0, plotH)} /></clipPath>
              <linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={trend} stopOpacity="0.35" />
                <stop offset="100%" stopColor={trend} stopOpacity="0" />
              </linearGradient>
            </defs>
            {gridValues.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth="1" />
                <text x={width - PAD.right + 6} y={y(v) + 4} fontSize="11" fill={TEXT}>{money(v)}</text>
              </g>
            ))}
            {xLabels.map((i) => (
              <text key={i} x={x(i)} y={priceH - 6} fontSize="11" fill={TEXT} textAnchor={i === 0 ? 'start' : i === candles.length - 1 ? 'end' : 'middle'}>
                {fmtTime(candles[i].t, tf)}
              </text>
            ))}

            {on.volume && candles.map((c, i) => (
              <rect key={c.t} x={x(i) - Math.max(1, step * 0.35)} width={Math.max(1, step * 0.7)}
                y={PAD.top + plotH - (c.volume / maxVol) * volH} height={(c.volume / maxVol) * volH}
                fill={c.close >= c.open ? colors.up : colors.down} opacity="0.35" />
            ))}

            {bb && (
              <>
                <path d={bandPath(bb.upper, bb.lower, x, y)} fill={INDICATOR_STYLES.bb.color} opacity="0.08" stroke="none" />
                {line(bb.upper, INDICATOR_STYLES.bb, 'bbu')}
                {line(bb.lower, INDICATOR_STYLES.bb, 'bbl')}
                {line(bb.middle, { ...INDICATOR_STYLES.bb, dash: '6 2 1 2' }, 'bbm')}
              </>
            )}

            {mode === 'candles' ? candles.map((c, i) => {
              const upCandle = c.close >= c.open;
              const color = upCandle ? colors.up : colors.down;
              const bodyTop = y(Math.max(c.open, c.close));
              const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
              const w = Math.max(1, Math.min(14, step * 0.7));
              return (
                <g key={c.t}>
                  <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" />
                  {/* Rising candles are hollow and falling ones solid, so direction never depends on colour alone. */}
                  <rect x={x(i) - w / 2} y={bodyTop} width={w} height={bodyH} fill={upCandle ? BACKGROUND : color} stroke={color} strokeWidth="1" />
                </g>
              );
            }) : (
              <>
                <path d={`${seriesPath(candles.map((c) => c.close), x, y)} L${x(candles.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`} fill="url(#area-fill)" />
                <path d={seriesPath(candles.map((c) => c.close), x, y)} fill="none" stroke={trend} strokeWidth="2" />
              </>
            )}

            {sma && line(sma.values, INDICATOR_STYLES.sma, 'sma')}
            {ema && line(ema.values, INDICATOR_STYLES.ema, 'ema')}

            {last && (
              <g>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(data.price)} y2={y(data.price)} stroke={trend} strokeDasharray="4 4" strokeWidth="1" />
                <rect x={width - PAD.right} y={y(data.price) - 10} width={PAD.right} height={20} fill={trend} rx="3" />
                <text x={width - PAD.right + 6} y={y(data.price) + 4} fontSize="11" fontWeight="600" fill="#020617">{money(data.price)}</text>
              </g>
            )}

            {rsi && (
              <g>
                <text x={PAD.left} y={panelTop(subs.indexOf('rsi')) - 3} fontSize="11" fill={TEXT}>RSI {rsi.period}</text>
                {[30, 70].map((v) => (
                  <g key={v}>
                    <line x1={PAD.left} x2={width - PAD.right} y1={rsiY(v)} y2={rsiY(v)} stroke={TEXT} strokeDasharray="2 4" strokeWidth="1" opacity="0.6" />
                    <text x={width - PAD.right + 6} y={rsiY(v) + 4} fontSize="11" fill={TEXT}>{v}</text>
                  </g>
                ))}
                <rect x={PAD.left} y={panelTop(subs.indexOf('rsi'))} width={plotW} height={SUB_H} fill="none" stroke={GRID} />
                <path d={seriesPath(rsi.values, x, rsiY)} fill="none" stroke={INDICATOR_STYLES.rsi.color} strokeWidth="1.5" />
              </g>
            )}

            {macd && (
              <g>
                <text x={PAD.left} y={panelTop(subs.indexOf('macd')) - 3} fontSize="11" fill={TEXT}>MACD {macd.fast}, {macd.slow}, {macd.signal}</text>
                <rect x={PAD.left} y={panelTop(subs.indexOf('macd'))} width={plotW} height={SUB_H} fill="none" stroke={GRID} />
                <line x1={PAD.left} x2={width - PAD.right} y1={macdY(0)} y2={macdY(0)} stroke={TEXT} strokeWidth="1" opacity="0.6" />
                {macd.histogram.map((v, i) => v === null ? null : (
                  <rect key={i} x={x(i) - Math.max(1, step * 0.35)} width={Math.max(1, step * 0.7)}
                    y={Math.min(macdY(0), macdY(v))} height={Math.abs(macdY(v) - macdY(0))} fill={v >= 0 ? colors.up : colors.down} opacity="0.6" />
                ))}
                <path d={seriesPath(macd.macd, x, macdY)} fill="none" stroke={INDICATOR_STYLES.macd.color} strokeWidth="1.5" />
                <path d={seriesPath(macd.signalLine, x, macdY)} fill="none" stroke={INDICATOR_STYLES.signal.color} strokeWidth="1.5" strokeDasharray={INDICATOR_STYLES.signal.dash} />
              </g>
            )}

            {showLevels && A && [...A.levels.support.map((l) => ['S', l]), ...A.levels.resistance.map((l) => ['R', l])].map(([kind, l]) => (
              y(l.price) >= PAD.top && y(l.price) <= plotBottom && (
                <g key={`${kind}${l.price}`}>
                  <line x1={PAD.left} x2={plotRight} y1={y(l.price)} y2={y(l.price)} stroke={kind === 'S' ? colors.up : colors.down} strokeWidth="1" strokeDasharray="1 4" strokeLinecap="round" />
                  <text x={PAD.left + 4} y={y(l.price) - 3} fontSize="10" fill={kind === 'S' ? colors.up : colors.down}>
                    {kind === 'S' ? 'Support' : 'Resistance'} {money(l.price)} · {l.touches}×
                  </text>
                </g>
              )
            ))}

            {drawings.map((d) => drawingLayer(d))}
            {draftDrawing && drawingLayer(draftDrawing, true)}

            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={totalH - (subs.length ? 0 : PAD.bottom)} stroke={TEXT} strokeDasharray="3 3" strokeWidth="1" />
            )}
            {crosshairOn && (
              <g style={{ pointerEvents: 'none' }}>
                <line x1={PAD.left} x2={plotRight} y1={cursor.py} y2={cursor.py} stroke={TEXT} strokeDasharray="3 3" strokeWidth="1" />
                <rect x={plotRight} y={cursor.py - 10} width={PAD.right} height={20} rx="3" fill="#334155" />
                <text x={plotRight + 6} y={cursor.py + 4} fontSize="11" fill={TEXT_STRONG}>{money(toData(cursor).price)}</text>
                {hover != null && candles[hover] && (
                  <g>
                    <rect x={Math.min(Math.max(x(hover) - 40, PAD.left), plotRight - 80)} y={plotBottom + 2} width="80" height="18" rx="3" fill="#334155" />
                    <text x={Math.min(Math.max(x(hover), PAD.left + 40), plotRight - 40)} y={plotBottom + 15} fontSize="11" textAnchor="middle" fill={TEXT_STRONG}>{fmtTime(candles[hover].t, tf)}</text>
                  </g>
                )}
              </g>
            )}
          </svg>
        )}
        {data && hover != null && shown && lines.length > 0 && (
          <div role="tooltip" data-testid="chart-tooltip"
            className="pointer-events-none absolute top-2 max-w-[18rem] rounded-md border border-slate-600 bg-slate-950/95 px-2 py-1 text-xs"
            style={{ color: TEXT_STRONG, [tipOnRight ? 'left' : 'right']: tipOnRight ? Math.min(width - 200, x(hover) + 12) : Math.min(width - 200, width - x(hover) + 12) }}>
            {lines.map((l) => <div key={l}>{l}</div>)}
          </div>
        )}
      </div>

      {showAnalysis && A && (
        <section className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3" aria-label="Chart analysis" data-testid="chart-analysis">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Analysis · {tf}</h3>
            <span className="rounded px-2 py-0.5 text-xs font-semibold text-slate-950" style={{ background: A.trend.direction === 'Uptrend' ? colors.up : A.trend.direction === 'Downtrend' ? colors.down : TEXT }}>
              {A.trend.direction}
            </span>
            {A.bias && <span className="rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-200">Indicator bias: {A.bias}</span>}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {[
              ['Change', `${A.change >= 0 ? '+' : ''}${money(A.change)} (${fmtPct(A.changePct)})`],
              ['High / Low', `${money(A.high)} / ${money(A.low)}`],
              ['From high', fmtPct(A.fromHighPct)],
              ['From low', fmtPct(A.fromLowPct)],
              ['Volatility', `${A.volatility.toFixed(2)}% per candle`],
              ['Max drawdown', fmtPct(A.drawdownPct)],
              ['Trend fit (R²)', A.trend.r2.toFixed(2)],
              ['Volume vs avg', A.avgVolume ? `${((A.lastVolume / A.avgVolume) * 100).toFixed(0)}%` : '–'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md bg-slate-900 px-2 py-1.5">
                <dt className="text-slate-400">{k}</dt>
                <dd className="font-semibold tabular-nums" style={{ color: TEXT_STRONG }}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <h4 className="mb-1 font-semibold text-slate-200">Key levels</h4>
              <ul className="space-y-0.5">
                {[...A.levels.resistance].reverse().map((l) => <li key={`r${l.price}`} style={{ color: colors.down }}>Resistance {money(l.price)} <span className="text-slate-400">({l.touches} touches)</span></li>)}
                <li style={{ color: TEXT_STRONG }}>Now {money(data.price)}</li>
                {[...A.levels.support].reverse().map((l) => <li key={`s${l.price}`} style={{ color: colors.up }}>Support {money(l.price)} <span className="text-slate-400">({l.touches} touches)</span></li>)}
                {!A.levels.support.length && !A.levels.resistance.length && <li className="text-slate-400">Not enough turning points yet.</li>}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 font-semibold text-slate-200">Signals</h4>
              {A.signals.length ? (
                <ul className="space-y-0.5">
                  {A.signals.map((s) => <li key={s.text}><span aria-hidden="true" style={{ color: toneColor[s.tone] }}>● </span><span className="text-slate-300">{s.text}</span></li>)}
                </ul>
              ) : <p className="text-slate-400">Switch on RSI, MACD, SMA, EMA or Bollinger to see signals.</p>}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Educational reading of simulated prices, not financial advice.</p>
        </section>
      )}

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: TEXT }} aria-label="Legend">
        {sma && <li><span style={{ color: INDICATOR_STYLES.sma.color }}>━━</span> SMA {sma.period}</li>}
        {ema && <li><span style={{ color: INDICATOR_STYLES.ema.color }}>╌╌</span> EMA {ema.period}</li>}
        {bb && <li><span style={{ color: INDICATOR_STYLES.bb.color }}>┅┅</span> Bollinger ({bb.period}, {bb.deviations}σ)</li>}
        <li>Rising candles are hollow, falling candles are filled.</li>
      </ul>
      <p className="mt-1 text-xs text-slate-400">Simulated prices, updating every few seconds. Indicators are calculated from the candle closes.</p>
    </div>
  );

  return body;
}
