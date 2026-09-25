import { useEffect, useRef, useState } from "react";
import { TickerData } from "../types";
import { BookWall, OrderBookWallTracker } from "../services/orderBookWalls";

export function useOrderBookWalls(symbols: string[], markets: Record<string, TickerData>): Record<string, BookWall[]> {
  const [walls, setWalls] = useState<Record<string, BookWall[]>>({});
  const trackerRef = useRef(new OrderBookWallTracker());
  const marketsRef = useRef(markets);
  marketsRef.current = markets;
  const symbolKey = [...new Set(symbols)].sort().join("|");

  useEffect(() => {
    const monitored = symbolKey.split("|").filter(Boolean).slice(0, 65);
    if (!monitored.length) return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;
    let attempts = 0;
    const latestUpdate = new Map<string, number>();
    const pending: Record<string, BookWall[]> = {};
    const flush = window.setInterval(() => {
      if (!Object.keys(pending).length) return;
      const snapshot = { ...pending };
      for (const key of Object.keys(pending)) delete pending[key];
      setWalls((previous) => ({ ...previous, ...snapshot }));
    }, 1_000);
    trackerRef.current.clear();
    setWalls({});
    const connect = () => {
      if (stopped) return;
      const streams = monitored.map((symbol) => `${symbol.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}@depth20@500ms`).join("/");
      socket = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
      socket.onopen = () => { attempts = 0; };
      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data);
          const data = envelope.data;
          const rawSymbol = String(envelope.stream || "").split("@")[0].toUpperCase();
          const symbol = monitored.find((item) => item.replace(/[^a-zA-Z0-9]/g, "") === rawSymbol);
          if (!symbol) return;
          const market = marketsRef.current[symbol];
          if (!market || !Array.isArray(data?.b) || !Array.isArray(data?.a)) return;
          const updateId = Number(data.u);
          if (!Number.isFinite(updateId) || updateId <= (latestUpdate.get(symbol) || 0)) return;
          latestUpdate.set(symbol, updateId);
          pending[symbol] = trackerRef.current.update(symbol, data.b, data.a, market);
        } catch { /* Invalid book event: never present stale data as live. */ }
      };
      socket.onclose = () => {
        if (stopped) return;
        trackerRef.current.clear();
        latestUpdate.clear();
        for (const key of Object.keys(pending)) delete pending[key];
        setWalls({});
        retry = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5)));
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      stopped = true;
      if (retry !== undefined) window.clearTimeout(retry);
      window.clearInterval(flush);
      socket?.close();
      trackerRef.current.clear();
    };
  }, [symbolKey]);

  return walls;
}
