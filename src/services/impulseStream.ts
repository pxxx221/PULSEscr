import { fetchMarketJson } from './marketData';

export interface Trade {
  symbol: string;
  price: number;
  time: number;
  id: number;
  serverNow: number;
  notional: number;
  aggressiveSide: 'BUY' | 'SELL';
  source?: 'ticker' | 'aggTrade';
}

// All-market price changes arrive in one batch each second. Hundreds of individual
// aggTrade subscriptions overwhelm the browser and cause stale alerts.
export function startImpulseStream(symbols: string[], onTrade: (trade: Trade) => void,
  onReset: (symbols: string[]) => void, onStatus: (status: string) => void): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let lastFrame = 0;
  let lag = 0;
  let rawLag = 0;
  let offset = 0;
  let clockReady = false;
  let clockAt = 0;
  let syncing = false;
  const allowed = new Set(symbols);
  const controller = new AbortController();

  const syncClock = async () => {
    if (stopped || syncing) return;
    syncing = true;
    const start = Date.now();
    try {
      const raw = await fetchMarketJson('https://fapi.binance.com/fapi/v1/time', 5000, controller.signal) as { serverTime?: number };
      const end = Date.now();
      if (stopped) return;
      if (!Number.isFinite(raw.serverTime) || end - start > 2000) throw new Error('clock');
      const next = raw.serverTime! - (start + end) / 2;
      if (clockReady && Math.abs(next - offset) > 1000) onReset(symbols);
      offset = next; clockReady = true; clockAt = end;
      if (!socket && !retryTimer) connect();
    } catch { if (!clockReady) onStatus('Радар: ожидаю время Binance'); }
    finally { syncing = false; }
  };
  const retry = () => {
    if (stopped || retryTimer) return;
    const old = socket;
    socket = null; lastFrame = 0;
    if (old) { old.onmessage = old.onerror = old.onclose = null; old.close(); }
    onReset(symbols);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
  const connect = () => {
    if (stopped) return;
    try {
      const ws = new WebSocket('wss://fstream.binance.com/market/ws/!miniTicker@arr');
      socket = ws;
      ws.onmessage = event => {
        if (stopped || socket !== ws || !clockReady) return;
        try {
          const rows = JSON.parse(event.data);
          if (!Array.isArray(rows)) return;
          const now = Date.now();
          let accepted = false;
          for (const row of rows) {
            if (row?.e !== '24hrMiniTicker' || !allowed.has(row.s) || !Number.isSafeInteger(row.E)) continue;
            const price = Number(row.c);
            if (!Number.isFinite(price) || price <= 0) continue;
            const delay = now + offset - row.E;
            rawLag = delay;
            if (delay > 8000 || delay < -1000) continue;
            accepted = true;
            lag = Math.max(0, delay);
            onTrade({ symbol: row.s, price, time: row.E, id: row.E, serverNow: now + offset,
              notional: 0, aggressiveSide: 'BUY', source: 'ticker' });
          }
          if (accepted) { lastFrame = now; attempt = 0; }
        } catch { /* Invalid batch cannot update health or generate alerts. */ }
      };
      ws.onerror = ws.onclose = retry;
    } catch { retry(); }
  };

  onStatus('Радар: подключение к Binance…');
  void syncClock();
  const health = setInterval(() => {
    const now = Date.now();
    if (!clockReady || now - clockAt > 300000) void syncClock();
    if (socket && lastFrame && now - lastFrame > 15000) retry();
    if (!clockReady || now - clockAt > 600000) {
      onStatus('Радар: нет точного времени Binance, сигналы приостановлены'); return;
    }
    onStatus(lastFrame && now - lastFrame < 5000
      ? `Радар LIVE • ${symbols.length} монет • задержка ≈${Math.round(lag)} мс`
      : `Радар: восстановление связи • 0/${symbols.length} монет • поток ≈${Math.round(rawLag)} мс`);
  }, 1000);
  return () => {
    stopped = true; controller.abort(); clearInterval(health);
    if (retryTimer) clearTimeout(retryTimer);
    if (socket) { socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
  };
}

// Full trade detail is needed only while FLOW follows an already confirmed impulse.
export function startFlowTradeStream(symbol: string, onTrade: (trade: Trade) => void): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const connect = () => {
    if (stopped) return;
    try {
      const ws = new WebSocket(`wss://fstream.binance.com/market/ws/${symbol.toLowerCase()}@aggTrade`);
      socket = ws;
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = event => {
        if (stopped || socket !== ws) return;
        try {
          const t = JSON.parse(event.data);
          if (t.e !== 'aggTrade' || t.s !== symbol || !Number.isSafeInteger(t.a) || !Number.isSafeInteger(t.T)
            || typeof t.m !== 'boolean') return;
          const price = Number(t.p), quantity = Number(t.q);
          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;
          onTrade({ symbol, price, time: t.T, id: t.a, serverNow: Date.now(),
            notional: price * quantity, aggressiveSide: t.m ? 'SELL' : 'BUY', source: 'aggTrade' });
        } catch { /* Ignore malformed trade. */ }
      };
      ws.onerror = ws.onclose = () => {
        if (stopped || retryTimer) return;
        socket = null;
        retryTimer = setTimeout(() => { retryTimer = null; connect(); }, Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4)));
      };
    } catch {
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 2000);
    }
  };
  connect();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
  };
}
