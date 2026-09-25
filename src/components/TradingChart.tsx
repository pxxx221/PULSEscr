import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  UTCTimestamp, 
  CandlestickSeries, 
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode
} from "lightweight-charts";
import { 
  Timer, 
  Magnet, 
  Trash2, 
  Layers, 
  BarChart3, 
  X,
  Target,
  ArrowRight
} from "lucide-react";
import { Timeframe, TickerData, BookWall } from "../types";
import { fetchMarketJson, parseKlines, isValidCandle, MarketCandle } from "../services/marketData";

interface TradingChartProps {
  symbol: string; // e.g. "BTC/USDT"
  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  squeezeSensitivity?: number;
  markets?: Record<string, TickerData>;
  onPoolsChange?: (pools: { price: number; type: "BSL" | "SSL" }[]) => void;
  confirmedLevel?: any;
  bookWalls?: BookWall[];
}

interface UserLevel {
  id: string;
  price: number;
  time: number; // Candle timestamp where the level originated
  type: "HIGH" | "LOW";
  createdAt: number;
}

export default function TradingChart({
  symbol,
  timeframe,
  setTimeframe,
  markets,
  bookWalls = [],
}: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const levelSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // States
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [userLevels, setUserLevels] = useState<UserLevel[]>([]);
  const [magnetMode, setMagnetMode] = useState<boolean>(true);
  const [levelToolActive, setLevelToolActive] = useState<boolean>(false);
  const [showWalls, setShowWalls] = useState<boolean>(true);
  const [showVolume, setShowVolume] = useState<boolean>(true);
  const [chartStatus, setChartStatus] = useState<string>("Загрузка свечей...");
  const [countdown, setCountdown] = useState<string>("");

  // Mutable refs to prevent chart re-initialization on state updates
  const candlesRef = useRef<MarketCandle[]>([]);
  const wallLinesRef = useRef<any[]>([]);
  const userLevelsRef = useRef<UserLevel[]>(userLevels);
  userLevelsRef.current = userLevels;
  const levelToolActiveRef = useRef<boolean>(levelToolActive);
  levelToolActiveRef.current = levelToolActive;
  const magnetModeRef = useRef<boolean>(magnetMode);
  magnetModeRef.current = magnetMode;
  const currentPriceRef = useRef<number | null>(currentPrice);
  currentPriceRef.current = currentPrice;

  const cleanSymbol = symbol.replace("/", "").toUpperCase();
  const tickerInfo = markets ? markets[symbol] : null;

  // Format price utility
  const formatPrice = useCallback((p: number) => {
    if (!Number.isFinite(p) || p <= 0) return "0.00";
    if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return p.toFixed(6);
  }, []);

  const formatNotional = (n: number) => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    return `$${Math.round(n / 1_000)}K`;
  };

  // Load saved levels from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`pulse_levels_${cleanSymbol}`);
      if (saved) {
        setUserLevels(JSON.parse(saved));
      } else {
        setUserLevels([]);
      }
    } catch {
      setUserLevels([]);
    }
  }, [cleanSymbol]);

  // Save levels to localStorage
  const saveLevels = useCallback((levels: UserLevel[]) => {
    setUserLevels(levels);
    try {
      localStorage.setItem(`pulse_levels_${cleanSymbol}`, JSON.stringify(levels));
    } catch {}
  }, [cleanSymbol]);

  // Candle countdown timer calculation
  useEffect(() => {
    const updateCountdown = () => {
      const now = Math.floor(Date.now() / 1000);
      let tfSec = 60;
      if (timeframe === "5m") tfSec = 300;
      else if (timeframe === "15m") tfSec = 900;
      else if (timeframe === "1h") tfSec = 3600;
      else if (timeframe === "4h") tfSec = 14400;
      else if (timeframe === "1d") tfSec = 86400;

      const remaining = tfSec - (now % tfSec);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      setCountdown(`${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [timeframe]);

  // Far-future timestamp for extending level rays to the right edge
  const FAR_FUTURE = 4102444800 as UTCTimestamp; // 2100-01-01

  // Sync User Level LineSeries — native chart rendering, zero jitter
  const syncLevelSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old level series
    levelSeriesRef.current.forEach((s) => {
      try { chart.removeSeries(s); } catch {}
    });
    levelSeriesRef.current = [];

    const current = currentPriceRef.current;

    userLevelsRef.current.forEach((lvl) => {
      const dist = current ? ((lvl.price - current) / current) * 100 : 0;
      const distStr = `${dist >= 0 ? "+" : ""}${dist.toFixed(2)}%`;
      const priceStr = formatPrice(lvl.price);

      const series = chart.addSeries(LineSeries, {
        color: "#C084FC",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        crosshairMarkerVisible: false,
        lastValueVisible: true,
        priceLineVisible: false,
        title: `${lvl.type} $${priceStr} (${distStr})`,
        pointMarkersVisible: true,
        pointMarkersRadius: 4,
      });

      series.setData([
        { time: lvl.time as UTCTimestamp, value: lvl.price },
        { time: FAR_FUTURE, value: lvl.price },
      ]);

      levelSeriesRef.current.push(series);
    });
  }, [formatPrice]);

  // Main Chart Setup and Lifecycle (ONLY depends on symbol and timeframe!)
  useEffect(() => {
    if (!containerRef.current) return;
    let isDisposed = false;
    const abortCtrl = new AbortController();

    // 1. Create Lightweight Chart instance
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth || 800,
      height: containerRef.current.clientHeight || 520,
      layout: {
        background: { color: "#0B0F14" },
        textColor: "#94A3B8",
        fontFamily: "'JetBrains Mono', 'Inter', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(30, 41, 54, 0.45)" },
        horzLines: { color: "rgba(30, 41, 54, 0.45)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(22, 199, 232, 0.4)",
          width: 1,
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: "rgba(22, 199, 232, 0.4)",
          width: 1,
          style: LineStyle.Dashed,
        },
      },
      rightPriceScale: {
        borderColor: "#1E2936",
        autoScale: true,
        scaleMargins: {
          top: 0.08,
          bottom: 0.22,
        },
      },
      timeScale: {
        borderColor: "#1E2936",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    // 2. Add Candlestick Series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22C55E",
      downColor: "#EF4444",
      borderUpColor: "#22C55E",
      borderDownColor: "#EF4444",
      wickUpColor: "#22C55E",
      wickDownColor: "#EF4444",
      priceFormat: {
        type: "price",
        precision: 4,
        minMove: 0.0001,
      },
    });
    candleSeriesRef.current = candleSeries;

    // 3. Add Volume Series (Quote Volume in USDT)
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(34, 197, 94, 0.6)",
      priceFormat: {
        type: "volume",
      },
      priceScaleId: "volume_scale",
    });
    volumeSeriesRef.current = volumeSeries;

    chart.priceScale("volume_scale").applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
      visible: false,
    });

    // 4. Resize handler
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries.length || isDisposed) return;
      const { width, height } = entries[0].contentRect;
      chart.resize(width, height);
    });
    resizeObserver.observe(containerRef.current);

    // 5. Initial Historical Klines Fetch (500 bars)
    const loadHistory = async () => {
      setChartStatus("Загрузка свечей Binance...");
      try {
        const raw = await fetchMarketJson(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=${timeframe}&limit=500`,
          8000,
          abortCtrl.signal
        );

        if (isDisposed) return;
        const candles = parseKlines(raw);
        if (!candles.length) throw new Error("Пустая история");

        candlesRef.current = candles;
        const last = candles[candles.length - 1];
        setCurrentPrice(last.close);

        const priceStr = last.close.toString();
        const decimals = priceStr.includes(".") ? priceStr.split(".")[1].length : 2;
        candleSeries.applyOptions({
          priceFormat: {
            type: "price",
            precision: Math.min(Math.max(decimals, 2), 6),
            minMove: 10 ** -Math.min(Math.max(decimals, 2), 6),
          },
        });

        // Set candlestick data
        candleSeries.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );

        // Volume with Spike Detection (> 1.8x SMA20)
        const volData = candles.map((c, i) => {
          const slice = candles.slice(Math.max(0, i - 20), i);
          const avgVol = slice.length ? slice.reduce((acc, curr) => acc + curr.volume, 0) / slice.length : c.volume;
          const isSpike = c.volume > avgVol * 1.8;
          const isUp = c.close >= c.open;

          let color = isUp ? "rgba(34, 197, 94, 0.65)" : "rgba(239, 68, 68, 0.65)";
          if (isSpike) {
            color = isUp ? "#EAB308" : "#F97316"; // Gold (Up) or Orange (Down) Spike
          }

          return {
            time: c.time as UTCTimestamp,
            value: c.volume,
            color,
          };
        });

        volumeSeries.setData(volData);
        chart.timeScale().fitContent();
        setChartStatus("Binance Futures: Live");
      } catch (err) {
        if (!isDisposed) {
          setChartStatus("Ошибка загрузки истории Binance");
        }
      }
    };

    loadHistory().then(() => {
      if (isDisposed) return;
      // 6. Connect live WebSocket for real-time tick streaming
      const wsUrl = `wss://fstream.binance.com/ws/${cleanSymbol.toLowerCase()}@kline_${timeframe}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (isDisposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.k) {
            const k = msg.k;
            const time = Math.floor(k.t / 1000) as UTCTimestamp;
            const open = parseFloat(k.o);
            const high = parseFloat(k.h);
            const low = parseFloat(k.l);
            const close = parseFloat(k.c);
            const quoteVol = parseFloat(k.q); // Quote volume in USDT ($)

            const candle: MarketCandle = {
              time,
              open,
              high,
              low,
              close,
              volume: quoteVol,
            };

            if (!isValidCandle(candle)) return;

            setCurrentPrice(close);
            candleSeries.update({
              time,
              open,
              high,
              low,
              close,
            });

            // Update volume
            const isUp = close >= open;
            volumeSeries.update({
              time,
              value: quoteVol,
              color: isUp ? "rgba(34, 197, 94, 0.65)" : "rgba(239, 68, 68, 0.65)",
            });

            // Update cache
            const cache = candlesRef.current;
            if (cache.length) {
              const lastIdx = cache.length - 1;
              if (cache[lastIdx].time === time) {
                cache[lastIdx] = candle;
              } else if (time > cache[lastIdx].time) {
                cache.push(candle);
                if (cache.length > 1000) cache.shift();
              }
            }
          }
        } catch {}
      };
    });

    // 7. Click listener on chart to place levels (Uses refs, NEVER causes chart remount!)
    chart.subscribeClick((param) => {
      if (!param.point || !param.time || !candleSeriesRef.current) return;
      if (!levelToolActiveRef.current) return;

      const rawPrice = candleSeriesRef.current.coordinateToPrice(param.point.y);
      if (rawPrice === null) return;
      const clickedPrice = Number(rawPrice);

      const clickedTime = Number(param.time);
      let finalPrice = clickedPrice;
      let finalTime = clickedTime;
      let levelType: "HIGH" | "LOW" = "HIGH";

      if (magnetModeRef.current && candlesRef.current.length) {
        // Find candle at this clicked time or closest
        const candle = candlesRef.current.find((c) => c.time === clickedTime) || 
          candlesRef.current.reduce((prev, curr) => Math.abs(curr.time - clickedTime) < Math.abs(prev.time - clickedTime) ? curr : prev);

        if (candle) {
          const diffHigh = Math.abs(candle.high - clickedPrice);
          const diffLow = Math.abs(candle.low - clickedPrice);

          if (diffHigh <= diffLow) {
            finalPrice = candle.high;
            levelType = "HIGH";
          } else {
            finalPrice = candle.low;
            levelType = "LOW";
          }
          finalTime = candle.time;
        }
      }

      const newLevel: UserLevel = {
        id: `level_${Date.now()}`,
        price: finalPrice,
        time: finalTime,
        type: levelType,
        createdAt: Date.now(),
      };

      const updated = [...userLevelsRef.current, newLevel];
      saveLevels(updated);
      setLevelToolActive(false); // Turn off tool after single placement
    });

    return () => {
      isDisposed = true;
      abortCtrl.abort();
      resizeObserver.disconnect();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
      }
      // Remove level series before destroying chart
      levelSeriesRef.current = [];
      chart.remove();
      chartRef.current = null;
    };
  }, [cleanSymbol, timeframe, saveLevels]); // STABLE DEPENDENCIES: Never re-creates chart on tool clicks!

  // Sync native level LineSeries whenever userLevels or currentPrice changes
  useEffect(() => {
    syncLevelSeries();
  }, [userLevels, currentPrice, syncLevelSeries]);

  // Render Order Book Walls as Native PriceLines (Zero Lag)
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    wallLinesRef.current.forEach((line) => {
      try { series.removePriceLine(line); } catch {}
    });
    wallLinesRef.current = [];

    if (!showWalls || !bookWalls.length) return;

    bookWalls.slice(0, 6).forEach((wall) => {
      const isBid = wall.side === "bid";
      const isSolid = wall.status === "solid" || wall.ageSeconds >= 180;
      const isConfirmed = wall.status === "confirmed" || wall.ageSeconds >= 60;

      let color = isBid ? "#22C55E" : "#EF4444";
      let lineWidth = 1;
      let lineStyle = LineStyle.Dashed;

      if (isSolid) {
        color = "#F59E0B";
        lineWidth = 2;
        lineStyle = LineStyle.Solid;
      } else if (isConfirmed) {
        lineWidth = 2;
        lineStyle = LineStyle.Dashed;
      } else {
        color = "#64748B";
      }

      const ageStr = wall.ageSeconds >= 60 
        ? `${Math.floor(wall.ageSeconds / 60)}м` 
        : `${wall.ageSeconds}с`;

      const badge = isSolid 
        ? `🛡️ 3м+` 
        : isConfirmed 
        ? `⏱️ ${ageStr}` 
        : `◇ ${ageStr}`;

      try {
        const line = series.createPriceLine({
          price: wall.price,
          color,
          lineWidth: lineWidth as any,
          lineStyle,
          axisLabelVisible: true,
          title: `${isBid ? "BID" : "ASK"} ${formatNotional(wall.notional)} (${badge})`,
        });
        wallLinesRef.current.push(line);
      } catch {}
    });
  }, [bookWalls, showWalls]);

  // Toggle Volume visibility
  useEffect(() => {
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.applyOptions({
        visible: showVolume,
      });
    }
  }, [showVolume]);

  const deleteLevel = (id: string) => {
    saveLevels(userLevels.filter((lvl) => lvl.id !== id));
  };

  const clearAllLevels = () => {
    saveLevels([]);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0B0F14] overflow-hidden select-none border-t border-[#1E2936]">
      {/* Scalper Top Toolbar */}
      <div className="h-11 flex-shrink-0 flex items-center justify-between px-3 bg-[#10161F] border-b border-[#1E2936] text-xs">
        {/* Left: Ticker, Price & Candle Countdown */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-bold">
            <span className="text-white text-sm tracking-wide">{symbol}</span>
            {tickerInfo && (
              <span className={`font-mono text-xs ${tickerInfo.change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {tickerInfo.change >= 0 ? "+" : ""}{tickerInfo.change.toFixed(2)}%
              </span>
            )}
          </div>

          {currentPrice && (
            <div className="flex items-center gap-2 pl-2 border-l border-[#1E2936]">
              <span className="font-mono text-cyan-300 font-bold text-sm">
                ${formatPrice(currentPrice)}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-slate-400 font-mono bg-[#141C26] px-2 py-0.5 rounded border border-[#1E2936]" title="Время до закрытия текущей свечи">
                <Timer size={12} className="text-cyan-400" />
                {countdown}
              </span>
            </div>
          )}

          {/* Timeframe Buttons */}
          <div className="flex items-center gap-1 ml-3 bg-[#141C26] p-0.5 rounded border border-[#1E2936]">
            {(["1m", "5m", "15m", "1h", "4h", "1d"] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                className={`px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
                  timeframe === tf ? "bg-[#1E2936] text-cyan-400 font-bold" : "text-slate-400 hover:text-slate-200"
                }`}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Scalper Tools & Toggles */}
        <div className="flex items-center gap-2">
          {/* Level Drawing Tool */}
          <button
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-semibold transition-all ${
              levelToolActive 
                ? "bg-purple-950/80 border-purple-500 text-purple-300 ring-2 ring-purple-500/30" 
                : "bg-[#141C26] border-[#1E2936] text-slate-300 hover:border-slate-600"
            }`}
            onClick={() => setLevelToolActive(!levelToolActive)}
            title="Кликните на вершину свечи, чтобы провести уровень вправо (луч)"
          >
            <Target size={13} className={levelToolActive ? "text-purple-400 animate-pulse" : "text-slate-400"} />
            <span>{levelToolActive ? "Кликните на хай/лоу..." : "Уровень (H)"}</span>
          </button>

          {/* Magnet Snap Toggle */}
          <button
            className={`p-1.5 rounded border text-[11px] transition-colors ${
              magnetMode 
                ? "bg-cyan-950/60 border-cyan-500 text-cyan-300" 
                : "bg-[#141C26] border-[#1E2936] text-slate-500 hover:text-slate-300"
            }`}
            onClick={() => setMagnetMode(!magnetMode)}
            title={`Магнит к вершинам свечей: ${magnetMode ? "ВКЛ (привязка к High/Low)" : "ВЫКЛ"}`}
          >
            <Magnet size={14} />
          </button>

          {/* Book Walls Toggle */}
          <button
            className={`flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] font-semibold transition-colors ${
              showWalls 
                ? "bg-[#141C26] border-emerald-900/60 text-emerald-400" 
                : "bg-[#141C26] border-[#1E2936] text-slate-500"
            }`}
            onClick={() => setShowWalls(!showWalls)}
            title="Отображение плотностей стакана на графике"
          >
            <Layers size={13} />
            <span>Плотности ({bookWalls.length})</span>
          </button>

          {/* Volumes Toggle */}
          <button
            className={`flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] font-semibold transition-colors ${
              showVolume 
                ? "bg-[#141C26] border-slate-700 text-slate-200" 
                : "bg-[#141C26] border-[#1E2936] text-slate-500"
            }`}
            onClick={() => setShowVolume(!showVolume)}
            title="Показать / скрыть объёмы"
          >
            <BarChart3 size={13} />
          </button>

          {/* Clear Levels */}
          {userLevels.length > 0 && (
            <button
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#141C26] border border-rose-900/50 text-rose-400 hover:bg-rose-950/50 text-[11px]"
              onClick={clearAllLevels}
              title="Удалить все нарисованные уровни"
            >
              <Trash2 size={12} />
              <span>{userLevels.length}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Chart Canvas Container */}
      <div className="relative flex-1 w-full h-full min-h-0">
        {/* TradingView Chart Container */}
        <div ref={containerRef} className="w-full h-full" />

        {/* Floating Active Levels Pills (Quick Delete) */}
        {userLevels.length > 0 && (
          <div className="absolute top-2 left-2 z-20 flex flex-wrap gap-1.5 max-w-xl pointer-events-auto">
            {userLevels.map((lvl) => (
              <span
                key={lvl.id}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#10161F]/90 border border-purple-500/40 text-purple-300 font-mono text-[11px] backdrop-blur-sm shadow-md"
              >
                <span>${formatPrice(lvl.price)}</span>
                <span className="text-[10px] text-slate-400">({lvl.type})</span>
                <button
                  onClick={() => deleteLevel(lvl.id)}
                  className="hover:text-rose-400 text-slate-500 transition-colors ml-0.5"
                  title="Удалить этот уровень"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Volume Legend Tip */}
        {showVolume && (
          <div className="absolute bottom-2 left-3 z-20 text-[10px] text-slate-500 font-mono flex items-center gap-2 pointer-events-none">
            <span>Объём в USDT ($)</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-yellow-400" />
              <span>Всплеск объёма (&gt;1.8x)</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
