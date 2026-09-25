export interface ScannerCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// Binance REST includes the candle currently forming. Only closed 5m candles
// may confirm a swing or invalidate an existing level.
export function closedFiveMinuteCandles<T extends ScannerCandle>(candles: T[], now = Date.now()): T[] {
  const cutoff = Math.floor(now / 1000);
  return candles.filter((c) => c.time + 300 <= cutoff);
}

// 1. BLACKLIST OF STABLECOINS & FIAT WRAPPERS
export const BLACKLISTED_SYMBOLS: readonly string[] = [
  "USDC",
  "FDUSD",
  "TUSD",
  "USDP",
  "DAI",
  "EUR",
  "BUSD",
  "WBTC",
  "USDE",
  "USTC",
  "EURI",
  "AEUR",
];

// 2. BLACKLIST OF SYNTHETIC, COMMODITY, INDEX & TRADITIONAL ASSETS (STRICT BAN)
export const BANNED_NON_CRYPTO_LIST: readonly string[] = [
  "NVDA",
  "AAPL",
  "TSLA",
  "AMZN",
  "MSFT",
  "SPCX",
  "SPX",
  "NDX",
  "BZ",
  "CL",
  "XAU",
  "XAG",
  "MSTR",
];

export const SYNTHETIC_COMMODITY_BLACKLIST: readonly string[] = BANNED_NON_CRYPTO_LIST;

export interface CleanSwingTouch {
  index: number;
  time: number;
  price: number;
}

export interface CleanScalperLevel {
  id: string;
  type: "BSL" | "SSL";
  category: "SWING_MACRO" | "LOCAL_SHELF";
  categoryLabel: "Дневной" | "Полка";
  price: number; // САМЫЙ ВЫСОКИЙ пик для BSL, САМЫЙ НИЗКИЙ для SSL
  touches: number; // >= 2
  touchesLabel: "2K" | "3K+";
  firstIndex: number;
  firstTime: number;
  lastIndex: number;
  lastTime: number;
  touchPoints: CleanSwingTouch[];
  distancePercent: number;
  badgeTitle: string; // e.g. "🟣 $1.1732 [2K Дневной]"
  strength: "STRONG" | "MEDIUM" | "WEAK";
  tolerancePercent?: number;
  atrPercent?: number;
}

// Live visibility is deliberately separate from confirmed-candle detection:
// a broken level disappears immediately, but is not permanently deleted on
// an intrabar spike. The next closed 5m candle decides whether it survived.
export function isLiquidityLevelActive(
  level: Pick<CleanScalperLevel, "type" | "price">,
  marketPrice: number
): boolean {
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return true;
  if (level.type === "BSL" && marketPrice > level.price * 1.0025) return false;
  if (level.type === "SSL" && marketPrice < level.price * 0.9975) return false;
  return Math.abs(level.price - marketPrice) / marketPrice <= 0.10;
}

/**
 * Checks if a ticker/symbol is in the blacklisted stablecoins/fiat pairs.
 */
export function isBlacklistedTicker(symbol: string): boolean {
  if (!symbol) return true;
  const clean = symbol.toUpperCase().replace(/[\/_]/g, "");
  
  for (const blacklisted of BLACKLISTED_SYMBOLS) {
    if (clean === blacklisted || clean.startsWith(blacklisted)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a symbol contains any non-crypto, stock, commodity, or index keywords.
 */
export function isNonCryptoOrSynthetic(symbol: string): boolean {
  if (!symbol) return true;
  const upper = symbol.toUpperCase().replace(/[\/_]/g, "");
  const base = upper.replace("USDT", "").replace("USDC", "").replace("FDUSD", "").replace("BUSD", "");

  for (const banned of BANNED_NON_CRYPTO_LIST) {
    if (banned === "BZ" || banned === "CL") {
      // Must not match crude oil or brent (e.g. BZUSDT, CLUSDT)
      if (base === banned || base.startsWith(banned) || upper.startsWith(banned)) {
        return true;
      }
    } else {
      // Stocks, precious metals, indexes: NVDA, AAPL, TSLA, AMZN, MSFT, SPCX, SPX, NDX, XAU, XAG, MSTR
      if (upper.includes(banned) || base.includes(banned)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if a symbol is in the synthetic, commodity, or equity blacklist.
 */
export function isSyntheticOrCommodity(symbol: string): boolean {
  return isNonCryptoOrSynthetic(symbol);
}

/**
 * Validates whether a ticker is a pure crypto asset (USDT perpetual) and not a synthetic/stock/commodity.
 */
export function isPureCryptoTicker(symbol: string): boolean {
  if (!symbol) return false;
  const upper = symbol.toUpperCase().replace(/[\/_]/g, "");
  if (!upper.endsWith("USDT")) return false;
  const base = upper.replace("USDT", "");
  
  if (isNonCryptoOrSynthetic(upper)) return false;
  if (isBlacklistedTicker(base)) return false;
  return true;
}

/**
 * Filter function for Hot Volatile Altcoins:
 * 1. Volume24h >= $100M
 * 2. In Play Volatility: |Change24h| >= 4.5%
 * 3. Pure crypto USDT futures: excludes BZ, CL, MSTR, XAU, XAG, SPCX, NVDA, AAPL,
 *    excludes stablecoin/fiat pairs, and excludes heavyweights (BTC, ETH).
 */
export function filterHotVolatileAltTickers<T extends { symbol: string; volume: number; change: number }>(
  tickers: T[]
): T[] {
  const minVol = 35_000_000; // $35M (активные ликвидные альткоины)

  return tickers.filter((t) => {
    if (!t || !t.symbol || typeof t.volume !== "number") return false;

    // 1. Volume >= $35M
    if (t.volume < minVol) return false;

    // 2. Активность: |Change24h| >= 1.8%
    if (Math.abs(t.change) < 1.8) return false;

    // Clean base ticker
    const raw = t.symbol.toUpperCase().replace(/[\/_]/g, "");
    if (!raw.endsWith("USDT")) return false;
    const base = raw.replace("USDT", "");

    // Must be pure crypto (exclude non-crypto, equities, commodities, stables)
    if (!isPureCryptoTicker(raw)) return false;

    // Sluggish heavyweights (BTC, ETH)
    if (base === "BTC" || base === "ETH") return false;

    return true;
  });
}

/**
 * Calculates ATR(14) over the provided candles.
 */
export function calculateATR14(
  candles: ScannerCandle[],
  minAtrPercent: number = 0.15
): {
  atr: number;
  atrPercent: number;
  isVolatileEnough: boolean;
} {
  if (!candles || candles.length < 15) {
    return { atr: 0, atrPercent: 0, isVolatileEnough: false };
  }

  const period = 14;
  const trValues: number[] = [];
  const startIdx = candles.length - period;

  for (let i = startIdx; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - prev.close);
    const tr3 = Math.abs(current.low - prev.close);
    const tr = Math.max(tr1, tr2, tr3);
    trValues.push(tr);
  }

  const sumTR = trValues.reduce((acc, val) => acc + val, 0);
  const atr = sumTR / period;
  const currentClose = candles[candles.length - 1].close;
  
  const atrPercent = currentClose > 0 ? (atr / currentClose) * 100 : 0;
  const isVolatileEnough = atrPercent >= minAtrPercent;

  return {
    atr,
    atrPercent,
    isVolatileEnough,
  };
}

/**
 * CLEAN SCALPER LEVELS ENGINE v1
 * 
 * Шаг 1: Поиск опорных вершин (Swing Points на 5m):
 * - Swing High: High строго выше High 3 свечей слева и 3 свечей справа.
 * - Swing Low: Low строго ниже Low 3 свечей слева и 3 свечей справа.
 * 
 * Шаг 2: Склейка в уровень (Минимум 2 касания):
 * 1. Количество касаний: >= 2 независимых пика.
 * 2. Погрешность цен пиков: |Peak1 - Peak2| / Peak1 <= 0.20%.
 * 3. Наличие отката между ударами: между Peak1 и Peak2 прошло не менее 6 свечей,
 *    и цена между ними откатывала минимум на 0.4% вглубь диапазона.
 * 4. Отсутствие распила (Чистый потолок/пол): между касаниями ни одна свеча не закрывалась телом за линией уровня.
 * 
 * Шаг 3: Жизненный цикл и актуальность:
 * - Уровень берется по цене САМОГО ВЫСОКОГО касания (для BSL) или САМОГО НИЗКОГО (для SSL).
 * - Если цена пробивает уровень телом закрытия свечи более чем на 0.25% — уровень удаляется.
 * - Оставляются только уровни, сформированные в пределах последних 150 свечей.
 */
export function findCleanSwingLevels(candles5m: ScannerCandle[]): CleanScalperLevel[] {
  if (!candles5m || candles5m.length < 15) {
    return [];
  }

  // Глубина истории: 200 свечей на 5m (~16.5 часов)
  // Позволяет находить как свежие консолидации, так и мощные дневные двойные/тройные вершины
  const historyLimit = 200;
  const startIndex = Math.max(0, candles5m.length - historyLimit);
  const candles = candles5m.slice(startIndex);
  const n = candles.length;
  const currentPrice = candles[n - 1].close;

  if (currentPrice <= 0) return [];

  // ==========================================
  // ШАГ 1: Поиск значимых фрактальных вершин (Fractal Swing Points)
  // ==========================================
  // Опорная вершина должна быть выше (или ниже) 3 свечей слева и 3 свечей справа (окно 35+ минут)
  // Это отсекает мелкий свечной шум и выделяет реальные пики графика
  const rawHighs: CleanSwingTouch[] = [];
  const rawLows: CleanSwingTouch[] = [];

  for (let i = 3; i < n - 3; i++) {
    const cur = candles[i];

    const isSwingHigh =
      cur.high >= candles[i - 1].high &&
      cur.high >= candles[i - 2].high &&
      cur.high >= candles[i - 3].high &&
      cur.high >= candles[i + 1].high &&
      cur.high >= candles[i + 2].high &&
      cur.high >= candles[i + 3].high &&
      (cur.high > candles[i - 1].high || cur.high > candles[i + 1].high);

    if (isSwingHigh) {
      rawHighs.push({
        index: startIndex + i,
        time: cur.time,
        price: cur.high,
      });
    }

    const isSwingLow =
      cur.low <= candles[i - 1].low &&
      cur.low <= candles[i - 2].low &&
      cur.low <= candles[i - 3].low &&
      cur.low <= candles[i + 1].low &&
      cur.low <= candles[i + 2].low &&
      cur.low <= candles[i + 3].low &&
      (cur.low < candles[i - 1].low || cur.low < candles[i + 1].low);

    if (isSwingLow) {
      rawLows.push({
        index: startIndex + i,
        time: cur.time,
        price: cur.low,
      });
    }
  }

  // ==========================================
  // ШАГ 1.5: Консолидация вершин (Один гребень волны = ОДНА вершина)
  // ==========================================
  // Если две вершины находятся близко (до 10 свечей = 50 мин) и между ними нет глубокого отката
  // (менее 0.65%), они представляют собой ОДИН И ТОТ ЖЕ пик (две соседние свечи на хаях).
  // Склеиваем их в одну точку, выбирая наивысшую для BSL и наинизшую для SSL.
  const consolidateTouches = (touches: CleanSwingTouch[], type: "BSL" | "SSL"): CleanSwingTouch[] => {
    if (touches.length <= 1) return touches;
    const sorted = [...touches].sort((a, b) => a.index - b.index);
    const result: CleanSwingTouch[] = [];

    for (const t of sorted) {
      if (result.length === 0) {
        result.push(t);
        continue;
      }

      const prev = result[result.length - 1];
      const gap = t.index - prev.index;

      if (gap <= 10) {
        const localStart = Math.max(0, prev.index - startIndex);
        const localEnd = Math.min(n - 1, t.index - startIndex);

        if (type === "BSL") {
          let minLow = Infinity;
          for (let idx = localStart; idx <= localEnd; idx++) {
            if (candles[idx].low < minLow) minLow = candles[idx].low;
          }
          const peak = Math.max(prev.price, t.price);
          const pullback = (peak - minLow) / peak;

          if (pullback < 0.0065) {
            if (t.price > prev.price) {
              result[result.length - 1] = t;
            }
            continue;
          }
        } else {
          let maxHigh = -Infinity;
          for (let idx = localStart; idx <= localEnd; idx++) {
            if (candles[idx].high > maxHigh) maxHigh = candles[idx].high;
          }
          const trough = Math.min(prev.price, t.price);
          const bounce = (maxHigh - trough) / trough;

          if (bounce < 0.0065) {
            if (t.price < prev.price) {
              result[result.length - 1] = t;
            }
            continue;
          }
        }
      }

      result.push(t);
    }
    return result;
  };

  const swingHighs = consolidateTouches(rawHighs, "BSL");
  const swingLows = consolidateTouches(rawLows, "SSL");

  const validLevels: CleanScalperLevel[] = [];

  // ==========================================
  // ДИНАМИЧЕСКИЙ РАСЧЕТ ДОПУСКА (Dynamic ATR Tolerance)
  // ==========================================
  const { atrPercent } = calculateATR14(candles5m);

  // Для пробоя нужны почти совпадающие экстремумы, а не широкая ценовая зона.
  // ATR слегка адаптирует допуск, но он остаётся в пределах 0.02–0.05%.
  const tolerance = Math.max(0.02, Math.min(atrPercent * 0.15, 0.05));

  const isTouchMatch = (peak1Price: number, peak2Price: number): boolean => {
    return (Math.abs(peak1Price - peak2Price) / peak1Price) * 100 <= tolerance;
  };

  // ==========================================
  // ШАГ 2 & 3: BSL (Лонговые уровни сопротивления / Двойные и тройные вершины)
  // ==========================================
  const usedHighIndices = new Set<number>();

  for (let i = 0; i < swingHighs.length; i++) {
    if (usedHighIndices.has(swingHighs[i].index)) continue;

    const basePoint = swingHighs[i];
    // BSL может быть ТОЛЬКО выше текущей цены
    if (basePoint.price <= currentPrice * 1.0005) continue;

    let candidateGroup: CleanSwingTouch[] = [basePoint];

    for (let j = i + 1; j < swingHighs.length; j++) {
      const candidate = swingHighs[j];
      if (candidate.price <= currentPrice * 1.0005) continue;

      if (isTouchMatch(basePoint.price, candidate.price)) {
        const allFit = candidateGroup.every(
          (p) => isTouchMatch(p.price, candidate.price)
        );
        if (allFit) {
          candidateGroup.push(candidate);
        }
      }
    }

    // Дополнительная консолидация точек группы (убираем случайные соседние пики)
    candidateGroup = consolidateTouches(candidateGroup, "BSL");

    // Условие: Количество касаний >= 2
    if (candidateGroup.length < 2) continue;

    candidateGroup.sort((a, b) => a.index - b.index);

    const levelPrice = Math.max(...candidateGroup.map((t) => t.price));
    // Строгая проверка: уровень BSL строго над текущей ценой
    if (levelPrice <= currentPrice * 1.001) continue;

    const firstLocalIdx = Math.max(0, candidateGroup[0].index - startIndex);

    // ПРОВЕРКА ЧИСТОТЫ:
    // Ни одна свеча между первым касанием и текущим моментом не должна закрываться выше уровня телом более чем на 0.25%
    let bodyBreached = false;
    for (let idx = firstLocalIdx; idx < n; idx++) {
      if (candles[idx].close > levelPrice * 1.0025) {
        bodyBreached = true;
        break;
      }
    }
    if (bodyBreached) continue;

    // ПРОВЕРКА СТРУКТУРЫ И КАТЕГОРИИ (Дневной макро-уровень или Локальная полка):
    let structureValid = true;
    let maxPullbackBetween = 0;
    let maxGapBetween = 0;

    for (let k = 0; k < candidateGroup.length - 1; k++) {
      const t1 = candidateGroup[k];
      const t2 = candidateGroup[k + 1];

      const candleGap = t2.index - t1.index;
      if (candleGap < 4 || candleGap > 180) {
        structureValid = false;
        break;
      }
      if (candleGap > maxGapBetween) maxGapBetween = candleGap;

      let minLowBetween = Infinity;
      const localStart = Math.max(0, t1.index - startIndex);
      const localEnd = Math.min(n - 1, t2.index - startIndex);

      for (let idx = localStart; idx <= localEnd; idx++) {
        if (candles[idx].low < minLowBetween) {
          minLowBetween = candles[idx].low;
        }
      }

      const pullback = (levelPrice - minLowBetween) / levelPrice;
      if (pullback > maxPullbackBetween) maxPullbackBetween = pullback;

      // Минимальный откат между любыми точками
      if (pullback < 0.0035) {
        structureValid = false;
        break;
      }
    }
    if (!structureValid) continue;

    // Определение категории:
    // Если откат >= 1.0% или расстояние >= 24 свечей (~2 часа) -> ДНЕВНОЙ ЭКСТРЕМУМ (Double/Triple Top)
    // Компактная полка тоже подтверждается двумя независимыми касаниями.
    const isMacroSwing = maxPullbackBetween >= 0.010 || maxGapBetween >= 24;

    const category: "SWING_MACRO" | "LOCAL_SHELF" = isMacroSwing ? "SWING_MACRO" : "LOCAL_SHELF";
    const categoryLabel: "Дневной" | "Полка" = isMacroSwing ? "Дневной" : "Полка";

    // Помечаем использованные вершины
    candidateGroup.forEach((t) => usedHighIndices.add(t.index));

    const touches = candidateGroup.length;
    const touchesLabel: "2K" | "3K+" = touches >= 3 ? "3K+" : "2K";
    const distancePercent = Math.abs((levelPrice - currentPrice) / currentPrice) * 100;

    // Дистанция актуальности пула: до 10.0% (позволяет видеть ключевые лонговые уровни дня)
    if (distancePercent > 10.0) continue;

    const formattedPrice = levelPrice >= 1000 ? levelPrice.toFixed(2) : levelPrice >= 1 ? levelPrice.toFixed(4) : levelPrice.toFixed(6);

    validLevels.push({
      id: `clean-bsl-${levelPrice.toFixed(4)}-${candidateGroup[0].index}`,
      type: "BSL",
      category,
      categoryLabel,
      price: levelPrice,
      touches,
      touchesLabel,
      firstIndex: candidateGroup[0].index,
      firstTime: candidateGroup[0].time,
      lastIndex: candidateGroup[candidateGroup.length - 1].index,
      lastTime: candidateGroup[candidateGroup.length - 1].time,
      touchPoints: candidateGroup,
      distancePercent: parseFloat(distancePercent.toFixed(2)),
      badgeTitle: `🟣 $${formattedPrice} [${touchesLabel} ${categoryLabel}]`,
      strength: touches >= 3 ? "STRONG" : "MEDIUM",
      tolerancePercent: parseFloat(tolerance.toFixed(3)),
      atrPercent: parseFloat(atrPercent.toFixed(2)),
    });
  }

  // ==========================================
  // ШАГ 2 & 3: SSL (Шортовые уровни поддержки / Двойные и тройные донья)
  // ==========================================
  const usedLowIndices = new Set<number>();

  for (let i = 0; i < swingLows.length; i++) {
    if (usedLowIndices.has(swingLows[i].index)) continue;

    const basePoint = swingLows[i];
    // SSL может быть ТОЛЬКО ниже текущей цены
    if (basePoint.price >= currentPrice * 0.9995) continue;

    let candidateGroup: CleanSwingTouch[] = [basePoint];

    for (let j = i + 1; j < swingLows.length; j++) {
      const candidate = swingLows[j];
      if (candidate.price >= currentPrice * 0.9995) continue;

      if (isTouchMatch(basePoint.price, candidate.price)) {
        const allFit = candidateGroup.every(
          (p) => isTouchMatch(p.price, candidate.price)
        );
        if (allFit) {
          candidateGroup.push(candidate);
        }
      }
    }

    // Дополнительная консолидация точек группы
    candidateGroup = consolidateTouches(candidateGroup, "SSL");

    // Условие: Количество касаний >= 2
    if (candidateGroup.length < 2) continue;

    candidateGroup.sort((a, b) => a.index - b.index);

    const levelPrice = Math.min(...candidateGroup.map((t) => t.price));
    // Строгая проверка: уровень SSL строго под текущей ценой
    if (levelPrice >= currentPrice * 0.999) continue;

    const firstLocalIdx = Math.max(0, candidateGroup[0].index - startIndex);

    // ПРОВЕРКА ЧИСТОТЫ:
    // Ни одна свеча между первым касанием и текущим моментом не должна закрываться ниже уровня телом более чем на 0.25%
    let bodyBreached = false;
    for (let idx = firstLocalIdx; idx < n; idx++) {
      if (candles[idx].close < levelPrice * 0.9975) {
        bodyBreached = true;
        break;
      }
    }
    if (bodyBreached) continue;

    // ПРОВЕРКА СТРУКТУРЫ И КАТЕГОРИИ:
    let structureValid = true;
    let maxBounceBetween = 0;
    let maxGapBetween = 0;

    for (let k = 0; k < candidateGroup.length - 1; k++) {
      const t1 = candidateGroup[k];
      const t2 = candidateGroup[k + 1];

      const candleGap = t2.index - t1.index;
      if (candleGap < 4 || candleGap > 180) {
        structureValid = false;
        break;
      }
      if (candleGap > maxGapBetween) maxGapBetween = candleGap;

      let maxHighBetween = -Infinity;
      const localStart = Math.max(0, t1.index - startIndex);
      const localEnd = Math.min(n - 1, t2.index - startIndex);

      for (let idx = localStart; idx <= localEnd; idx++) {
        if (candles[idx].high > maxHighBetween) {
          maxHighBetween = candles[idx].high;
        }
      }

      const bounce = (maxHighBetween - levelPrice) / levelPrice;
      if (bounce > maxBounceBetween) maxBounceBetween = bounce;

      if (bounce < 0.0035) {
        structureValid = false;
        break;
      }
    }
    if (!structureValid) continue;

    const isMacroSwing = maxBounceBetween >= 0.010 || maxGapBetween >= 24;

    const category: "SWING_MACRO" | "LOCAL_SHELF" = isMacroSwing ? "SWING_MACRO" : "LOCAL_SHELF";
    const categoryLabel: "Дневной" | "Полка" = isMacroSwing ? "Дневной" : "Полка";

    candidateGroup.forEach((t) => usedLowIndices.add(t.index));

    const touches = candidateGroup.length;
    const touchesLabel: "2K" | "3K+" = touches >= 3 ? "3K+" : "2K";
    const distancePercent = Math.abs((currentPrice - levelPrice) / currentPrice) * 100;

    // Дистанция актуальности пула: до 10.0%
    if (distancePercent > 10.0) continue;

    const formattedPrice = levelPrice >= 1000 ? levelPrice.toFixed(2) : levelPrice >= 1 ? levelPrice.toFixed(4) : levelPrice.toFixed(6);

    validLevels.push({
      id: `clean-ssl-${levelPrice.toFixed(4)}-${candidateGroup[0].index}`,
      type: "SSL",
      category,
      categoryLabel,
      price: levelPrice,
      touches,
      touchesLabel,
      firstIndex: candidateGroup[0].index,
      firstTime: candidateGroup[0].time,
      lastIndex: candidateGroup[candidateGroup.length - 1].index,
      lastTime: candidateGroup[candidateGroup.length - 1].time,
      touchPoints: candidateGroup,
      distancePercent: parseFloat(distancePercent.toFixed(2)),
      badgeTitle: `🟣 $${formattedPrice} [${touchesLabel} ${categoryLabel}]`,
      strength: touches >= 3 ? "STRONG" : "MEDIUM",
      tolerancePercent: parseFloat(tolerance.toFixed(3)),
      atrPercent: parseFloat(atrPercent.toFixed(2)),
    });
  }

  // Prefer the strongest independently validated level when nearby candidates
  // overlap. Never merge touch points without revalidating the resulting group.
  validLevels.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    if (a.category !== b.category) return a.category === "SWING_MACRO" ? -1 : 1;
    return (b.lastIndex - b.firstIndex) - (a.lastIndex - a.firstIndex);
  });

  const clusteredLevels: CleanScalperLevel[] = [];
  for (const lvl of validLevels) {
    const overlaps = clusteredLevels.some((ex) =>
      ex.type === lvl.type &&
      (ex.touchPoints.some((a) => lvl.touchPoints.some((b) => a.time === b.time)) ||
        Math.abs(ex.price - lvl.price) / Math.min(ex.price, lvl.price) <= tolerance / 100)
    );
    if (!overlaps) {
      clusteredLevels.push(lvl);
    }
  }

  // Сортировка: BSL ближайший выше текущей цены, SSL ближайший ниже текущей цены
  clusteredLevels.sort((a, b) => {
    if (a.type !== b.type) return a.type === "BSL" ? -1 : 1;
    return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  });

  return clusteredLevels;
}

/**
 * Radar & Modal helper: backward-compatible adapter returning clean levels
 */
export function detectConfirmedPurpleLevels(
  candles: ScannerCandle[],
  symbol: string,
  volume24h: number = 50_000_000,
  recentSurgeMultiplier: number = 1.0,
  minVolumeM: number = 15
): {
  id: string;
  price: number;
  type: "BSL" | "SSL";
  touches: number;
  touchesLabel: "2K" | "3K" | "4K+";
  distancePercent: number;
  volumeMultiplier: number;
  status: "Разъедание" | "Поджатие" | "Отскок";
  atrPercent: number;
  surgeMultiplier: number;
  firstIndex: number;
  lastIndex: number;
}[] {
  if (!isPureCryptoTicker(symbol) || volume24h / 1_000_000 < minVolumeM) {
    return [];
  }

  const { atrPercent, isVolatileEnough } = calculateATR14(candles, 0.15);
  if (!isVolatileEnough) return [];

  const cleanLevels = findCleanSwingLevels(candles);

  return cleanLevels.map((lvl) => {
    const touchesLabel = lvl.touches >= 4 ? "4K+" : lvl.touches === 3 ? "3K" : "2K";
    let status: "Разъедание" | "Поджатие" | "Отскок" = "Отскок";
    if (lvl.distancePercent < 0.15 && recentSurgeMultiplier >= 1.8) {
      status = "Разъедание";
    } else if (lvl.distancePercent < 0.40) {
      status = "Поджатие";
    }

    return {
      id: `${symbol}-${lvl.id}`,
      price: lvl.price,
      type: lvl.type,
      touches: lvl.touches,
      touchesLabel,
      distancePercent: lvl.distancePercent,
      volumeMultiplier: recentSurgeMultiplier,
      status,
      atrPercent,
      surgeMultiplier: recentSurgeMultiplier,
      firstIndex: lvl.firstIndex,
      lastIndex: lvl.lastIndex,
    };
  });
}

export interface HotScalpSignal {
  ticker: string; // e.g. "SOL"
  type: "BSL" | "SSL";
  typeLabel: "🔴 BSL (Шорт-стопы)" | "🟢 SSL (Лонг-стопы)";
  levelPrice: number;
  touches: number;
  touchesLabel: string; // e.g. "2" or "3+" -> "[2K]" or "[3+K]"
  distancePercent: number; // <= 0.35%
  change24h: number;
  volume24hM: number;
  atrPercent: number; // >= 0.30%
  timestamp: number;
}

/**
 * Checks if price action on 5m is in "Поджатие" (Squeeze / Compression towards the level):
 * - BSL: Higher Lows pressing into the resistance ceiling (минимумы повышаются к BSL).
 * - SSL: Lower Highs pressing into the support floor (максимумы понижаются к SSL).
 */
export function checkLevelCompression(
  candles5m: ScannerCandle[],
  level: CleanScalperLevel,
  maxDistancePercent: number = 0.35
): { isCompression: boolean; distancePercent: number } {
  if (!candles5m || candles5m.length < 8) {
    return { isCompression: false, distancePercent: 999 };
  }

  const n = candles5m.length;
  const current = candles5m[n - 1];
  const currentPrice = current.close;
  if (currentPrice <= 0) return { isCompression: false, distancePercent: 999 };

  const distancePercent = (Math.abs(currentPrice - level.price) / currentPrice) * 100;
  if (distancePercent > maxDistancePercent) {
    return { isCompression: false, distancePercent };
  }

  const windowSize = 6;
  const recentCandles = candles5m.slice(Math.max(0, n - windowSize));
  if (recentCandles.length < 4) {
    return { isCompression: false, distancePercent };
  }

  if (level.type === "BSL") {
    // Price should be pressing from underneath or right at the level
    if (currentPrice > level.price * 1.002) {
      return { isCompression: false, distancePercent };
    }

    // Поджатие к BSL: минимумы свечей повышаются к уровню (Higher Lows)
    const mid = Math.floor(recentCandles.length / 2);
    const earlyLows = recentCandles.slice(0, mid).map((c) => c.low);
    const lateLows = recentCandles.slice(mid).map((c) => c.low);

    const minEarly = Math.min(...earlyLows);
    const minLate = Math.min(...lateLows);

    const isLowsRising = minLate > minEarly;
    const isCurrentHolding = current.low >= minEarly * 1.0005;

    return {
      isCompression: isLowsRising && isCurrentHolding,
      distancePercent,
    };
  } else {
    // SSL: Price should be pressing from above or right at the level
    if (currentPrice < level.price * 0.998) {
      return { isCompression: false, distancePercent };
    }

    // Поджатие к SSL: максимумы свечей понижаются к уровню (Lower Highs)
    const mid = Math.floor(recentCandles.length / 2);
    const earlyHighs = recentCandles.slice(0, mid).map((c) => c.high);
    const lateHighs = recentCandles.slice(mid).map((c) => c.high);

    const maxEarly = Math.max(...earlyHighs);
    const maxLate = Math.max(...lateHighs);

    const isHighsFalling = maxLate < maxEarly;
    const isCurrentHolding = current.high <= maxEarly * 0.9995;

    return {
      isCompression: isHighsFalling && isCurrentHolding,
      distancePercent,
    };
  }
}

/**
 * Detects a Hot Scalp Compression Signal for a volatile altcoin:
 * 1. ATR(14) on 5m timeframe >= 0.30%
 * 2. Confirmed 5m Clean Scalper Level (2K+ touches)
 * 3. Distance to level <= 0.35%
 * 4. Compression ("Поджатие": Higher Lows to BSL or Lower Highs to SSL)
 */
export function detectHotScalpSignal(
  candles5m: ScannerCandle[],
  ticker: { symbol: string; volume: number; change: number }
): HotScalpSignal | null {
  if (!candles5m || candles5m.length < 20) return null;

  // 1. Check ATR(14) on 5m >= 0.30%
  const { atrPercent, isVolatileEnough } = calculateATR14(candles5m, 0.30);
  if (!isVolatileEnough || atrPercent < 0.30) {
    return null;
  }

  // 2. Find confirmed 5m swing levels (2K+ touches)
  const levels = findCleanSwingLevels(candles5m);
  if (levels.length === 0) return null;

  // 3. Find level meeting distance <= 0.35% and "Поджатие"
  for (const lvl of levels) {
    const { isCompression, distancePercent } = checkLevelCompression(candles5m, lvl, 0.35);
    if (isCompression && distancePercent <= 0.35) {
      const cleanTicker = ticker.symbol.replace("/USDT", "").replace("USDT", "").toUpperCase();
      const typeLabel = lvl.type === "BSL" ? "🔴 BSL (Шорт-стопы)" : "🟢 SSL (Лонг-стопы)";
      const touchesLabel = lvl.touches >= 3 ? "3+" : "2";

      return {
        ticker: cleanTicker,
        type: lvl.type,
        typeLabel,
        levelPrice: lvl.price,
        touches: lvl.touches,
        touchesLabel,
        distancePercent,
        change24h: ticker.change,
        volume24hM: ticker.volume / 1_000_000,
        atrPercent,
        timestamp: Date.now(),
      };
    }
  }

  return null;
}

