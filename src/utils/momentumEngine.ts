import { ScannerCandle } from "./liquidityScanner";

export interface MomentumSignal {
  ticker: string;
  direction: "LONG" | "SHORT";
  directionLabel: "🟢 ЛОНГ" | "🔴 ШОРТ";
  price: number;
  changePercent: number;    // e.g. +1.95 (%) in the moment
  durationMinutes: number;  // 1 (live 1m) or 2 (fast squeeze)
  ratioToAtr: number;       // e.g. 3.5 (x from normal ATR)
  atr14: number;
  volume24hM: number;       // e.g. 145.2 ($M)
  change24h: number;        // e.g. +5.40 (%)
  targetPool?: {
    type: "🔴 BSL" | "🟢 SSL";
    price: number;
    distancePercent: number; // e.g. 0.28 (%)
  } | null;
  timestamp: number;
}

/**
 * Calculate standard 14-period True Range ATR on 1m candles
 */
export function calculate1mATR(candles: ScannerCandle[], period = 14): number {
  if (candles.length < period + 1) {
    if (candles.length === 0) return 0;
    const sum = candles.reduce((acc, c) => acc + (c.high - c.low), 0);
    return sum / candles.length;
  }

  const endIdx = candles.length - 1;
  const startIdx = Math.max(1, endIdx - period);
  let trSum = 0;
  let count = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const prevClose = candles[i - 1].close;
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose)
    );
    trSum += tr;
    count++;
  }

  return count > 0 ? trSum / count : (candles[endIdx].high - candles[endIdx].low);
}

/**
 * Find nearby liquidity pool (BSL / SSL) within radius (default 0.40%)
 */
export function findNearbyLiquidityTarget(
  candles: ScannerCandle[],
  currentPrice: number,
  direction: "LONG" | "SHORT",
  maxRadiusPercent = 0.40
): { type: "🔴 BSL" | "🟢 SSL"; price: number; distancePercent: number } | null {
  if (candles.length < 15) return null;

  const lookback = Math.min(candles.length - 2, 50);
  let bestTarget: { type: "🔴 BSL" | "🟢 SSL"; price: number; distancePercent: number } | null = null;
  let minDistance = Infinity;

  if (direction === "LONG") {
    // For LONG: Find Swing Highs (BSL) above current price
    for (let i = candles.length - lookback; i < candles.length - 1; i++) {
      const high = candles[i].high;
      if (high > currentPrice) {
        const distPercent = ((high - currentPrice) / currentPrice) * 100;
        if (distPercent <= maxRadiusPercent && distPercent < minDistance) {
          minDistance = distPercent;
          bestTarget = {
            type: "🔴 BSL",
            price: high,
            distancePercent: parseFloat(distPercent.toFixed(2)),
          };
        }
      }
    }
  } else {
    // For SHORT: Find Swing Lows (SSL) below current price
    for (let i = candles.length - lookback; i < candles.length - 1; i++) {
      const low = candles[i].low;
      if (low < currentPrice) {
        const distPercent = ((currentPrice - low) / currentPrice) * 100;
        if (distPercent <= maxRadiusPercent && distPercent < minDistance) {
          minDistance = distPercent;
          bestTarget = {
            type: "🟢 SSL",
            price: low,
            distancePercent: parseFloat(distPercent.toFixed(2)),
          };
        }
      }
    }
  }

  return bestTarget;
}

/**
 * Real-time Price Momentum & Squeeze Detector Engine (Early 1m Trigger)
 * 
 * Rules:
 * 1. Filter Garbage: 24h Volume >= $30M
 * 2. Realtime 1m Candle Trigger (First 10-20 seconds):
 *    - Current forming 1m candle has moved >= 1.8% from its Open price:
 *      |Current_Price - Open_1m| / Open_1m * 100% >= 1.8%
 *    - Or rapid 2-minute squeeze >= 2.2%
 * 3. High Quality Candle Structure:
 *    - Candle body >= 70% of total range (High - Low)
 *    - Rejection wick in direction of move <= 30% (no top/bottom pinbars)
 */
export function detectPriceMomentum(
  candles: ScannerCandle[],
  ticker: string,
  volume24h: number, // USD (e.g. 45_000_000)
  change24h: number  // % (e.g. +3.2)
): MomentumSignal | null {
  const volume24hM = volume24h / 1_000_000;

  // Rule 1: 24h Volume >= $30M
  if (volume24hM < 30.0) {
    return null;
  }

  if (!candles || candles.length < 16) {
    return null;
  }

  const latest = candles[candles.length - 1];
  const currentPrice = latest.close;
  const open1m = latest.open;
  const high1m = latest.high;
  const low1m = latest.low;

  if (currentPrice <= 0 || open1m <= 0) {
    return null;
  }

  // Calculate 1m ATR(14)
  const atr14 = calculate1mATR(candles, 14);

  // 1. Check current live forming 1m candle (Instant Momentum Trigger >= 1.8%)
  const change1mPercent = ((currentPrice - open1m) / open1m) * 100;
  const absChange1m = Math.abs(change1mPercent);

  let triggered = false;
  let duration = 1;
  let percentChange = change1mPercent;
  let highest = high1m;
  let lowest = low1m;
  let startPrice = open1m;

  if (absChange1m >= 1.8) {
    // Instant 1m live candle trigger
    triggered = true;
    duration = 1;
    percentChange = change1mPercent;
    highest = high1m;
    lowest = low1m;
    startPrice = open1m;
  } else {
    // Also check fast 2-minute squeeze (current 1m + previous 1m candle >= 2.2%)
    // or freshly closed 1m candle (>= 1.8%) that is still holding its impulse range
    const prevCandle = candles[candles.length - 2];
    if (prevCandle && prevCandle.open > 0) {
      const change2mPercent = ((currentPrice - prevCandle.open) / prevCandle.open) * 100;
      const prev1mChange = ((prevCandle.close - prevCandle.open) / prevCandle.open) * 100;

      if (Math.abs(change2mPercent) >= 2.2) {
        triggered = true;
        duration = 2;
        percentChange = change2mPercent;
        highest = Math.max(high1m, prevCandle.high);
        lowest = Math.min(low1m, prevCandle.low);
        startPrice = prevCandle.open;
      } else if (Math.abs(prev1mChange) >= 1.8) {
        const currentVsPrevOpen = Math.abs(currentPrice - prevCandle.open);
        const prevNetMove = Math.abs(prevCandle.close - prevCandle.open);
        if (prevNetMove > 0 && currentVsPrevOpen / prevNetMove >= 0.75) {
          triggered = true;
          duration = 1;
          percentChange = prev1mChange;
          highest = Math.max(high1m, prevCandle.high);
          lowest = Math.min(low1m, prevCandle.low);
          startPrice = prevCandle.open;
        }
      }
    }
  }

  if (!triggered) {
    return null;
  }

  const isLong = percentChange > 0;
  const isShort = percentChange < 0;

  if (!isLong && !isShort) {
    return null;
  }

  // Rule 3: Quality Candle Structure (Body >= 70% of total range, no deep rejection)
  const netMove = Math.abs(currentPrice - startPrice);
  const fullRange = Math.max(highest - lowest, 1e-8);
  const bodyQualityRatio = netMove / fullRange;

  if (bodyQualityRatio < 0.70) {
    return null;
  }

  // Rejection check (pullback from high/low)
  if (isLong) {
    const maxGain = highest - startPrice;
    const pullback = highest - currentPrice;
    if (maxGain > 0 && pullback / maxGain > 0.30) {
      return null;
    }
  } else {
    const maxDrop = startPrice - lowest;
    const pullback = currentPrice - lowest;
    if (maxDrop > 0 && pullback / maxDrop > 0.30) {
      return null;
    }
  }

  const ratioToAtr = atr14 > 0 ? (netMove / atr14) / duration : 1.0;

  // Find nearby liquidity target within 0.40% in momentum direction
  const direction = isLong ? "LONG" : "SHORT";
  const targetPool = findNearbyLiquidityTarget(candles, currentPrice, direction, 0.40);

  return {
    ticker,
    direction,
    directionLabel: isLong ? "🟢 ЛОНГ" : "🔴 ШОРТ",
    price: currentPrice,
    changePercent: parseFloat(percentChange.toFixed(2)),
    durationMinutes: duration,
    ratioToAtr: parseFloat(ratioToAtr.toFixed(1)),
    atr14,
    volume24hM: parseFloat(volume24hM.toFixed(1)),
    change24h: parseFloat(change24h.toFixed(2)),
    targetPool,
    timestamp: Date.now(),
  };
}
