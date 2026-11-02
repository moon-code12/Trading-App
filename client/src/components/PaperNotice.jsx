import { useEffect, useState } from 'react';
import { api, money } from '../api.js';

// Used until the server's own wording arrives (or if it cannot be reached).
const FALLBACK = 'Paper trading is a simulation. Real markets have live order books, different spreads, fees, slippage, delays, liquidity and '
  + 'outages, and your emotions and risk are different when real money is at stake, so real results can differ from these results, often '
  + 'for the worse. Prices, spreads, fees and fills here are simplified models, not an offer or a prediction.';

let cached = null;

// How the simulation currently behaves, from the server. Fetched once and shared.
export function useSimulation() {
  const [sim, setSim] = useState(cached);
  useEffect(() => {
    if (cached) return undefined;
    let live = true;
    api('/simulation').then((d) => { cached = d; if (live) setSim(d); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return sim;
}

const bps = (n) => `${Number(n.toFixed(2))} bps (${Number((n / 100).toFixed(3))}%)`;

// A visible reminder that paper-trading results can differ from real trading. With `category`, it also lists
// what the simulation does for that kind of market.
export default function PaperNotice({ category, className = '' }) {
  const sim = useSimulation();
  const c = sim?.categories?.[category];
  return (
    <aside aria-label="Paper trading notice" className={`rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300 ${className}`}>
      <p><b className="text-slate-100">Paper trading is not real trading.</b> {sim?.notice ?? FALLBACK}</p>
      {sim && (
        <details className="mt-2">
          <summary className="cursor-pointer text-emerald-400">How orders are simulated here</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Buyers pay the <b>ask</b> and sellers receive the <b>bid</b>; the gap between them is the spread.</li>
            <li>Each fill can carry a <b>trading fee</b>, and market-style orders can suffer <b>slippage</b> that grows with order size.</li>
            <li>Orders take a short <b>execution delay</b> to arrive and large orders fill in <b>parts</b> as simulated liquidity allows.</li>
            <li>Stocks, forex and commodities follow <b>market hours</b>: orders wait while the market is closed, and prices can <b>gap</b> at the open. Crypto trades at all hours.</li>
            <li>Each market has its own <b>quantity rules</b> (whole shares, lots, minimum sizes).</li>
            {c && (
              <li>
                For this market: spread about {bps(c.spreadBps)}, {c.feeBps ? `fee ${bps(c.feeBps)} (minimum ${money(c.minFee)})` : 'no fee (the spread is the cost)'},
                slippage up to {bps(c.slippageBps[1])}, delay {c.latencyMs[0]}-{c.latencyMs[1]} ms
                {c.gapBps ? `, opening gaps up to about ${bps(c.gapBps)}` : ''}.
              </li>
            )}
            {!sim.marketHours && <li>This server is running the <b>ideal</b> profile (no costs, delays or market hours), used for testing.</li>}
          </ul>
        </details>
      )}
    </aside>
  );
}
