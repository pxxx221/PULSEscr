export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchMarketJson(url: string, timeoutMs = 7000, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function isValidCandle(c: MarketCandle): boolean {
  return [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    && c.time > 0 && Number.isInteger(c.time) && c.open > 0 && c.close > 0 && c.low > 0
    && c.volume >= 0 && c.high >= Math.max(c.open, c.close)
    && c.low <= Math.min(c.open, c.close);
}

export function parseKlines(raw: unknown): MarketCandle[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Binance: пустой ответ свечей');
  const candles = raw.map((row: unknown) => {
    if (!Array.isArray(row) || row.length < 6) throw new Error('Binance: неверный формат свечи');
    const c = { time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
    if (!isValidCandle(c)) throw new Error('Binance: некорректная свеча');
    return c;
  });
  if (candles.some((c, i) => i > 0 && c.time <= candles[i - 1].time)) {
    throw new Error('Binance: нарушен порядок свечей');
  }
  return candles;
}

export function volumeRatio(candles: MarketCandle[]): number {
  const previous = candles.slice(-21, -1);
  if (previous.length !== 20) return 0;
  const average = previous.reduce((sum, c) => sum + c.volume, 0) / 20;
  return average > 0 ? candles[candles.length - 1].volume / average : 0;
}

export function marketError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Время ожидания Binance истекло';
  return error instanceof Error ? error.message : 'Не удалось получить данные Binance';
}
