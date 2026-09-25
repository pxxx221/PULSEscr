import { TickerData } from "../types";

export interface BookWall {
  symbol: string;
  side: "bid" | "ask";
  price: number;
  notional: number;
  ageSeconds: number;
  relativeSize: number;
  distancePercent: number;
  status: "observing" | "confirmed";
}

type SeenWall = { firstSeen: number; lastSeen: number; minNotional: number; observations: number };
type BookSide = [string, string][];

// The partial depth stream is a succession of book snapshots. It cannot identify
// individual orders or prove that a participant will not cancel a displayed wall.
export class OrderBookWallTracker {
  private seen = new Map<string, SeenWall>();
  private mids = new Map<string, { price: number; at: number }[]>();

  clear(): void {
    this.seen.clear();
    this.mids.clear();
  }

  update(symbol: string, bidsRaw: BookSide, asksRaw: BookSide, market: TickerData, now = Date.now()): BookWall[] {
    const parse = (rows: BookSide) => rows.map(([p, q]) => ({ price: Number(p), notional: Number(p) * Number(q) }))
      .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.notional) && row.price > 0 && row.notional > 0);
    const bids = parse(bidsRaw);
    const asks = parse(asksRaw);
    if (!bids.length || !asks.length || !market?.volume) return [];
    const mid = (bids[0].price + asks[0].price) / 2;
    const history = this.mids.get(symbol) || [];
    history.push({ price: mid, at: now });
    while (history.length > 1 && history[0].at < now - 60_000) history.shift();
    this.mids.set(symbol, history);
    const changes = history.slice(1).map((point, i) => Math.abs(point.price / history[i].price - 1));
    const volatility = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    const volatilityFactor = Math.max(0.8, Math.min(2, 1 + volatility * 500));
    const all = [...bids, ...asks].map((row) => row.notional).sort((a, b) => a - b);
    const median = all[Math.floor(all.length / 2)] || 0;
    // The top-20 book is much thinner than eight seconds of total market turnover.
    // Scale by the square root of turnover, then demand an outlier vs nearby rows.
    const minNotional = Math.max(1_000, Math.sqrt(market.volume) * 0.2, median * 8) * volatilityFactor;
    const present = new Set<string>();
    const result: BookWall[] = [];
    for (const [side, rows] of [["bid", bids], ["ask", asks]] as const) {
      for (const row of rows) {
        const distancePercent = Math.abs(row.price / mid - 1) * 100;
        if (distancePercent > 1.5 || row.notional < minNotional) continue;
        const key = `${symbol}:${side}:${row.price}`;
        present.add(key);
        let entry = this.seen.get(key);
        if (!entry || now - entry.lastSeen > 3_000 || row.notional < entry.minNotional * 0.5) {
          entry = { firstSeen: now, lastSeen: now, minNotional: row.notional, observations: 1 };
        } else {
          entry.lastSeen = now;
          entry.minNotional = Math.min(entry.minNotional, row.notional);
          entry.observations++;
        }
        this.seen.set(key, entry);
        const ageSeconds = Math.floor((now - entry.firstSeen) / 1000);
        if (ageSeconds >= 3 && entry.observations >= 6 && entry.minNotional >= minNotional * 0.75) {
          result.push({ symbol, side, price: row.price, notional: row.notional,
            ageSeconds, relativeSize: row.notional / Math.max(median, 1), distancePercent,
            status: ageSeconds >= 30 && entry.observations >= 20 ? "confirmed" : "observing" });
        }
      }
    }
    for (const key of this.seen.keys()) {
      if (key.startsWith(`${symbol}:`) && !present.has(key)) this.seen.delete(key);
    }
    return result.sort((a, b) => b.notional - a.notional).slice(0, 4);
  }
}
