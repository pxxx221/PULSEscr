import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { TickerData, Timeframe, SortMode, GravityShieldData } from "./types";
import { fetchMarketJson, marketError } from "./services/marketData";
import { convertRuToEnLayout } from "./utils/keyboardTranslit";
import { isPureCryptoTicker } from "./utils/liquidityScanner";
import TradingChart from "./components/TradingChart";
import ScreenerSidebar from "./components/ScreenerSidebar";
import ScannerRadar from "./components/ScannerRadar";
import ExportCodeModal from "./components/ExportCodeModal";
import TelegramTestButton from "./components/TelegramTestButton";
import { useTelegramAlertWatcher } from "./hooks/useTelegramAlertWatcher";
import { useOrderBookWalls } from "./hooks/useOrderBookWalls";
import { FlowSnapshot } from "./utils/flowMonitor";
import { Bell, Settings2, UserRound, X, TrendingUp, Activity, Flame, ShieldAlert, Zap, Layers, RefreshCw, Layers2, PieChart, Sparkles, Layout, ChevronLeft, ChevronRight, Search, CornerDownLeft, Target, Download } from "lucide-react";
export default function App() {
  const [profileOpen, setProfileOpen] = useState(false);
  const [markets, setMarkets] = useState<Record<string, TickerData>>({});
  const [currentCoin, setCurrentCoin] = useState<string>("BTC/USDT");
  const [flowBySymbol, setFlowBySymbol] = useState<Record<string, { snapshot: FlowSnapshot; receivedAt: number }>>({});
  const flowUiAtRef = useRef<Record<string, number>>({});
  const onFlowSnapshot = useCallback((snapshot: FlowSnapshot) => {
    const now = Date.now();
    if (now - (flowUiAtRef.current[snapshot.symbol] || 0) < 500 && !snapshot.alertReady) return;
    flowUiAtRef.current[snapshot.symbol] = now;
    setFlowBySymbol(previous => ({ ...previous, [snapshot.symbol]: { snapshot, receivedAt: now } }));
  }, []);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [currentSort, setSortMode] = useState<SortMode>("%");
  const [minVolume, setMinVolume] = useState<number>(50); // M$ min
  const [squeezeSensitivity, setSqueezeSensitivity] = useState<number>(2.5);
  const [alertThreshold, setAlertThreshold] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("radar_alert_threshold");
      if (saved) {
        const parsed = parseFloat(saved);
        if (parsed >= 1.0 && parsed <= 9.0) {
          return parsed;
        }
      }
    } catch (e) {}
    return 3.0; // Default to 3.0%
  });
  const [radarOn, setRadarOn] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("radar_on");
      return saved !== null ? saved === "true" : true;
    } catch (e) {
      return true;
    }
  });

  // Save changes to localStorage to survive any reloads or refreshes
  useEffect(() => {
    try {
      localStorage.setItem("radar_alert_threshold", alertThreshold.toString());
    } catch (e) {}
  }, [alertThreshold]);

  useEffect(() => {
    try {
      localStorage.setItem("radar_on", radarOn.toString());
    } catch (e) {}
  }, [radarOn]);

  const [searchQuery, setSearchQuery] = useState<string>("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const [activeCoinPools, setActiveCoinPools] = useState<{ price: number; type: "BSL" | "SSL" }[]>([]);
  const [selectedConfirmedLevel, setSelectedConfirmedLevel] = useState<{
    price: number;
    touches: number;
    volumeRatio: number;
    touchesLabel?: string;
    type?: "BSL" | "SSL";
  } | null>(null);

  const [pushedSymbols, setPushedSymbols] = useState<Record<string, { type: "LONG" | "SHORT"; timestamp: number }>>({});
  const pushedSymbolsRef = useRef(pushedSymbols);
  useEffect(() => {
    pushedSymbolsRef.current = pushedSymbols;
  }, [pushedSymbols]);

  const [feedStatus, setFeedStatus] = useState<"LIVE" | "BACKUP">("BACKUP");
  const [marketFailure, setMarketFailure] = useState<string | null>(null);
  const loadingMarketsRef = useRef(false);

  // Background Telegram Alert Watcher for BSL/SSL distance <= 0.35% and volume spike >= 1.8x
  useTelegramAlertWatcher({ markets, enabled: false });

  // High-performance real-time HFT robot pressure detection engine with VPN resilience
  useEffect(() => {
    let isCancelled = false;
    const tickCache: Record<string, {
      lastPrice: number;
      consecutiveCount: number;
      lastDirection: "UP" | "DOWN" | null;
      lastTickTime: number;
    }> = {};

    let ws: WebSocket | null = null;
    let wsReconnectTimer: any = null;

    let flushInterval: any = null;
    let lastMsgTime = 0;
    
    // Internal buffer to avoid flooding React state with hundreds of updates per second
    const pendingPushes: Record<string, { type: "LONG" | "SHORT"; timestamp: number }> = {};
    let hasPendingChanges = false;

    const handleTick = (symbol: string, price: number) => {
      const now = Date.now();
      const prettyKey = symbol.replace("USDT", "/USDT");
      
      if (!tickCache[prettyKey]) {
        tickCache[prettyKey] = {
          lastPrice: price,
          consecutiveCount: 0,
          lastDirection: null,
          lastTickTime: now,
        };
        return;
      }

      const cache = tickCache[prettyKey];
      const diff = price - cache.lastPrice;
      
      if (diff !== 0) {
        const direction = diff > 0 ? ("UP" as const) : ("DOWN" as const);
        const timeDelta = now - cache.lastTickTime;

        if (cache.lastDirection === direction) {
          if (timeDelta < 2000) {
            cache.consecutiveCount += 1;
          } else {
            cache.consecutiveCount = 1;
          }
        } else {
          cache.consecutiveCount = 1;
          cache.lastDirection = direction;
        }

        cache.lastPrice = price;
        cache.lastTickTime = now;

        if (cache.consecutiveCount >= 3) {
          const pushType = direction === "UP" ? ("LONG" as const) : ("SHORT" as const);
          pendingPushes[prettyKey] = { type: pushType, timestamp: now };
          hasPendingChanges = true;
        }
      }
    };

    // Connect to Binance live miniTicker stream with auto-reconnect
    const connectHFTWS = () => {
      if (isCancelled) return;
      try {
        ws = new WebSocket("wss://fstream.binance.com/market/ws/!miniTicker@arr");
        
        ws.onopen = () => {
          if (!isCancelled) setFeedStatus("BACKUP");
        };

        ws.onmessage = (event) => {
          if (isCancelled) return;
          const now = Date.now();
          // Rate-limiting burst arrivals from VPN hiccups
          if (now - lastMsgTime < 80) return;
          lastMsgTime = now;

          try {
            const raw = JSON.parse(event.data);
            const tickers = Array.isArray(raw) ? raw : [raw];
            for (let i = 0; i < tickers.length; i++) {
              const t = tickers[i];
              if (!t.s || !t.s.endsWith("USDT")) continue;
              const price = parseFloat(t.c);
              if (Number.isFinite(price) && price > 0) {
                setFeedStatus("LIVE");
                handleTick(t.s, price);
              }
            }
          } catch (e) {}
        };

        ws.onerror = () => {
          if (!isCancelled) setFeedStatus("BACKUP");
        };

        ws.onclose = () => {
          if (!isCancelled) {
            setFeedStatus("BACKUP");
            wsReconnectTimer = setTimeout(connectHFTWS, 4000);
          }
        };
      } catch (e) {
        if (!isCancelled) {
          setFeedStatus("BACKUP");
          wsReconnectTimer = setTimeout(connectHFTWS, 5000);
        }
      }
    };

    connectHFTWS();

    // Flush batched updates & expire old tags cleanly once every 1000ms
    flushInterval = setInterval(() => {
      const now = Date.now();
      if (!lastMsgTime || now - lastMsgTime > 15000) setFeedStatus("BACKUP");
      const currentActive = pushedSymbolsRef.current;
      
      // Clean up expired items (> 1500ms)
      const updated: Record<string, { type: "LONG" | "SHORT"; timestamp: number }> = {};
      let changed = false;

      // Copy unexpired items from current state
      for (const [key, item] of Object.entries(currentActive)) {
        if (now - item.timestamp <= 1500) {
          updated[key] = item;
        } else {
          changed = true;
        }
      }

      // Merge new pending items
      if (hasPendingChanges) {
        for (const [key, item] of Object.entries(pendingPushes)) {
          updated[key] = item;
          changed = true;
        }
        // clear pending buffer
        for (const key in pendingPushes) {
          delete pendingPushes[key];
        }
        hasPendingChanges = false;
      }

      if (changed) {
        setPushedSymbols(updated);
      }
    }, 1000);

    return () => {
      isCancelled = true;
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      if (ws) {
        try { ws.close(); } catch (e) {}
      }

      if (flushInterval) clearInterval(flushInterval);
    };
  }, []);
  
  // Real-time market state metrics
  const [globalStats, setGlobalStats] = useState({
    totalPairs: 0,
    bullCount: 0,
    bearCount: 0,
    totalVolumeB: 0,
    topGainer: { symbol: "-", change: 0 },
  });

  // Load Saved Favorites & Coins
  useEffect(() => {
    try {
      const savedFavs = localStorage.getItem("screener_favorites");
      if (savedFavs) {
        setFavorites(JSON.parse(savedFavs));
      }
      const savedActiveCoin = localStorage.getItem("screener_active_coin");
      if (savedActiveCoin && isPureCryptoTicker(savedActiveCoin.replace(/[\/_]/g, ""))) {
        setCurrentCoin(savedActiveCoin);
      } else {
        setCurrentCoin("BTC/USDT");
        localStorage.setItem("screener_active_coin", "BTC/USDT");
      }
    } catch (e) {
      console.warn("Unable to restore saved preferences", e);
    }
  }, []);

  const toggleFav = (coin: string) => {
    const updated = favorites.includes(coin)
      ? favorites.filter((c) => c !== coin)
      : [...favorites, coin];
    setFavorites(updated);
    localStorage.setItem("screener_favorites", JSON.stringify(updated));
  };

  const selectCoin = (
    coin: string,
    confirmedLevel?: {
      price: number;
      touches: number;
      volumeRatio: number;
      touchesLabel?: string;
      type?: "BSL" | "SSL";
    } | null
  ) => {
    const clean = coin.replace(/[\/_]/g, "");
    if (!isPureCryptoTicker(clean)) {
      console.warn("Disallowed selection of non-crypto asset:", coin);
      return;
    }
    setCurrentCoin(coin);
    setSelectedConfirmedLevel(confirmedLevel || null);
    setActiveCoinPools([]);
    localStorage.setItem("screener_active_coin", coin);
  };

  // Order-book based indicators stay unavailable until real depth data is connected.
  const gravityShieldSymbols: Record<string, GravityShieldData> = {};

  // Main HTTP call to load full asset rosters & calculate general indicators
  const loadFuturesMarkets = useCallback(async () => {
    if (loadingMarketsRef.current) return;
    loadingMarketsRef.current = true;
    setIsLoading(true);
    let listData: any = null;

    try {
      listData = await fetchMarketJson("https://fapi.binance.com/fapi/v1/ticker/24hr");
      if (!Array.isArray(listData) || listData.length === 0) throw new Error("Binance: пустой список рынков");
    } catch (e) {
      setMarketFailure(marketError(e));
      setIsLoading(false);
      loadingMarketsRef.current = false;
      return; // Preserve the last real snapshot; never invent replacements.
    }

    try {
      if (Array.isArray(listData)) {
        const mappedMarkets: Record<string, TickerData> = {};
        let bulls = 0;
        let bears = 0;
        let sumVol = 0;
        let topG = { symbol: "-", change: -999 };

        listData.forEach((item: any) => {
          // Keep only pure crypto USDT-M Futures assets (exclude NVDA, AAPL, TSLA, AMZN, MSFT, SPCX, SPX, NDX, BZ, CL, XAU, XAG, stables)
          if (typeof item?.symbol === "string" && item.symbol.endsWith("USDT") && isPureCryptoTicker(item.symbol)) {
            const rawSymbol = item.symbol;
            // e.g. "BTCUSDT" -> "BTC/USDT"
            const prettyKey = rawSymbol.replace("USDT", "/USDT");
            const price = parseFloat(item.lastPrice);
            const changePercent = parseFloat(item.priceChangePercent);
            const volumeUSDT = parseFloat(item.quoteVolume);

            if (price > 0 && volumeUSDT >= 0 && [price, changePercent, volumeUSDT].every(Number.isFinite)) {
              mappedMarkets[prettyKey] = {
                symbol: prettyKey,
                price: price,
                change: changePercent,
                volume: volumeUSDT,
              };

              // Increment totals
              if (changePercent >= 0) bulls++;
              else bears++;
              sumVol += volumeUSDT;

              if (changePercent > topG.change) {
                topG = { symbol: prettyKey, change: changePercent };
              }
            }
          }
        });

        if (!Object.keys(mappedMarkets).length) throw new Error("Binance: нет валидных рыночных данных");
        setMarketFailure(null);
        setMarkets(mappedMarkets);
        setLastRefreshed(new Date());

        setGlobalStats({
          totalPairs: Object.keys(mappedMarkets).length,
          bullCount: bulls,
          bearCount: bears,
          totalVolumeB: sumVol / 1_000_000_000,
          topGainer: topG,
        });

        // Ensure current active coin exists in lists and is pure crypto
        if (Object.keys(mappedMarkets).length > 0) {
          setCurrentCoin((prev) => {
            const clean = prev.replace(/[\/_]/g, "");
            return mappedMarkets[prev] && isPureCryptoTicker(clean) ? prev : "BTC/USDT";
          });
        }
      }
    } catch (e) {
      setMarketFailure(marketError(e));
    } finally {
      loadingMarketsRef.current = false;
      setIsLoading(false);
    }
  }, []);

  // Global Keyboard Handler for instant quick-search in English without clicking
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if modifier keys like Ctrl, Cmd, Alt are pressed
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const activeEl = document.activeElement as HTMLElement | null;
      const isInsideOtherInput =
        activeEl &&
        activeEl !== searchInputRef.current &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          activeEl.isContentEditable);

      if (isInsideOtherInput) {
        return;
      }

      // Escape key -> clear search and blur
      if (e.key === "Escape") {
        setSearchQuery("");
        searchInputRef.current?.blur();
        return;
      }

      // Enter key -> select first coin matching current query
      if (e.key === "Enter") {
        if (searchQuery.trim()) {
          const queryClean = searchQuery.trim().toUpperCase().replace("/USDT", "");
          const marketKeys = Object.keys(markets);
          const match = marketKeys.find((k) => {
            const cleanKey = k.toUpperCase().replace("/USDT", "");
            return cleanKey === queryClean || cleanKey.startsWith(queryClean) || cleanKey.includes(queryClean);
          });
          if (match) {
            selectCoin(match);
            setSearchQuery("");
            searchInputRef.current?.blur();
          }
        }
        return;
      }

      // If already focused directly in search input, let input event handling run
      if (activeEl === searchInputRef.current) {
        return;
      }

      // Backspace outside of search input -> remove last letter and focus
      if (e.key === "Backspace") {
        e.preventDefault();
        setSearchQuery((prev) => prev.slice(0, -1));
        searchInputRef.current?.focus();
        return;
      }

      // Single printable character pressed (letters, numbers)
      if (e.key.length === 1) {
        const converted = convertRuToEnLayout(e.key).toUpperCase();
        // Match English letters and digits (A-Z, 0-9)
        if (/^[A-Z0-9]$/.test(converted)) {
          e.preventDefault();
          setSearchQuery((prev) => prev + converted);
          if (searchInputRef.current) {
            searchInputRef.current.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [markets, searchQuery]);

  // Initial load
  useEffect(() => {
    loadFuturesMarkets();

    // Auto-refresh stats every 45 seconds
    const timer = setInterval(() => {
      loadFuturesMarkets();
    }, 45000);
    return () => clearInterval(timer);
  }, [loadFuturesMarkets]);

  const wallRosterRef = useRef<{ key: string; symbols: string[] } | null>(null);
  const wallSymbols = useMemo(() => {
    const rosterKey = [currentCoin, favorites.join('|'), currentSort, minVolume, searchQuery, Object.keys(markets).length > 0].join(':');
    if (wallRosterRef.current?.key === rosterKey) return wallRosterRef.current.symbols;
    const keys = Object.keys(markets).filter((key) => markets[key].volume >= minVolume * 1_000_000);
    keys.sort((a, b) => currentSort === "A-Z" ? a.localeCompare(b)
      : currentSort === "$" ? markets[b].volume - markets[a].volume
      : Math.abs(markets[b].change) - Math.abs(markets[a].change));
    const searched = searchQuery ? keys.filter((key) => key.includes(searchQuery)) : keys;
    const symbols = [...new Set([currentCoin, ...favorites, ...searched.slice(0, 40)])].slice(0, 45);
    wallRosterRef.current = { key: rosterKey, symbols };
    return symbols;
  }, [markets, currentCoin, favorites, currentSort, minVolume, searchQuery]);
  const bookWalls = useOrderBookWalls(wallSymbols, markets);

  return (
    <div className="pulse-app">
      <header className="pulse-topbar">
        <a className="pulse-brand" href="/" aria-label="PULSE home"><Activity size={25} strokeWidth={2.5}/><span>PULSE</span><small>TERMINAL</small></a>
        <div className="pulse-global-stats">
          <span>Futures <b>{globalStats.totalPairs || '—'}</b></span>
          <span>24H Volume <b>{'$'}{globalStats.totalVolumeB.toFixed(1)}B</b></span>
          <span>Market <b>{!globalStats.totalPairs ? '—' : globalStats.bullCount > globalStats.bearCount ? 'Bullish' : globalStats.bearCount > globalStats.bullCount ? 'Bearish' : 'Neutral'}</b></span>
        </div>
        <div className="pulse-global-search"><Search size={15}/><input ref={searchInputRef} aria-label="Search markets" placeholder="Search markets..." value={searchQuery} onChange={e=>setSearchQuery(convertRuToEnLayout(e.target.value).toUpperCase())}/><kbd>↵</kbd></div>
        <div className="pulse-global-actions">
          <button onClick={()=>{ if (!radarOn) setRadarOn(true); window.dispatchEvent(new Event('pulse-alerts')); }} title="Радар импульсов"><Bell size={16}/><span>Alerts</span></button>
          <button onClick={()=>window.dispatchEvent(new Event('pulse-settings'))} title="Настройки скринера" aria-label="Settings"><Settings2 size={17}/></button>
          <button onClick={()=>setProfileOpen(!profileOpen)} className="pulse-avatar" aria-label="Local profile" aria-expanded={profileOpen}><UserRound size={16}/></button>
        </div>
        {profileOpen && <div className="pulse-profile"><b>Local workspace</b><p>Избранное и настройки сохраняются в этом браузере.</p><button onClick={()=>setProfileOpen(false)}>Закрыть</button></div>}
      </header>
      {marketFailure && <div role="alert" className="pulse-warning">Статистика Binance недоступна: {marketFailure}. {lastRefreshed ? 'Показан последний полученный снимок: '+lastRefreshed.toLocaleTimeString() : 'Рыночные данные ещё не получены.'}</div>}
      <main className="pulse-workspace">
        <aside className="pulse-market-panel">
          <ScreenerSidebar markets={markets} currentCoin={currentCoin} selectCoin={selectCoin}
            favorites={favorites} toggleFav={toggleFav} currentSort={currentSort} setSortMode={setSortMode}
            minVolume={minVolume} setMinVolume={setMinVolume} squeezeSensitivity={squeezeSensitivity}
            setSqueezeSensitivity={setSqueezeSensitivity} alertThreshold={alertThreshold} setAlertThreshold={setAlertThreshold}
            radarOn={radarOn} setRadarOn={setRadarOn} searchQuery={searchQuery} setSearchQuery={setSearchQuery}
            pushedSymbols={pushedSymbols} activeCoinPools={activeCoinPools} gravityShieldSymbols={gravityShieldSymbols} bookWalls={bookWalls}/>
        </aside>
        <section className="pulse-main">
          <FlowStrip item={flowBySymbol[currentCoin.replace('/', '')]} />
          <TradingChart symbol={currentCoin} timeframe={timeframe} setTimeframe={setTimeframe}
            squeezeSensitivity={squeezeSensitivity} markets={markets} onPoolsChange={setActiveCoinPools} confirmedLevel={selectedConfirmedLevel} bookWalls={bookWalls[currentCoin] || []}/>
        </section>
      </main>
      <ScannerRadar markets={markets} selectCoin={selectCoin} radarOn={radarOn} alertThreshold={alertThreshold} currentCoin={currentCoin} onFlowSnapshot={onFlowSnapshot}/>
      <footer className="pulse-footer"><span className={feedStatus === 'LIVE' ? 'pulse-connected' : ''}>●</span><span>{feedStatus === 'LIVE' ? 'Binance connected' : 'Connecting to Binance'}</span><span>USDⓈ-M Futures</span><span className="pulse-footer-right">Snapshot {lastRefreshed?.toLocaleTimeString() || '—'} <button title="Обновить статистику рынка" aria-label="Refresh markets" onClick={loadFuturesMarkets} disabled={isLoading}><RefreshCw size={12} className={isLoading ? 'animate-spin' : ''}/></button></span><span>PULSE <b>1.0</b></span></footer>
    </div>
  );
}

function FlowStrip({ item }: { item?: { snapshot: FlowSnapshot; receivedAt: number } }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  if (!item || now - item.receivedAt > 5000) return null;
  const flow = item.snapshot;
  const counterSide = flow.direction === 'PUMP' ? 'SELL' : 'BUY';
  return <div className="pulse-flow-strip" role="status">
    <b>PULSE FLOW</b><span>{flow.direction} {flow.impulsePercent > 0 ? '+' : ''}{flow.impulsePercent.toFixed(1)}%</span>
    <span>Speed ↓{flow.velocityDropPercent.toFixed(0)}%</span>
    <span>Tape {counterSide} {flow.counterFlowRatio.toFixed(1)}x</span>
    <strong data-flow-state={flow.state}>{flow.state.replaceAll('_', ' ')}</strong>
    {flow.debug && <details><summary>Debug</summary><div className="pulse-flow-debug">
      <span>{flow.symbol} · {flow.direction} · {flow.impulsePercent.toFixed(2)}% / {(flow.impulseDurationMs / 1000).toFixed(1)}s</span>
      <span>Peak {flow.peakVelocity.toFixed(2)}%/s · current {flow.currentVelocity.toFixed(2)}%/s · drop {flow.velocityDropPercent.toFixed(0)}%</span>
      <span>BUY ${Math.round(flow.buyNotional).toLocaleString()} · SELL ${Math.round(flow.sellNotional).toLocaleString()} · ratio {flow.counterFlowRatio.toFixed(2)}</span>
      <span>1s {flow.tapeWindows['1s'].counterRatio.toFixed(1)}x · 2s {flow.tapeWindows['2s'].counterRatio.toFixed(1)}x · 5s {flow.tapeWindows['5s'].counterRatio.toFixed(1)}x</span>
      <span>Range {flow.priceRangePercent.toFixed(3)}% · response {flow.priceResponsePercent.toFixed(3)}% · {flow.state}</span>
    </div></details>}
  </div>;
}
