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
    && c.time > 0 && c.open > 0 && c.close > 0 && c.low > 0 && c.volume >= 0;
}

export function parseKlines(raw: unknown): MarketCandle[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Binance: пустой ответ свечей');
  const valid: MarketCandle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const time = Math.floor(Number(row[0]) / 1000);
    const open = Number(row[1]);
    let high = Number(row[2]);
    let low = Number(row[3]);
    const close = Number(row[4]);
    const quoteVol = Number(row[7]);
    const baseVol = Number(row[5]);
    const volume = Number.isFinite(quoteVol) && quoteVol > 0 ? quoteVol : (Number.isFinite(baseVol) && baseVol > 0 ? baseVol : 0);

    // Guard against floating point imprecision
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);

    const c: MarketCandle = { time, open, high, low, close, volume };
    if (isValidCandle(c)) {
      valid.push(c);
    }
  }

  if (valid.length === 0) throw new Error('Binance: нет валидных свечей');

  // Sort ascending and deduplicate by timestamp
  valid.sort((a, b) => a.time - b.time);
  const deduped: MarketCandle[] = [];
  for (let i = 0; i < valid.length; i++) {
    if (i === 0 || valid[i].time > deduped[deduped.length - 1].time) {
      deduped.push(valid[i]);
    }
  }
  return deduped;
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
