import { ScannerCandle } from "./liquidityScanner";

export type StructurePointType = "HH" | "HL" | "LH" | "LL";

export interface StructurePoint {
  id: string;
  type: StructurePointType;
  price: number;
  time: number;
  index: number;
}

export type BreakType = "BULLISH_CHOCH" | "BEARISH_CHOCH" | "BULLISH_BOS" | "BEARISH_BOS";

export interface StructureBreak {
  id: string;
  type: BreakType;
  label: string;
  pivotPrice: number;
  pivotTime: number;
  breakPrice: number;
  breakTime: number;
  breakIndex: number;
  isConfirmedBody: boolean; // True = Closed with candle body (Real CHoCH), False = Wick sweep
  displacementRatio: number; // Body / Full Range of break candle
  afterLiquiditySweep?: boolean;
}

export interface MarketStructureResult {
  trend: "BULLISH" | "BEARISH" | "SIDEWAYS";
  swings: StructurePoint[];
  breaks: StructureBreak[];
  currentKeyPivot: {
    price: number;
    time: number;
    type: "KEY_HL" | "KEY_LH";
    description: string;
  } | null;
}

/**
 * Detects Market Structure Swings and true CHoCH (Change of Character / Слом структуры)
 * 
 * Strict Scalper Rules:
 * 1. Fractals: Highs/Lows verified by left/right window (default 3 bars).
 * 2. Key Pivots: For Bearish CHoCH, the HL that produced the highest High. For Bullish CHoCH, the LH that produced the lowest Low.
 * 3. Body Close Rule: Must close with candle BODY beyond the pivot. Wicks without body close are marked as SWEEPS (liquidity grabs), not CHoCH.
 * 4. Displacement Filter: Break candle must have clean body (>= 50% range).
 */
export function detectMarketStructure(
  candles: ScannerCandle[],
  lookback = 3
): MarketStructureResult {
  if (!candles || candles.length < 15) {
    return { trend: "SIDEWAYS", swings: [], breaks: [], currentKeyPivot: null };
  }

  const n = candles.length;
  const swings: StructurePoint[] = [];

  // 1. Identify valid Swing Highs and Swing Lows
  for (let i = lookback; i < n - lookback; i++) {
    const current = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let offset = 1; offset <= lookback; offset++) {
      if (candles[i - offset].high >= current.high || candles[i + offset].high > current.high) {
        isSwingHigh = false;
      }
      if (candles[i - offset].low <= current.low || candles[i + offset].low < current.low) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) {
      swings.push({
        id: `sh-${current.time}-${i}`,
        type: "HH", // Will be classified relative to prior swings
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    if (isSwingLow) {
      swings.push({
        id: `sl-${current.time}-${i}`,
        type: "LL", // Will be classified relative to prior swings
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  // Sort swings chronologically
  swings.sort((a, b) => a.time - b.time);

  // 2. Classify swings into HH, HL, LH, LL
  let lastHigh: StructurePoint | null = null;
  let lastLow: StructurePoint | null = null;

  for (const s of swings) {
    if (s.price > (lastHigh?.price ?? -Infinity) && (!lastLow || s.price > lastLow.price)) {
      // It's a high
      if (lastHigh) {
        s.type = s.price > lastHigh.price ? "HH" : "LH";
      } else {
        s.type = "HH";
      }
      lastHigh = s;
    } else {
      // It's a low
      if (lastLow) {
        s.type = s.price > lastLow.price ? "HL" : "LL";
      } else {
        s.type = "LL";
      }
      lastLow = s;
    }
  }

  // 3. Track Structure Breaks (CHoCH / BOS)
  let activeTrend: "BULLISH" | "BEARISH" = "BULLISH";
  const breaks: StructureBreak[] = [];

  let keyHigherLow: StructurePoint | null = null;
  let keyLowerHigh: StructurePoint | null = null;
  let highestHigh: StructurePoint | null = null;
  let lowestLow: StructurePoint | null = null;

  // Track candles from the first swing
  const startCandleIdx = swings.length > 0 ? swings[0].index : 0;

  for (let i = startCandleIdx; i < n; i++) {
    const c = candles[i];
    const candleBodyMin = Math.min(c.open, c.close);
    const candleBodyMax = Math.max(c.open, c.close);
    const candleRange = Math.max(c.high - c.low, 1e-8);
    const displacement = Math.abs(c.close - c.open) / candleRange;

    // Update active swings up to candle i
    const availableSwings = swings.filter((s) => s.index <= i);
    const highs = availableSwings.filter((s) => s.type === "HH" || s.type === "LH");
    const lows = availableSwings.filter((s) => s.type === "HL" || s.type === "LL");

    if (highs.length > 0) {
      const latestHigh = highs[highs.length - 1];
      if (!highestHigh || latestHigh.price > highestHigh.price) {
        highestHigh = latestHigh;
        // The Key HL is the swing low that formed right before this peak
        const priorLows = lows.filter((l) => l.index < latestHigh.index);
        if (priorLows.length > 0) {
          keyHigherLow = priorLows[priorLows.length - 1];
        }
      }
    }

    if (lows.length > 0) {
      const latestLow = lows[lows.length - 1];
      if (!lowestLow || latestLow.price < lowestLow.price) {
        lowestLow = latestLow;
        // The Key LH is the swing high that formed right before this trough
        const priorHighs = highs.filter((h) => h.index < latestLow.index);
        if (priorHighs.length > 0) {
          keyLowerHigh = priorHighs[priorHighs.length - 1];
        }
      }
    }

    // CHECK FOR BEARISH CHoCH (Слом восходящей структуры в шорт)
    if (activeTrend === "BULLISH" && keyHigherLow && c.time > keyHigherLow.time) {
      // Body close below the key higher low
      if (c.close < keyHigherLow.price) {
        // Confirmed Bearish CHoCH
        breaks.push({
          id: `choch-bear-${c.time}`,
          type: "BEARISH_CHOCH",
          label: "CHoCH 🔴",
          pivotPrice: keyHigherLow.price,
          pivotTime: keyHigherLow.time,
          breakPrice: c.close,
          breakTime: c.time,
          breakIndex: i,
          isConfirmedBody: true,
          displacementRatio: parseFloat(displacement.toFixed(2)),
        });

        // Flip trend to Bearish
        activeTrend = "BEARISH";
        lowestLow = null; // reset for new bearish cycle
        keyLowerHigh = highestHigh; // the previous peak becomes the primary protected high
      }
    }

    // CHECK FOR BULLISH BOS (Продолжение восходящего тренда)
    else if (activeTrend === "BULLISH" && highestHigh && c.time > highestHigh.time) {
      if (c.close > highestHigh.price && i > highestHigh.index + 2) {
        breaks.push({
          id: `bos-bull-${c.time}`,
          type: "BULLISH_BOS",
          label: "BOS 🟢",
          pivotPrice: highestHigh.price,
          pivotTime: highestHigh.time,
          breakPrice: c.close,
          breakTime: c.time,
          breakIndex: i,
          isConfirmedBody: true,
          displacementRatio: parseFloat(displacement.toFixed(2)),
        });
      }
    }

    // CHECK FOR BULLISH CHoCH (Слом нисходящей структуры в лонг)
    else if (activeTrend === "BEARISH" && keyLowerHigh && c.time > keyLowerHigh.time) {
      // Body close above the key lower high
      if (c.close > keyLowerHigh.price) {
        // Confirmed Bullish CHoCH
        breaks.push({
          id: `choch-bull-${c.time}`,
          type: "BULLISH_CHOCH",
          label: "CHoCH 🟢",
          pivotPrice: keyLowerHigh.price,
          pivotTime: keyLowerHigh.time,
          breakPrice: c.close,
          breakTime: c.time,
          breakIndex: i,
          isConfirmedBody: true,
          displacementRatio: parseFloat(displacement.toFixed(2)),
        });

        // Flip trend to Bullish
        activeTrend = "BULLISH";
        highestHigh = null; // reset for new bullish cycle
        keyHigherLow = lowestLow; // the previous bottom becomes the primary protected low
      }
    }

    // CHECK FOR BEARISH BOS (Продолжение нисходящего тренда)
    else if (activeTrend === "BEARISH" && lowestLow && c.time > lowestLow.time) {
      if (c.close < lowestLow.price && i > lowestLow.index + 2) {
        breaks.push({
          id: `bos-bear-${c.time}`,
          type: "BEARISH_BOS",
          label: "BOS 🔴",
          pivotPrice: lowestLow.price,
          pivotTime: lowestLow.time,
          breakPrice: c.close,
          breakTime: c.time,
          breakIndex: i,
          isConfirmedBody: true,
          displacementRatio: parseFloat(displacement.toFixed(2)),
        });
      }
    }
  }

  // Determine current key protected level to defend trend
  let currentKeyPivot: MarketStructureResult["currentKeyPivot"] = null;
  if (activeTrend === "BULLISH" && keyHigherLow) {
    currentKeyPivot = {
      price: keyHigherLow.price,
      time: keyHigherLow.time,
      type: "KEY_HL",
      description: "Защитный минимум тренда (HL). Закрытие ниже = Шортовый CHoCH",
    };
  } else if (activeTrend === "BEARISH" && keyLowerHigh) {
    currentKeyPivot = {
      price: keyLowerHigh.price,
      time: keyLowerHigh.time,
      type: "KEY_LH",
      description: "Защитный максимум тренда (LH). Закрытие выше = Лонговый CHoCH",
    };
  }

  return {
    trend: activeTrend,
    swings: swings.slice(-30), // keep recent 30 swings for clean display
    breaks: breaks.slice(-10), // keep recent 10 structure breaks
    currentKeyPivot,
  };
}

export interface ChochSignal {
  ticker: string;
  direction: "LONG" | "SHORT";
  directionLabel: string;
  breakType: "BULLISH_CHOCH" | "BEARISH_CHOCH";
  pivotPrice: number;
  pivotType: "HL" | "LH";
  breakPrice: number;
  displacementPercent: number;
  volume24hM: number;
  change24h: number;
  breakTime: number;
  timestamp: number;
}

/**
 * Detects if a fresh confirmed CHoCH (Market Structure Shift) just occurred
 * on the recent 5m candle (within last 1-2 bars)
 */
export function detectRecentChochSignal(
  candles: ScannerCandle[],
  ticker: string,
  volume24h: number,
  change24h: number
): ChochSignal | null {
  const volume24hM = volume24h / 1_000_000;
  if (volume24hM < 25.0) {
    return null; // Ignore low liquidity noise
  }

  if (!candles || candles.length < 25) {
    return null;
  }

  const structure = detectMarketStructure(candles, 3);
  const chochBreaks = structure.breaks.filter(
    (b) => (b.type === "BULLISH_CHOCH" || b.type === "BEARISH_CHOCH") && b.isConfirmedBody
  );

  if (chochBreaks.length === 0) return null;

  // Find the latest CHoCH
  const latestChoch = chochBreaks[chochBreaks.length - 1];
  const lastIndex = candles.length - 1;

  // Must have occurred on the latest forming candle or the immediately preceding closed 5m candle
  if (latestChoch.breakIndex < lastIndex - 1) {
    return null;
  }

  const isLong = latestChoch.type === "BULLISH_CHOCH";

  return {
    ticker,
    direction: isLong ? "LONG" : "SHORT",
    directionLabel: isLong ? "🟢 БЫЧИЙ (В ЛОНГ)" : "🔴 МЕДВЕЖИЙ (В ШОРТ)",
    breakType: isLong ? "BULLISH_CHOCH" : "BEARISH_CHOCH",
    pivotPrice: latestChoch.pivotPrice,
    pivotType: isLong ? "LH" : "HL",
    breakPrice: latestChoch.breakPrice,
    displacementPercent: Math.round(latestChoch.displacementRatio * 100),
    volume24hM: parseFloat(volume24hM.toFixed(1)),
    change24h: parseFloat(change24h.toFixed(2)),
    breakTime: latestChoch.breakTime,
    timestamp: Date.now(),
  };
}

