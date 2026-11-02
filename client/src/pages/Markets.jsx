import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, compact, compactUsd, money } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Button, Card, Change, Field, FavouriteButton, MarketBadge, ORDER_LABELS, Select, Table, useLoad } from '../components/ui.jsx';
import TradeChart from '../components/TradeChart.jsx';
import PaperNotice, { useSimulation } from '../components/PaperNotice.jsx';

const SORTS = [
  ['', 'Default order'], ['change', '24h change'], ['volume', '24h traded value'], ['price', 'Price'], ['name', 'Name'],
];

// Marks the asset as viewed so it shows up under "Recently viewed".
function useRecordView(symbol) {
  useEffect(() => { api(`/recent/${symbol}`, { method: 'PUT' }).catch(() => {}); }, [symbol]);
}

function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

// One entry in the discovery and favourites lists. The link text includes the figure, so it reads as a whole.
const Entry = ({ a, detail }) => (
  <li>
    <Link to={`/markets/${a.symbol}`} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">
      <span className="font-medium">{a.symbol} <span className="hidden text-slate-500 sm:inline">{a.name}</span></span>
      <span>{detail}</span>
    </Link>
  </li>
);

function DiscoveryCard({ title, items, empty, detail }) {
  return (
    <Card title={title}>
      {items.length === 0 ? <p className="text-sm text-slate-500">{empty}</p> : (
        <ul className="space-y-0.5" aria-label={title}>{items.map((a) => <Entry key={a.symbol} a={a} detail={detail(a)} />)}</ul>
      )}
    </Card>
  );
}

const ChangeText = ({ a }) => <Change value={a.change24h} />;

export function Markets() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [sort, setSort] = useState('');
  const dq = useDebounced(q);
  const meta = useLoad(() => api('/markets/meta'));
  const disc = useLoad(() => api('/markets/discovery'));
  const favs = useLoad(() => api('/watchlist'));
  const recent = useLoad(() => api('/recent'));
  const query = new URLSearchParams({ ...(dq.trim() && { q: dq.trim() }), ...(cat !== 'all' && { category: cat }), ...(sort && { sort }) }).toString();
  const { data, error, reload } = useLoad(() => api(`/markets${query ? `?${query}` : ''}`), [query]);

  const toggleFavourite = async (a) => {
    await api(`/watchlist/${a.symbol}`, { method: a.favourite ? 'DELETE' : 'PUT' });
    reload(); favs.reload(); recent.reload();
  };
  const clearRecent = async () => { await api('/recent', { method: 'DELETE' }); recent.reload(); };
  const categories = ['all', ...(meta.data?.categories.map((c) => c.id) ?? [])];
  const rows = data?.assets ?? [];
  const filtered = dq.trim() || cat !== 'all';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Markets</h1>
        <Link to="/markets/compare" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Compare assets</Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <DiscoveryCard title="Top gainers" items={disc.data?.gainers ?? []} empty="Nothing is up over 24h right now." detail={(a) => <ChangeText a={a} />} />
        <DiscoveryCard title="Top losers" items={disc.data?.losers ?? []} empty="Nothing is down over 24h right now." detail={(a) => <ChangeText a={a} />} />
        <DiscoveryCard title="Most active" items={disc.data?.active ?? []} empty="No activity yet." detail={(a) => <span className="text-slate-300">{compactUsd(a.volumeUsd24h)}</span>} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Favourites">
          {(favs.data?.assets ?? []).length === 0 ? <p className="text-sm text-slate-500">Tap the star on any asset to keep it here.</p> : (
            <ul className="space-y-0.5" aria-label="Favourite assets">{favs.data.assets.map((a) => <Entry key={a.symbol} a={a} detail={<ChangeText a={a} />} />)}</ul>
          )}
        </Card>
        <Card title="Recently viewed" action={(recent.data?.assets ?? []).length > 0 && <button onClick={clearRecent} className="text-xs text-slate-400 hover:text-white">Clear</button>}>
          {(recent.data?.assets ?? []).length === 0 ? <p className="text-sm text-slate-500">Assets you open will appear here.</p> : (
            <ul className="space-y-0.5" aria-label="Recently viewed assets">{recent.data.assets.map((a) => <Entry key={a.symbol} a={a} detail={<ChangeText a={a} />} />)}</ul>
          )}
        </Card>
      </div>

      <div className="grid items-end gap-3 md:grid-cols-[1fr_auto]">
        <Field label="Search markets" type="search" placeholder="Symbol or name, e.g. BTC or gold" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>
      <div className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c}
            className={`rounded-full px-4 py-1.5 text-sm capitalize ${cat === c ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{c}</button>
        ))}
      </div>
      <Alert>{error}</Alert>
      <Card>
        <Table
          head={[
            { label: 'Favourite', cls: 'sr-only' }, 'Asset', { label: 'Category', cls: 'hidden lg:table-cell' }, 'Price', '24h',
            { label: '24h high / low', cls: 'hidden lg:table-cell' }, { label: '24h volume', cls: 'hidden md:table-cell' },
            { label: 'Market', cls: 'hidden md:table-cell' }, { label: 'Trade', cls: 'sr-only' },
          ]}
          empty={filtered ? 'No assets match your search.' : 'Nothing here yet.'}
          rows={rows.map((a) => (
            <tr key={a.symbol}>
              <td className="px-2 py-2 md:px-3"><FavouriteButton symbol={a.symbol} active={a.favourite} onToggle={() => toggleFavourite(a)} /></td>
              <td className="px-2 py-2 md:px-3">
                <Link to={`/markets/${a.symbol}`} className="font-medium hover:text-emerald-400">{a.symbol}</Link>{' '}
                <span className="hidden text-slate-500 md:inline">{a.name}</span>
                <span className="block text-xs text-slate-500 md:hidden">{a.market.label}</span>
              </td>
              <td className="hidden px-3 py-2 capitalize text-slate-400 lg:table-cell">{a.category}</td>
              <td className="px-2 py-2 md:px-3">{money(a.price)}</td>
              <td className="px-2 py-2 md:px-3"><Change value={a.change24h} /></td>
              <td className="hidden px-3 py-2 text-slate-400 lg:table-cell">{money(a.high24h)} / {money(a.low24h)}</td>
              <td className="hidden px-3 py-2 md:table-cell" title={`${compactUsd(a.volumeUsd24h)} traded`}>{compact(a.volume24h)}</td>
              <td className="hidden px-3 py-2 md:table-cell"><MarketBadge market={a.market} /></td>
              <td className="px-2 py-2 text-right md:px-3"><Link to={`/trade/${a.symbol}`} className="text-emerald-400">Trade</Link></td>
            </tr>
          ))}
        />
      </Card>
      <p className="text-xs text-slate-500">Prices, volumes and market hours are simulated demo data. Market hours are shown in UTC and do not stop trading in this demo.</p>
    </>
  );
}

export function Asset() {
  const { symbol } = useParams();
  const { data, error } = useLoad(() => api(`/markets/${symbol}`), [symbol]);
  const watch = useLoad(() => api('/watchlist'));
  const [livePrice, setLivePrice] = useState(null);
  useRecordView(symbol.toUpperCase());
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <p className="text-slate-400">Loading…</p>;
  const { asset } = data;
  const watching = watch.data?.assets.some((a) => a.symbol === asset.symbol);
  const toggle = async () => {
    await api(`/watchlist/${asset.symbol}`, { method: watching ? 'DELETE' : 'PUT' });
    watch.reload();
  };
  const stats = [
    ['24h open', money(asset.open24h)], ['24h high', money(asset.high24h)], ['24h low', money(asset.low24h)],
    ['24h volume', `${compact(asset.volume24h)} ${asset.symbol}`, `${compactUsd(asset.volumeUsd24h)} traded`],
    ['24h change', <Change key="c" value={asset.change24h} />], ['Volatility', <span key="v" className="capitalize">{asset.risk}</span>],
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{asset.name} <span className="text-slate-500">{asset.symbol}</span></h1>
          <p className="mt-1 text-3xl font-bold">{money(livePrice ?? asset.price)} <span className="text-base"><Change value={asset.change24h} /></span></p>
          {asset.spreadBps > 0 && <p className="mt-1 text-sm text-slate-400">Bid {money(asset.bid)} · Ask {money(asset.ask)} · spread {Number(asset.spreadBps.toFixed(2))} bps</p>}
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <MarketBadge market={asset.market} /> {asset.market.nextChangeLabel}
            {asset.status === 'paused' && <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">trading paused</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={toggle}>{watching ? 'Remove from favourites' : 'Add to favourites'}</Button>
          <Link to={`/markets/compare?a=${asset.symbol}`} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Compare</Link>
          <Link to={`/trade/${asset.symbol}`}><Button>Trade</Button></Link>
        </div>
      </div>
      <Card><TradeChart symbol={asset.symbol} onPrice={setLivePrice} /></Card>
      <AlertsCard symbol={asset.symbol} price={livePrice ?? asset.price} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        {stats.map(([l, v, hint]) => (
          <Card key={l}><p className="text-sm text-slate-400">{l}</p><p className="text-lg font-semibold md:text-xl">{v}</p>{hint && <p className="text-xs text-slate-500">{hint}</p>}</Card>
        ))}
      </div>
      <p className="text-xs text-slate-500">24h figures are simulated demo data. Market hours: {asset.market.session}.</p>
      <PaperNotice category={asset.category} />
    </>
  );
}

const TYPE_LABELS = { ...ORDER_LABELS, oco: 'OCO (one cancels the other)' };
const BUY_TYPES = ['market', 'limit', 'stop', 'stop_limit', 'oco'];
const PRICE_LABELS = { limit: 'Limit price', stop: 'Stop price', stop_loss: 'Stop-loss price', take_profit: 'Take-profit price', stop_limit: 'Stop price' };
const BLANK = { side: 'buy', type: 'market', quantity: '', price: '', limitPrice: '', trailMode: 'percent', trailValue: '', tif: '', ocoTarget: '', ocoStop: '', ocoStopLimit: '' };

// Turns the ticket into an API request; the server validates everything again.
function buildRequest(f, symbol) {
  const n = Number;
  const base = { symbol, side: f.side, quantity: n(f.quantity), ...(f.tif && { timeInForce: f.tif }) };
  if (f.type === 'oco') {
    const sell = f.side === 'sell';
    const stopLeg = f.ocoStopLimit
      ? { type: 'stop_limit', price: n(f.ocoStop), limitPrice: n(f.ocoStopLimit) }
      : { type: sell ? 'stop_loss' : 'stop', price: n(f.ocoStop) };
    return { path: '/orders/oco', body: { ...base, legs: [{ type: sell ? 'take_profit' : 'limit', price: n(f.ocoTarget) }, stopLeg] } };
  }
  const body = { ...base, type: f.type };
  if (PRICE_LABELS[f.type]) body.price = n(f.price);
  if (f.type === 'stop_limit') body.limitPrice = n(f.limitPrice);
  if (f.type === 'trailing_stop') body[f.trailMode === 'percent' ? 'trailPercent' : 'trailAmount'] = n(f.trailValue);
  return { path: '/orders', body };
}

// Extra rows for the confirmation screen: [label, value] pairs.
function triggerRows(f) {
  const m = (v) => money(Number(v));
  switch (f.type) {
    case 'oco': return [
      [f.side === 'sell' ? 'Take-profit price' : 'Limit price', m(f.ocoTarget)],
      [f.ocoStopLimit ? 'Stop / limit price' : (f.side === 'sell' ? 'Stop-loss price' : 'Stop price'), f.ocoStopLimit ? `${m(f.ocoStop)} / ${m(f.ocoStopLimit)}` : m(f.ocoStop)],
    ];
    case 'trailing_stop': return [['Trails by', f.trailMode === 'percent' ? `${f.trailValue}%` : m(f.trailValue)]];
    case 'stop_limit': return [['Stop price', m(f.price)], ['Limit price', m(f.limitPrice)]];
    case 'market': return [];
    default: return [[PRICE_LABELS[f.type], m(f.price)]];
  }
}

export function Trade() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const { data } = useLoad(() => api(`/markets/${symbol}`), [symbol]);
  const sim = useSimulation();
  useRecordView(symbol.toUpperCase());
  const [f, setF] = useState(BLANK);
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [livePrice, setLivePrice] = useState(null);
  const bind = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  if (!data) return <p className="text-slate-400">Loading…</p>;
  const { asset } = data;
  const qty = Number(f.quantity);
  const current = livePrice ?? asset.price;
  const rules = asset.quantityRules;
  const halfSpread = (current * (asset.spreadBps ?? 0)) / 2e4;
  const types = f.side === 'buy' ? BUY_TYPES : Object.keys(TYPE_LABELS);
  const setSide = (side) => setF({ ...f, side, type: side === 'buy' && !BUY_TYPES.includes(f.type) ? 'market' : f.type });

  const review = async (e) => {
    e.preventDefault();
    setError(''); setConfirmed(false); setBusy(true);
    try {
      const { path, body } = buildRequest(f, asset.symbol);
      setPreview({ ...(await api('/orders/preview', { method: 'POST', body })), path, body });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const place = async () => {
    setBusy(true); setError('');
    try {
      await api(preview.path, { method: 'POST', body: { ...preview.body, confirmLarge: confirmed } });
      await refresh();
      nav('/orders');
    } catch (err) { setError(err.message); setPreview(null); } finally { setBusy(false); }
  };

  return (
    <>
      <h1 className="text-2xl font-bold">Trade {asset.symbol}</h1>
      <p className="text-slate-400">Current price {money(current)}</p>
      {asset.spreadBps > 0 && (
        <p className="text-sm text-slate-400" data-testid="bid-ask">Bid {money(current - halfSpread)} · Ask {money(current + halfSpread)} · spread {Number(asset.spreadBps.toFixed(2))} bps. You buy at the ask and sell at the bid.</p>
      )}
      <p className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <MarketBadge market={asset.market} />
        {!asset.market.open && (sim?.marketHours
          ? <span className="text-amber-300">The market is closed. Orders wait until it opens and then execute at the opening price, which can gap away from the last close.</span>
          : <span className="text-amber-300">The simulated market is closed, but demo orders still fill at simulated prices.</span>)}
        {asset.status === 'paused' && <span className="text-amber-300">Trading in this asset is paused.</span>}
      </p>
      <p className="text-sm text-slate-500">
        Volatility: <span className={asset.risk === 'high' ? 'text-amber-400' : ''}>{asset.risk}</span>
        {' · '}simulated liquidity about {asset.liquidity} {asset.symbol} per 5 seconds · {rules?.label ? `quantity: ${rules.label} · ` : ''}demo funds only
      </p>
      <Card><TradeChart symbol={asset.symbol} height={280} onPrice={setLivePrice} /></Card>
      {!preview ? (
        <Card title="Order ticket">
          <form className="grid gap-4 md:grid-cols-2" onSubmit={review}>
            <Select label="Side" value={f.side} onChange={(e) => setSide(e.target.value)}><option value="buy">Buy</option><option value="sell">Sell</option></Select>
            <Select label="Order type" {...bind('type')}>
              {types.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </Select>
            <Field label={rules?.step ? `Quantity (${rules.label})` : 'Quantity'} type="number" step={rules?.step || 'any'} min={rules?.min ?? 0} max={rules?.max} required {...bind('quantity')} />
            <Select label="Time in force" {...bind('tif')}>
              <option value="">Default ({f.type === 'market' ? 'Day' : 'Good till cancelled'})</option>
              <option value="day">Day (expires at 00:00 UTC)</option>
              <option value="gtc">Good till cancelled</option>
            </Select>
            {PRICE_LABELS[f.type] && <Field label={PRICE_LABELS[f.type]} type="number" step="any" min="0" required {...bind('price')} />}
            {f.type === 'stop_limit' && <Field label="Limit price" type="number" step="any" min="0" required {...bind('limitPrice')} />}
            {f.type === 'trailing_stop' && <>
              <Select label="Trail type" {...bind('trailMode')}><option value="percent">Percent</option><option value="amount">Fixed amount</option></Select>
              <Field label={f.trailMode === 'percent' ? 'Trailing distance (%)' : 'Trailing distance (amount)'} type="number" step="any" min="0" required {...bind('trailValue')} />
            </>}
            {f.type === 'oco' && <>
              <Field label={f.side === 'sell' ? 'Take-profit price' : 'Limit price'} type="number" step="any" min="0" required {...bind('ocoTarget')} />
              <Field label={f.side === 'sell' ? 'Stop-loss price' : 'Stop price'} type="number" step="any" min="0" required {...bind('ocoStop')} />
              <Field label="Stop-limit price (optional)" type="number" step="any" min="0" {...bind('ocoStopLimit')} />
              <p className="text-sm text-slate-400 md:col-span-2">When one of the two orders fills, the other is cancelled automatically.</p>
            </>}
            {['stop_loss', 'take_profit', 'trailing_stop'].includes(f.type) && (
              <p className="text-sm text-slate-400 md:col-span-2">{TYPE_LABELS[f.type]} orders protect shares you already own, so they are sell-only.</p>
            )}
            <div className="md:col-span-2"><Alert>{error}</Alert></div>
            <div><Button disabled={!(qty > 0) || busy}>Review order</Button></div>
          </form>
        </Card>
      ) : (
        <Card title="Confirm your order">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-slate-400">Action</dt><dd>{TYPE_LABELS[f.type].split(' (')[0]} {f.side}</dd>
            <dt className="text-slate-400">Asset</dt><dd>{asset.symbol}</dd>
            <dt className="text-slate-400">Quantity</dt><dd>{qty}</dd>
            {triggerRows(f).map(([label, value]) => <Row key={label} label={label}>{value}</Row>)}
            <dt className="text-slate-400">Current price</dt><dd>{money(preview.estimate.price)}</dd>
            {preview.estimate.spreadBps > 0 && <Row label="Bid / ask">{money(preview.estimate.bid)} / {money(preview.estimate.ask)}</Row>}
            {preview.estimate.estimatedFee > 0 && <Row label="Estimated fee">{money(preview.estimate.estimatedFee)}</Row>}
            {preview.estimate.maxSlippageBps > 0 && <Row label="Possible slippage">up to {Number(preview.estimate.maxSlippageBps.toFixed(1))} bps on market-style orders</Row>}
            {preview.estimate.marketOpen === false && <Row label="Market">Closed. Opens {new Date(preview.estimate.opensAt).toLocaleString()}</Row>}
            <dt className="text-slate-400">Estimated total (demo)</dt>
            <dd className="font-semibold">{money(preview.estimate.notional)} <span className="font-normal text-slate-400">({preview.estimate.portfolioPct.toFixed(1)}% of portfolio)</span></dd>
            <dt className="text-slate-400">Time in force</dt>
            <dd>{preview.timeInForce === 'day' ? `Day, expires ${new Date(preview.expiresAt).toLocaleString()}` : 'Good till cancelled'}</dd>
          </dl>
          {preview.warnings.length > 0 && (
            <ul className="mt-4 space-y-2" aria-label="Risk warnings">
              {preview.warnings.map((w) => (
                <li key={w.code} className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">{w.message}</li>
              ))}
            </ul>
          )}
          {preview.requiresConfirmation && (
            <label className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/40 p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I understand this is a large order ({preview.estimate.portfolioPct.toFixed(1)}% of my portfolio) and want to place it.</span>
            </label>
          )}
          <PaperNotice category={asset.category} className="mt-4" />
          <div className="mt-4"><Alert>{error}</Alert></div>
          <div className="mt-5 flex gap-3">
            <Button onClick={place} disabled={busy || (preview.requiresConfirmation && !confirmed)}>{busy ? 'Placing…' : 'Confirm order'}</Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>Back</Button>
          </div>
        </Card>
      )}
      {!preview && <PaperNotice category={asset.category} />}
    </>
  );
}

const Row = ({ label, children }) => <><dt className="text-slate-400">{label}</dt><dd>{children}</dd></>;

function AlertsCard({ symbol, price }) {
  const { data, reload } = useLoad(() => api('/alerts'), [symbol]);
  const [direction, setDirection] = useState('above');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const mine = (data?.alerts ?? []).filter((a) => a.symbol === symbol);

  const add = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api('/alerts', { method: 'POST', body: { symbol, direction, target: Number(target) } });
      setTarget('');
      reload();
    } catch (err) { setError(err.message); }
  };
  const remove = async (id) => { await api(`/alerts/${id}`, { method: 'DELETE' }); reload(); };

  return (
    <Card title="Price alerts">
      <form onSubmit={add} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
        <Select label="Alert me when price is" value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="above">At or above</option>
          <option value="below">At or below</option>
        </Select>
        <Field label={`Target price (now ${money(price)})`} type="number" step="any" min="0" required value={target} onChange={(e) => setTarget(e.target.value)} />
        <Button>Add alert</Button>
      </form>
      <div className="mt-3"><Alert>{error}</Alert></div>
      <ul className="mt-3 divide-y divide-slate-800" aria-label="Alerts for this asset">
        {mine.map((a) => (
          <li key={a.id} className="flex items-center justify-between py-2 text-sm">
            <span>{a.direction === 'above' ? '≥' : '≤'} {money(a.target)}</span>
            {a.status === 'active'
              ? <button onClick={() => remove(a.id)} className="text-rose-400">Delete</button>
              : <span className="text-emerald-400">Triggered</span>}
          </li>
        ))}
        {mine.length === 0 && <li className="py-2 text-sm text-slate-500">No alerts for {symbol} yet.</li>}
      </ul>
    </Card>
  );
}
