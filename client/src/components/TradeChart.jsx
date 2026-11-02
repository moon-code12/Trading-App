import { useEffect, useRef, useState } from 'react';
import { api, money } from '../api.js';
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

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(indexAt(((e.clientX - rect.left) / rect.width) * width, PAD.left, step, candles.length));
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

  const body = (
    <div className={full ? 'fixed inset-0 z-50 overflow-auto bg-slate-900 p-4' : ''}
      {...(full ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${symbol} chart, full screen` } : {})}>
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

      <p className="mb-2 min-h-5 text-xs" style={{ color: TEXT }} data-testid="chart-readout" aria-live="off">
        {shown && (
          <>
            {fmtTime(shown.t, tf)} · O <b style={{ color: TEXT_STRONG }}>{money(shown.open)}</b> H <b style={{ color: TEXT_STRONG }}>{money(shown.high)}</b> L <b style={{ color: TEXT_STRONG }}>{money(shown.low)}</b> C <b style={{ color: TEXT_STRONG }}>{money(shown.close)}</b>
          </>
        )}
      </p>

      <div ref={wrapRef} className="relative w-full select-none" style={{ height: totalH }}>
        {error && !data && <p className="absolute inset-0 grid place-items-center text-sm text-rose-300">{error}</p>}
        {!data && !error && <p className="absolute inset-0 grid place-items-center text-sm text-slate-400">Loading chart…</p>}
        {data && (
          <svg width={width} height={totalH} viewBox={`0 0 ${width} ${totalH}`} role="img"
            aria-label={`Price chart${shown ? `. ${fmtTime(shown.t, tf)}: open ${money(shown.open)}, high ${money(shown.high)}, low ${money(shown.low)}, close ${money(shown.close)}` : ''}${lines.length ? `. ${lines.join('. ')}` : ''}`}
            onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y', maxWidth: '100%' }}>
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
                <path d={`${seriesPath(candles.map((c) => c.close), x, y)} L${x(candles.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`} fill={trend} opacity="0.1" />
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

            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={totalH - (subs.length ? 0 : PAD.bottom)} stroke={TEXT} strokeDasharray="3 3" strokeWidth="1" />
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
