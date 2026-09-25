import { TickerData, BookWall } from "../types";

export type { BookWall };

type SeenWall = { firstSeen: number; lastSeen: number; minNotional: number; observations: number; lastNotional: number };
type BookSide = [string, string][];

// Grace period: walls that temporarily drop out of the top-20 depth snapshot
// are kept for GRACE_MS before being deleted. This prevents age resets caused
// by order-book flickering on volatile pairs where 20 levels cover < 0.3%.
const GRACE_MS = 6_000;

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

    // Rolling 60s volatility to adapt thresholds
    const history = this.mids.get(symbol) || [];
    history.push({ price: mid, at: now });
    while (history.length > 1 && history[0].at < now - 60_000) history.shift();
    this.mids.set(symbol, history);
    const changes = history.slice(1).map((point, i) => Math.abs(point.price / history[i].price - 1));
    const volatility = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    const volatilityFactor = Math.max(0.8, Math.min(2, 1 + volatility * 500));

    const all = [...bids, ...asks].map((row) => row.notional).sort((a, b) => a - b);
    const median = all[Math.floor(all.length / 2)] || 0;
    // Calibrated for both Bitcoin and active Altcoins:
    const minNotional = Math.max(15_000, Math.sqrt(market.volume) * 0.18, median * 6) * volatilityFactor;

    // Track which keys are present in this snapshot
    const present = new Set<string>();
    const result: BookWall[] = [];

    for (const [side, rows] of [["bid", bids], ["ask", asks]] as const) {
      for (const row of rows) {
        const distancePercent = Math.abs(row.price / mid - 1) * 100;
        if (distancePercent > 2.5 || row.notional < minNotional) continue;
        const key = `${symbol}:${side}:${row.price}`;
        present.add(key);
        let entry = this.seen.get(key);
        if (!entry || now - entry.lastSeen > GRACE_MS || row.notional < entry.minNotional * 0.4) {
          // New wall or came back after grace period expired or size dropped significantly
          entry = { firstSeen: now, lastSeen: now, minNotional: row.notional, observations: 1, lastNotional: row.notional };
        } else {
          entry.lastSeen = now;
          entry.minNotional = Math.min(entry.minNotional, row.notional);
          entry.lastNotional = row.notional;
          entry.observations++;
        }
        this.seen.set(key, entry);
        const ageSeconds = Math.floor((now - entry.firstSeen) / 1000);
        if (ageSeconds >= 2 && entry.observations >= 3 && entry.minNotional >= minNotional * 0.55) {
          const status = ageSeconds >= 180 ? "solid" : ageSeconds >= 60 ? "confirmed" : "observing";
          result.push({
            symbol,
            side,
            price: row.price,
            notional: row.notional,
            ageSeconds,
            relativeSize: row.notional / Math.max(median, 1),
            distancePercent,
            status,
          });
        }
      }
    }

    // Grace period cleanup: only delete entries that have been absent for > GRACE_MS
    for (const [key, entry] of this.seen.entries()) {
      if (key.startsWith(`${symbol}:`) && !present.has(key)) {
        if (now - entry.lastSeen > GRACE_MS) {
          this.seen.delete(key);
        } else {
          // Wall is within grace period — keep it alive and emit it with last known data
          const ageSeconds = Math.floor((now - entry.firstSeen) / 1000);
          if (ageSeconds >= 2 && entry.observations >= 3 && entry.minNotional >= minNotional * 0.55) {
            const parts = key.split(":");
            const side = parts[parts.length - 2] as "bid" | "ask";
            const price = Number(parts[parts.length - 1]);
            const distancePercent = Math.abs(price / mid - 1) * 100;
            if (distancePercent <= 2.5) {
              const status = ageSeconds >= 180 ? "solid" : ageSeconds >= 60 ? "confirmed" : "observing";
              result.push({
                symbol,
                side,
                price,
                notional: entry.lastNotional,
                ageSeconds,
                relativeSize: entry.lastNotional / Math.max(median, 1),
                distancePercent,
                status,
              });
            }
          }
        }
      }
    }

    return result.sort((a, b) => b.notional - a.notional).slice(0, 8);
  }
}
