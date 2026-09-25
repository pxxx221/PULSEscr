import { fetchMarketJson, parseKlines, isValidCandle, marketError } from "../services/marketData";
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createChart, IChartApi, ISeriesApi, UTCTimestamp, CandlestickSeries, LineSeries, HistogramSeries } from "lightweight-charts";
import { MoveHorizontal, Trash2, LineChart, Ruler, Landmark, Magnet, Copy, Check, Activity, Share2, GitBranch, Timer } from "lucide-react";
import { Timeframe, TickerData } from "../types";
import { findCleanSwingLevels, closedFiveMinuteCandles, isLiquidityLevelActive, CleanScalperLevel, ScannerCandle } from "../utils/liquidityScanner";
import { detectMarketStructure, MarketStructureResult } from "../utils/marketStructure";
import { BookWall } from "../services/orderBookWalls";

interface TradingChartProps {
  symbol: string; // e.g. "BTC/USDT" or "BTCUSDT"
  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  squeezeSensitivity: number;
  markets?: Record<string, TickerData>;
  onPoolsChange?: (pools: { price: number; type: "BSL" | "SSL" }[]) => void;
  confirmedLevel?: any;
  bookWalls?: BookWall[];
}

// Precise and clean price formatter for chart labels and badges
export const formatChartPrice = (price: number): string => {
  if (typeof price !== "number" || isNaN(price) || price <= 0) return "0.00";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 10) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
};

// Check if a given horizontal price line slices straight through the bodies of candles
export const isLevelSlicedByCandles = (
  price: number,
  candles: HistoricalCandle[]
): boolean => {
  if (!candles || candles.length < 10 || typeof price !== "number" || isNaN(price) || price <= 0) return false;
  let slicedCount = 0;
  // Inspect the last 70 candles
  const windowCandles = candles.slice(-70);
  for (const c of windowCandles) {
    const bodyMin = Math.min(c.open, c.close);
    const bodyMax = Math.max(c.open, c.close);
    // If candle body spans across the price line (not just wick touching, but real body crossing)
    if (bodyMin < price && bodyMax > price) {
      slicedCount++;
    }
  }
  // If 2 or more candle bodies slice straight through this price, it is not a clean shelf level
  return slicedCount >= 2;
};

interface HistoricalCandle {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Robust backward-compatible canvas rounded rect helper
const drawRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) => {
  if (typeof (ctx as any).roundRect === "function") {
    (ctx as any).roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
};

// High-fidelity Web Audio API synthesizer for short, crisp directional notification sounds
const playDirectionalTone = (type: "BSL" | "SSL") => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    const now = ctx.currentTime;
    
    if (type === "BSL") {
      // Long-Impulse (BSL Proboy / Shorts stop-run) - Higher pitched bell/chirp
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now); // A5 note
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
      osc.frequency.exponentialRampToValueAtTime(800, now + 0.15);
      
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.12, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      
      osc.start(now);
      osc.stop(now + 0.25);
    } else {
      // Short-Dump (SSL Proboy / Longs stop-run) - Deep bassy kick/knock
      osc.type = "triangle";
      osc.frequency.setValueAtTime(180, now); // G3 note
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.12);
      
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.20, now + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (err) {
    console.warn("Failed to play directional sound alert:", err);
  }
};

// Clean Scalper Levels detection helper (deep 180 candles on 5m = ~15 hours of market structure)
const detectLiquidityPools = (history: HistoricalCandle[]): CleanScalperLevel[] => {
  if (!history || history.length < 15) return [];
  const last180 = closedFiveMinuteCandles(history).slice(-180);
  return findCleanSwingLevels(last180);
};

export default function TradingChart({
  symbol,
  timeframe,
  setTimeframe,
  squeezeSensitivity,
  markets,
  onPoolsChange,
  confirmedLevel,
  bookWalls = [],
}: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  // States
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<string>("");

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

  const currentPriceRef = useRef<number | null>(null);
  useEffect(() => {
    currentPriceRef.current = currentPrice;
    updateCanvasRef.current?.();
  }, [currentPrice]);

  // Liquidity Void Elasticity (Эластичность Вакуума)
  const [elasticityEvents, setElasticityEvents] = useState<{
    id: string;
    price: number;
    type: "BSL" | "SSL";
    coefficient: number;
    timestamp: number;
    phase: "measuring" | "display";
    triggerTime: number;
    strength: "STRONG" | "MEDIUM" | "WEAK";
  }[]>([]);

  const elasticityEventsRef = useRef(elasticityEvents);
  useEffect(() => {
    elasticityEventsRef.current = elasticityEvents;
    if (updateCanvasRef.current) {
      updateCanvasRef.current();
    }
  }, [elasticityEvents]);

  const handleCopy = () => {
    try {
      const cleanTicker = symbol.replace("/", "");
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(cleanTicker).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch((err) => {
          console.warn("Clipboard copy unavailable:", err);
        });
      } else {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (e) {
      console.warn("Clipboard exception:", e);
    }
  };
  const [activeTool, setActiveTool] = useState<"hline" | "tline" | "ruler" | null>(null);
  const activeToolRef = useRef<"hline" | "tline" | "ruler" | null>(null);
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);
  const [magnetMode, setMagnetMode] = useState<boolean>(false);
  const ctrlPressedRef = useRef<boolean>(false);
  const [isShiftPressed, setIsShiftPressed] = useState<boolean>(false);
  const isShiftPressedRef = useRef<boolean>(false);
  const updateCanvasRef = useRef<(() => void) | undefined>(undefined);

  // Ruler card bounding box for close button [X] detection
  const rulerCardRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    closeX: number;
    closeY: number;
    closeW: number;
    closeH: number;
  } | null>(null);

  // Active tool dragging state (for both drag-to-draw and click-move-click)
  const toolDrawingRef = useRef<{
    tool: "hline" | "tline" | "ruler";
    isMouseDown: boolean;
    startX: number;
    startY: number;
    startTime: number;
    startPrice: number;
    hasDragged: boolean;
  } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control") {
        ctrlPressedRef.current = true;
        setMagnetMode(true);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
      if (e.key === "Shift" && !e.repeat) {
        isShiftPressedRef.current = true;
        setIsShiftPressed(true);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") {
        ctrlPressedRef.current = false;
        setMagnetMode(false);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
      if (e.key === "Shift") {
        isShiftPressedRef.current = false;
        setIsShiftPressed(false);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [chartStatus, setChartStatus] = useState('Загрузка свечей Binance…');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [levelsError, setLevelsError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  
  // Cache of candles for drawings and magnet mode
  const candlesCacheRef = useRef<HistoricalCandle[]>([]);
  
  // Drawings State
  const [hLines, setHLines] = useState<{ id: string; price: number }[]>([]);
  const [tLines, setTLines] = useState<{ id: string; p1: { time: number; price: number }; p2: { time: number; price: number } }[]>([]);
  const [rulers, setRulers] = useState<{ id: string; p1: { time: number; price: number }; p2: { time: number; price: number } }[]>([]);
  
  // Interactive Drawing states
  const [hoveredDrawing, setHoveredDrawing] = useState<{ type: "tline" | "hline" | "ruler"; id: string; part?: "p1" | "p2" } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<{ type: "tline" | "hline" | "ruler"; id: string } | null>(null);

  // Liquidity Pools State (Clean Scalper Levels BSL / SSL on 5m)
  const [liquidityPools, setLiquidityPools] = useState<CleanScalperLevel[]>([]);
  const liquidityPoolsRef = useRef(liquidityPools);
  const bookWallsRef = useRef(bookWalls);
  useEffect(() => {
    bookWallsRef.current = bookWalls;
    updateCanvasRef.current?.();
  }, [bookWalls]);
  const candles5mCacheRef = useRef<HistoricalCandle[]>([]);

  // Clean Scalper Levels Filter ("ALL" = Оба варианта, "SWING_MACRO" = Дневные экстремумы, "LOCAL_SHELF" = Локальные полки)
  const [levelFilter, setLevelFilter] = useState<"ALL" | "SWING_MACRO" | "LOCAL_SHELF">("ALL");
  const levelFilterRef = useRef<"ALL" | "SWING_MACRO" | "LOCAL_SHELF">("ALL");
  useEffect(() => {
    levelFilterRef.current = levelFilter;
    if (updateCanvasRef.current) {
      updateCanvasRef.current();
    }
  }, [levelFilter]);

  // Market Structure State (CHoCH / BOS / Swings / Key Defensive Pivots)
  const [showStructure, setShowStructure] = useState<boolean>(true);
  const showStructureRef = useRef<boolean>(true);
  const [showLegend, setShowLegend] = useState<boolean>(false);
  const [marketStructure, setMarketStructure] = useState<MarketStructureResult | null>(null);
  const marketStructureRef = useRef<MarketStructureResult | null>(null);

  useEffect(() => {
    showStructureRef.current = showStructure;
    if (updateCanvasRef.current) {
      updateCanvasRef.current();
    }
  }, [showStructure]);

  useEffect(() => {
    liquidityPoolsRef.current = liquidityPools;
    updateCanvasRef.current?.();
    if (onPoolsChange) {
      onPoolsChange(liquidityPools.map(p => ({ price: p.price, type: p.type })));
    }
  }, [liquidityPools, onPoolsChange]);

  // Refs for drawing interactiveness
  const hLinesRef = useRef<{ id: string; price: number }[]>([]);
  const tLinesRef = useRef<{ id: string; p1: { time: number; price: number }; p2: { time: number; price: number } }[]>([]);
  const rulersRef = useRef<{ id: string; p1: { time: number; price: number }; p2: { time: number; price: number } }[]>([]);
  
  const draggingDrawingRef = useRef<{
    type: "tline" | "hline" | "ruler";
    id: string;
    part?: "p1" | "p2";
    startMouseX: number;
    startMouseY: number;
    startMouseTime?: number;
    startMousePrice?: number;
    startP1?: { time: number; price: number };
    startP2?: { time: number; price: number };
    startPrice?: number;
  } | null>(null);

  const drawnHLinesRef = useRef<any[]>([]); // Deprecated, left for reference compatibility
  const drawnTLinesRef = useRef<{ id: string; series: any }[]>([]); // Deprecated, left for reference compatibility

  // Ruler & Trendline temp drawing states
  const rulerStartRef = useRef<{ time: number; price: number } | null>(null);
  const tlineStartRef = useRef<{ time: number; price: number } | null>(null);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const binanceSymbol = symbol.replace("/", "").toUpperCase();

  // Load Saved Drawings and Alerts on Mount / Symbol change
  useEffect(() => {
    try {
      const savedHLines = localStorage.getItem(`hLines_${binanceSymbol}`);
      const savedTLines = localStorage.getItem(`tLines_${binanceSymbol}`);
      const savedRulers = localStorage.getItem(`rulers_${binanceSymbol}`);
      
      const parsedHLRaw = savedHLines ? JSON.parse(savedHLines) : [];
      const parsedHL = parsedHLRaw.map((item: any, idx: number) => {
        if (typeof item === "number") {
          return { id: `hline-${idx}-${Math.random()}`, price: item };
        }
        return item;
      });

      const parsedTL = savedTLines ? JSON.parse(savedTLines) : [];
      const parsedRulers = savedRulers ? JSON.parse(savedRulers) : [];
      
      setHLines(parsedHL);
      setTLines(parsedTL);
      setRulers(parsedRulers);
      
      hLinesRef.current = parsedHL;
      tLinesRef.current = parsedTL;
      rulersRef.current = parsedRulers;
    } catch (e) {
      console.warn("Failed to load drawings", e);
    }
  }, [binanceSymbol]);

  const distToSegment = useCallback((px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
  }, []);

  const findClosestCandle = useCallback((time: number) => {
    if (candlesCacheRef.current.length === 0) return null;
    let closestCandle = candlesCacheRef.current[0];
    let minDiff = Math.abs(closestCandle.time - time);
    for (let i = 1; i < candlesCacheRef.current.length; i++) {
      const diff = Math.abs(candlesCacheRef.current[i].time - time);
      if (diff < minDiff) {
        minDiff = diff;
        closestCandle = candlesCacheRef.current[i];
      }
    }
    return closestCandle;
  }, []);

  // Magnet mode snapping function
  const findMagnetPrice = useCallback((time: number, rawPrice: number) => {
    const isMagnet = magnetMode || ctrlPressedRef.current;
    if (!isMagnet) return rawPrice;
    
    const closestCandle = findClosestCandle(time);
    if (!closestCandle) return rawPrice;

    // Distances from high, low, open, close (OHLC - similar to TradingView)
    const choices = [
      { v: closestCandle.high, d: Math.abs(closestCandle.high - rawPrice) },
      { v: closestCandle.low, d: Math.abs(closestCandle.low - rawPrice) },
      { v: closestCandle.open, d: Math.abs(closestCandle.open - rawPrice) },
      { v: closestCandle.close, d: Math.abs(closestCandle.close - rawPrice) },
    ];
    choices.sort((a, b) => a.d - b.d);
    return choices[0].v;
  }, [magnetMode, findClosestCandle]);

  // Clear All drawings helper
  const handleClearDrawings = () => {
    drawnHLinesRef.current = [];
    drawnTLinesRef.current = [];
    hLinesRef.current = [];
    tLinesRef.current = [];
    rulersRef.current = [];
    
    setHLines([]);
    setTLines([]);
    setRulers([]);
    setHoveredDrawing(null);
    setSelectedDrawing(null);

    rulerStartRef.current = null;
    tlineStartRef.current = null;

    localStorage.removeItem(`hLines_${binanceSymbol}`);
    localStorage.removeItem(`tLines_${binanceSymbol}`);
    localStorage.removeItem(`rulers_${binanceSymbol}`);

    // Redraw empty canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  // Main Chart Initialization
  useEffect(() => {
    if (!containerRef.current) return;

    setIsSyncing(true);
    let isDisposed = false;
    const requests = new AbortController();
    let lastCandleMessage = 0;
    let levelsLoading = false;
    setCurrentPrice(null);
    setLiquidityPools([]);
    setMarketStructure(null);
    marketStructureRef.current = null;
    candlesCacheRef.current = [];
    candles5mCacheRef.current = [];
    setHistoryError(null);
    setLevelsError(null);
    setChartStatus('Загрузка свечей Binance…');

    const initialWidth = containerRef.current.clientWidth || containerRef.current.offsetWidth || 800;

    let chartInstance: IChartApi;
    try {
      chartInstance = createChart(containerRef.current, {
        width: initialWidth,
        height: containerRef.current.clientHeight || 520,
        layout: {
          background: { color: "#0B0F14" }, 
          textColor: "#94a3b8",
          fontFamily: "'Inter', sans-serif",
        },
        grid: {
          vertLines: { color: "#151D27" },
          horzLines: { color: "#151D27" },
        },
        crosshair: {
          mode: 0, // CrosshairMode.Normal (0)
        },
        rightPriceScale: {
          borderColor: "#1F2937",
          autoScale: true,
        },
        timeScale: {
          borderColor: "#1F2937",
          timeVisible: true,
          secondsVisible: false,
        },
      });
    } catch (err) {
      console.error("Failed to create lightweight-chart instance:", err);
      setIsSyncing(false);
      return;
    }

    const candleSeries = chartInstance.addSeries(CandlestickSeries, {
      priceFormat: {
        type: 'price',
        precision: formatChartPrice(markets?.[symbol]?.price || 1).split('.')[1]?.length || 2,
        minMove: 10 ** -(formatChartPrice(markets?.[symbol]?.price || 1).split('.')[1]?.length || 2),
      },
      upColor: "#32B79A", // Emerald-500
      downColor: "#DE6370", // Red-500
      borderUpColor: "#32B79A",
      borderDownColor: "#DE6370",
      wickUpColor: "#32B79A",
      wickDownColor: "#DE6370",
    });

    chartRef.current = chartInstance;
    seriesRef.current = candleSeries;

    try {
      const volumeSeries = chartInstance.addSeries(HistogramSeries, {
        lastValueVisible: false,
        priceLineVisible: false,
        color: '#26a69a',
        priceFormat: {
          type: 'volume',
        },
        priceScaleId: 'vol_overlay',
      });

      try {
        const pScale = chartInstance.priceScale('vol_overlay');
        if (pScale && typeof pScale.applyOptions === "function") {
          pScale.applyOptions({
            scaleMargins: {
              top: 0.8,
              bottom: 0,
            },
            visible: false,
          });
        }
      } catch (e) {
        // Price scale customization optional
      }
      volumeSeriesRef.current = volumeSeries;
    } catch (e) {
      console.warn("Could not create volume overlay series:", e);
    }

    // Redraw drawings/rulers on scroll or zoom
    chartInstance.timeScale().subscribeVisibleTimeRangeChange(() => {
      if (updateCanvasRef.current) {
        updateCanvasRef.current();
      }
    });

    // Handle Resizing
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || !containerRef.current || isDisposed) return;
      const { width, height } = entries[0].contentRect;
      try {
        chartInstance.resize(width, height);
      } catch (e) {
        // safe handle
      }
      
      const canvas = canvasRef.current;
      if (canvas && (canvas.width !== width || canvas.height !== height)) {
        canvas.width = width;
        canvas.height = height;
      }
    });

    resizeObserver.observe(containerRef.current);

    const fetch5mKlines = async (): Promise<HistoricalCandle[]> => {
      const raw = await fetchMarketJson(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=5m&limit=180`,
        7000, requests.signal);
      return parseKlines(raw);
    };

    // Initial klines fetch (Binance Futures)
    const fetchKlines = async () => {
      try {
        const data = await fetchMarketJson(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${timeframe}&limit=250`,
          7000, requests.signal);

        if (isDisposed) return;

        if (Array.isArray(data)) {
          const loadedCandles: HistoricalCandle[] = parseKlines(data);
          const observedPrice = loadedCandles[loadedCandles.length - 1].close;
          const decimals = formatChartPrice(observedPrice).split('.')[1]?.length || 2;
          candleSeries.applyOptions({ priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals } });
          setHistoryError(null);

          candlesCacheRef.current = loadedCandles;
          candleSeries.setData(loadedCandles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })));
          
          if (volumeSeriesRef.current) {
            try {
              volumeSeriesRef.current.setData(loadedCandles.map((c) => ({
                time: c.time as UTCTimestamp,
                value: c.volume,
                color: c.close >= c.open ? "rgba(50, 183, 154, 0.25)" : "rgba(222, 99, 112, 0.25)",
              })));
            } catch (e) {}
          }

          // Fetch 5m candles specifically for MTF Clean Scalper Level Detection
          let loaded5m: HistoricalCandle[] = [];
          if (timeframe === "5m") {
            loaded5m = loadedCandles;
          } else {
            try { loaded5m = await fetch5mKlines(); }
            catch (e) { if (!isDisposed) setLevelsError('Уровни 5m недоступны: ' + marketError(e)); }
            if (isDisposed) return;
          }

          if (loaded5m && loaded5m.length >= 15) {
            candles5mCacheRef.current = loaded5m;
            const pools = detectLiquidityPools(loaded5m);
            setLiquidityPools(pools);
          } else {
            setLiquidityPools([]);
          }

          // Calculate Market Structure (CHoCH / BOS / Key Pivots)
          const structure = detectMarketStructure(loadedCandles);
          setMarketStructure(structure);
          marketStructureRef.current = structure;

          if (loadedCandles.length > 0) {
            setCurrentPrice(loadedCandles[loadedCandles.length - 1].close);
          }

          chartInstance.timeScale().fitContent();
          chartInstance.timeScale().setVisibleLogicalRange({ from: Math.max(0, candlesCacheRef.current.length - 130), to: candlesCacheRef.current.length + 8 });
        }
      } catch (err) {
        if (!isDisposed) {
          setHistoryError('История свечей недоступна: ' + marketError(err));
          setChartStatus('Нет истории Binance. Повторите загрузку.');
        }
      } finally {
        if (!isDisposed) {
          setIsSyncing(false);
        }
      }
    };

    fetchKlines().finally(() => { if (!isDisposed) startChartWS(); });

    // WS connection for active symbol kline updates with auto-reconnect & fallback
    let ws: WebSocket | null = null;
    let wsReconnectTimer: any = null;

    const startChartWS = () => {
      if (isDisposed) return;
      try {
        const wsUrl = `wss://fstream.binance.com/market/ws/${binanceSymbol.toLowerCase()}@kline_${timeframe}`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        setChartStatus('Ожидание свечей Binance…');

        ws.onmessage = (event) => {
          if (isDisposed) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.k) {
              const kline = msg.k;
              const timestampSec = Math.floor(kline.t / 1000);
              const candleData: HistoricalCandle = {
                time: timestampSec,
                open: parseFloat(kline.o),
                high: parseFloat(kline.h),
                low: parseFloat(kline.l),
                close: parseFloat(kline.c),
                volume: parseFloat(kline.v),
              };

              if (!isValidCandle(candleData)) return;
              const cached = candlesCacheRef.current;
              if (cached.length && timestampSec < cached[cached.length - 1].time) return;
              lastCandleMessage = Date.now();
              setChartStatus('Свечи Binance обновляются');
              const index = cached.findIndex((c) => c.time === timestampSec);
              if (index !== -1) {
                cached[index] = candleData;
              } else {
                cached.push(candleData);
              }

              if (cached.length > 1000) cached.shift();
              if (timeframe === '5m') candles5mCacheRef.current = cached.slice(-200);
              if (kline.x === true || kline.x === "true") {
                if (timeframe === '5m') setLiquidityPools(detectLiquidityPools(candles5mCacheRef.current));
                else if (!levelsLoading) {
                  levelsLoading = true;
                  fetch5mKlines().then(candles => {
                    if (isDisposed) return;
                    candles5mCacheRef.current = candles;
                    setLevelsError(null);
                    setLiquidityPools(detectLiquidityPools(candles));
                  }).catch(e => {
                     if (!isDisposed) setLevelsError('Уровни 5m недоступны: ' + marketError(e));
                  }).finally(() => { levelsLoading = false; });
                }
                const structure = detectMarketStructure(cached);
                setMarketStructure(structure);
                marketStructureRef.current = structure;
              }

              candleSeries.update({
                time: timestampSec as UTCTimestamp,
                open: candleData.open,
                high: candleData.high,
                low: candleData.low,
                close: candleData.close,
              });
              
              if (volumeSeriesRef.current) {
                try {
                  volumeSeriesRef.current.update({
                    time: timestampSec as UTCTimestamp,
                    value: candleData.volume,
                    color: candleData.close >= candleData.open ? "rgba(50, 183, 154, 0.25)" : "rgba(222, 99, 112, 0.25)",
                  });
                } catch (e) {}
              }

              setCurrentPrice(candleData.close);
            }
          } catch (err) {
            // ws err
          }
        };

        ws.onerror = () => {
          if (!isDisposed) {
            setChartStatus('Связь с Binance потеряна. Показаны последние полученные свечи.');
          }
        };

        ws.onclose = () => {
          if (!isDisposed) {
            setChartStatus('Связь с Binance потеряна. Показаны последние полученные свечи.');
            // Retry connecting after 4 seconds when network/VPN recovers
            wsReconnectTimer = setTimeout(startChartWS, 4000);
          }
        };
      } catch (e) {
        if (!isDisposed) {
          setChartStatus('Не удалось подключиться к Binance. Повторяем подключение…');
          wsReconnectTimer = setTimeout(startChartWS, 5000);
        }
      }
    };

    const freshnessTimer = setInterval(() => {
      if (!lastCandleMessage || Date.now() - lastCandleMessage > 15000) {
        setChartStatus('Нет свежих свечей Binance. Показаны последние полученные данные.');
      }
    }, 5000);

    const levelsTimer = timeframe === '5m' ? null : window.setInterval(() => {
      if (isDisposed || levelsLoading) return;
      levelsLoading = true;
      fetch5mKlines().then((candles) => {
        if (isDisposed) return;
        candles5mCacheRef.current = candles;
        setLevelsError(null);
        setLiquidityPools(detectLiquidityPools(candles));
      }).catch((error) => {
        if (!isDisposed) setLevelsError('Уровни 5m недоступны: ' + marketError(error));
      }).finally(() => { levelsLoading = false; });
    }, 60_000);

    // Click handler for lightweight-charts
    chartInstance.subscribeClick(() => {
      // Drawing creations are handled with full drag-and-drop & sub-pixel precision by canvas overlay capture handlers
    });

    return () => {
      isDisposed = true;
      requests.abort();
      clearInterval(freshnessTimer);
      if (levelsTimer !== null) clearInterval(levelsTimer);
      chartRef.current = null;
      seriesRef.current = null;
      resizeObserver.disconnect();
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
      }
      try {
        chartInstance.remove();
      } catch (e) {
        // safe handle
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch (e) {}
      }

    };
  }, [binanceSymbol, timeframe, retry]);

  const getMouseTimeAndPrice = useCallback((x: number, y: number) => {
    if (!chartRef.current || !seriesRef.current) return null;
    const timeScale = chartRef.current.timeScale();
    const price = seriesRef.current.coordinateToPrice(y);
    if (price === null) return null;

    let time = timeScale.coordinateToTime(x) as number | null;
    if (time === null && candlesCacheRef.current.length > 0) {
      const lastCandle = candlesCacheRef.current[candlesCacheRef.current.length - 1];
      const firstCandle = candlesCacheRef.current[0];
      const lastX = timeScale.timeToCoordinate(lastCandle.time as UTCTimestamp);
      const firstX = timeScale.timeToCoordinate(firstCandle.time as UTCTimestamp);

      if (lastX !== null && x > lastX && candlesCacheRef.current.length > 1) {
        const prevCandle = candlesCacheRef.current[candlesCacheRef.current.length - 2];
        const prevX = timeScale.timeToCoordinate(prevCandle.time as UTCTimestamp);
        const barPx = prevX !== null ? Math.max(2, lastX - prevX) : 8;
        const timeDiff = lastCandle.time - prevCandle.time;
        const offsetBars = Math.round((x - lastX) / barPx);
        time = lastCandle.time + offsetBars * timeDiff;
      } else if (firstX !== null && x < firstX && candlesCacheRef.current.length > 1) {
        const nextCandle = candlesCacheRef.current[1];
        const nextX = timeScale.timeToCoordinate(nextCandle.time as UTCTimestamp);
        const barPx = nextX !== null ? Math.max(2, nextX - firstX) : 8;
        const timeDiff = nextCandle.time - firstCandle.time;
        const offsetBars = Math.round((firstX - x) / barPx);
        time = firstCandle.time - offsetBars * timeDiff;
      } else {
        time = lastCandle.time;
      }
    }

    return { time: time ?? Math.floor(Date.now() / 1000), price };
  }, []);

  const findHoveredDrawing = useCallback((mx: number, my: number) => {
    if (!chartRef.current || !seriesRef.current) return null;
    const timeScale = chartRef.current.timeScale();
    const snapDistance = 10; // pixels to snap to nodes or lines

    // Check horizontal lines
    for (const hl of hLinesRef.current) {
      const y = seriesRef.current.priceToCoordinate(hl.price);
      if (y !== null && Math.abs(my - y) < snapDistance) {
        return { type: "hline" as const, id: hl.id };
      }
    }

    // Check trendlines
    for (const tl of tLinesRef.current) {
      const x1 = timeScale.timeToCoordinate(tl.p1.time as UTCTimestamp);
      const y1 = seriesRef.current.priceToCoordinate(tl.p1.price);
      const x2 = timeScale.timeToCoordinate(tl.p2.time as UTCTimestamp);
      const y2 = seriesRef.current.priceToCoordinate(tl.p2.price);

      if (x1 !== null && y1 !== null) {
        if (Math.sqrt((mx - x1) ** 2 + (my - y1) ** 2) < snapDistance) {
          return { type: "tline" as const, id: tl.id, part: "p1" as const };
        }
      }
      if (x2 !== null && y2 !== null) {
        if (Math.sqrt((mx - x2) ** 2 + (my - y2) ** 2) < snapDistance) {
          return { type: "tline" as const, id: tl.id, part: "p2" as const };
        }
      }
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        if (distToSegment(mx, my, x1, y1, x2, y2) < snapDistance - 2) {
          return { type: "tline" as const, id: tl.id };
        }
      }
    }

    // Check rulers - handles and borders ONLY (never block the interior so chart panning stays buttery smooth)
    for (const r of rulersRef.current) {
      const x1 = timeScale.timeToCoordinate(r.p1.time as UTCTimestamp);
      const y1 = seriesRef.current.priceToCoordinate(r.p1.price);
      const x2 = timeScale.timeToCoordinate(r.p2.time as UTCTimestamp);
      const y2 = seriesRef.current.priceToCoordinate(r.p2.price);

      if (x1 !== null && y1 !== null) {
        if (Math.sqrt((mx - x1) ** 2 + (my - y1) ** 2) < 12) {
          return { type: "ruler" as const, id: r.id, part: "p1" as const };
        }
      }
      if (x2 !== null && y2 !== null) {
        if (Math.sqrt((mx - x2) ** 2 + (my - y2) ** 2) < 12) {
          return { type: "ruler" as const, id: r.id, part: "p2" as const };
        }
      }
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        const bounds = [
          distToSegment(mx, my, x1, y1, x2, y1), // top
          distToSegment(mx, my, x1, y2, x2, y2), // bottom
          distToSegment(mx, my, x1, y1, x1, y2), // left
          distToSegment(mx, my, x2, y1, x2, y2), // right
        ];
        const minBoundDist = Math.min(...bounds);
        if (minBoundDist < 6) {
          return { type: "ruler" as const, id: r.id };
        }
      }
    }

    return null;
  }, [distToSegment]);

  // Continuous Canvas drawing on mouse move (for rubber-band trendline or scalper ruler)
  const drawOverlayCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw "Liquidity Void Elasticity" (Эластичность Вакуума) indicators floating next to crossed levels
    const activeEvents = elasticityEventsRef.current || [];
    activeEvents.forEach((ev) => {
      if (ev.phase !== "display") return;

      const y = seriesRef.current!.priceToCoordinate(ev.price);
      if (y === null || y === undefined) return;

      // Calculate elegant linear fade-out over the last 1.5 seconds of the 61.5s window
      const elapsed = Date.now() - ev.timestamp;
      let opacity = 1.0;
      if (elapsed > 60000) {
        opacity = Math.max(0, 1.0 - (elapsed - 60000) / 1500);
      }
      if (opacity <= 0) return;

      ctx.save();
      
      // Determine label text and color scheme based on elasticity coefficient
      let labelText = "";
      let neonColor = "";
      let borderGlow = "";
      
      if (ev.coefficient >= 70) {
        labelText = `[ПРУЖИНА: Жесткая ${ev.coefficient}%]`;
        neonColor = `rgba(34, 211, 238, ${opacity})`; // Neon Cyan
        borderGlow = `rgba(6, 182, 212, ${opacity * 0.45})`;
      } else if (ev.coefficient <= 30) {
        labelText = `[ПРУЖИНА: Пустота ${ev.coefficient}%]`;
        neonColor = `rgba(148, 163, 184, ${opacity * 0.75})`; // Slate Muted Gray
        borderGlow = `rgba(71, 85, 105, ${opacity * 0.25})`;
      } else {
        labelText = `[ПРУЖИНА: Упругая ${ev.coefficient}%]`;
        neonColor = `rgba(245, 158, 11, ${opacity})`; // Warm Amber
        borderGlow = `rgba(245, 158, 11, ${opacity * 0.35})`;
      }

      ctx.font = "bold 9px 'JetBrains Mono', 'Fira Code', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const textWidth = ctx.measureText(labelText).width;
      const badgePaddingX = 7;
      const badgePaddingY = 3.5;
      const badgeWidth = textWidth + badgePaddingX * 2 + 10; // Extra room for the level status dot
      const badgeHeight = 14 + badgePaddingY * 2;
      
      // Place the badge beautifully on the right side of the main trading panel
      const badgeX = canvas.width - 150 - badgeWidth; 
      const badgeY = y - badgeHeight / 2;

      // 1. Draw thin horizontal alignment pointer line to the level
      ctx.strokeStyle = ev.type === "BSL" ? `rgba(239, 68, 68, ${opacity * 0.25})` : `rgba(34, 197, 94, ${opacity * 0.25})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(badgeX + badgeWidth, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 2. Render backing dark high-tech acrylic card
      ctx.fillStyle = `rgba(11, 14, 20, ${opacity * 0.9})`;
      ctx.strokeStyle = borderGlow;
      ctx.lineWidth = 1;
      drawRoundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 3.5);
      ctx.fill();
      ctx.stroke();

      // 3. Render tiny status indicator dot (Red for BSL Stops Hit, Green for SSL Stops Hit)
      ctx.fillStyle = ev.type === "BSL" ? `rgba(239, 68, 68, ${opacity})` : `rgba(34, 197, 94, ${opacity})`;
      ctx.beginPath();
      ctx.arc(badgeX + badgePaddingX + 3.5, y, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // 4. Print neon/muted text indicator
      ctx.fillStyle = neonColor;
      ctx.fillText(labelText, badgeX + badgePaddingX + 11, y);

      ctx.restore();
    });

    const timeScale = chartRef.current.timeScale();
    const currentMouse = mousePosRef.current;

    const drawRuler = (
      p1: { time: number; price: number },
      p2: { time: number; price: number },
      isActivePreview = false,
      isHovered = false,
      isSelected = false
    ) => {
      let startX: number | null = timeScale.timeToCoordinate(p1.time as UTCTimestamp);
      const startY: number | null = seriesRef.current!.priceToCoordinate(p1.price);
      let endX: number | null = timeScale.timeToCoordinate(p2.time as UTCTimestamp);
      const endY: number | null = seriesRef.current!.priceToCoordinate(p2.price);

      if (startY === null || endY === null) return;

      // Handle time coordinates outside visible range or in future margin
      if (startX === null || endX === null) {
        if (candlesCacheRef.current.length > 1) {
          const lastCandle = candlesCacheRef.current[candlesCacheRef.current.length - 1];
          const prevCandle = candlesCacheRef.current[candlesCacheRef.current.length - 2];
          const lastX = timeScale.timeToCoordinate(lastCandle.time as UTCTimestamp);
          const prevX = timeScale.timeToCoordinate(prevCandle.time as UTCTimestamp);
          if (lastX !== null && prevX !== null && lastX !== prevX) {
            const barWidth = Math.max(2, (lastX as number) - (prevX as number));
            const timeDiff = lastCandle.time - prevCandle.time;
            if (startX === null) {
              startX = (lastX as number) + ((p1.time - lastCandle.time) / timeDiff) * barWidth;
            }
            if (endX === null) {
              endX = (lastX as number) + ((p2.time - lastCandle.time) / timeDiff) * barWidth;
            }
          }
        }
      }

      if (startX === null && isActivePreview) startX = currentMouse.x;
      if (endX === null && isActivePreview) endX = currentMouse.x;
      if (startX === null || endX === null) return;

      const boxLeft = Math.min(startX, endX);
      const boxRight = Math.max(startX, endX);
      const boxTop = Math.min(startY, endY);
      const boxBottom = Math.max(startY, endY);
      const boxWidth = Math.max(1, boxRight - boxLeft);
      const boxHeight = Math.max(1, boxBottom - boxTop);

      const pctChange = ((p2.price - p1.price) / p1.price) * 100;
      const absoluteChange = p2.price - p1.price;
      const isUp = pctChange >= 0;

      const themeColor = isSelected ? "#38bdf8" : isHovered ? "#fbbf24" : isUp ? "#32B79A" : "#DE6370";
      const bgFill = isSelected
        ? "rgba(56, 189, 248, 0.12)"
        : isHovered
        ? "rgba(251, 191, 36, 0.12)"
        : isUp
        ? "rgba(16, 185, 129, 0.14)"
        : "rgba(239, 68, 68, 0.14)";

      // Draw measuring region box
      ctx.fillStyle = bgFill;
      ctx.fillRect(boxLeft, boxTop, boxWidth, boxHeight);

      ctx.strokeStyle = themeColor;
      ctx.lineWidth = isActivePreview || isSelected ? 1.5 : 1.0;
      ctx.setLineDash(isActivePreview ? [3, 3] : [4, 4]);
      ctx.strokeRect(boxLeft, boxTop, boxWidth, boxHeight);
      ctx.setLineDash([]);

      // Draw diagonal directional line with small arrow/endpoint dots
      ctx.strokeStyle = themeColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Candle count & duration calculation
      const tMin = Math.min(p1.time, p2.time);
      const tMax = Math.max(p1.time, p2.time);
      const candlesInRange = candlesCacheRef.current.filter((c) => c.time >= tMin && c.time <= tMax);
      const barsCount = candlesInRange.length > 0 ? candlesInRange.length : Math.max(1, Math.round(boxWidth / 8));

      const secondsDiff = Math.abs(p2.time - p1.time);
      let timeStr = "";
      if (secondsDiff < 60) {
        timeStr = `${Math.max(1, secondsDiff)}с`;
      } else if (secondsDiff < 3600) {
        timeStr = `${Math.round(secondsDiff / 60)}м`;
      } else if (secondsDiff < 86400) {
        const hours = Math.floor(secondsDiff / 3600);
        const mins = Math.round((secondsDiff % 3600) / 60);
        timeStr = mins > 0 ? `${hours}ч ${mins}м` : `${hours}ч`;
      } else {
        const days = (secondsDiff / 86400).toFixed(1);
        timeStr = `${days}д`;
      }

      // Information card inside or adjacent to ruler
      const popupWidth = 160;
      const popupHeight = 46;
      let popupX = boxLeft + boxWidth / 2 - popupWidth / 2;
      let popupY = boxTop + boxHeight / 2 - popupHeight / 2;

      // Keep within chart viewport (avoid clipping into right price axis)
      popupX = Math.max(8, Math.min(canvas.width - popupWidth - 65, popupX));
      popupY = Math.max(8, Math.min(canvas.height - popupHeight - 8, popupY));

      if (!isActivePreview) {
        rulerCardRef.current = {
          x: popupX,
          y: popupY,
          w: popupWidth,
          h: popupHeight,
          closeX: popupX + popupWidth - 18,
          closeY: popupY + 4,
          closeW: 14,
          closeH: 14,
        };
      }

      // Card container
      ctx.fillStyle = "rgba(11, 15, 25, 0.94)";
      ctx.strokeStyle = themeColor;
      ctx.lineWidth = 1;
      drawRoundRect(ctx, popupX, popupY, popupWidth, popupHeight, 6);
      ctx.fill();
      ctx.stroke();

      // Card percentage & dollar diff
      const pctSign = isUp ? "+" : "";
      const diffSign = isUp ? "+$" : "-$";
      const absDiff = Math.abs(absoluteChange);
      const formattedDiff = absDiff >= 100
        ? absDiff.toFixed(2)
        : absDiff >= 1
        ? absDiff.toFixed(4)
        : absDiff >= 0.01
        ? absDiff.toFixed(5)
        : absDiff.toFixed(6);

      ctx.fillStyle = isUp ? "#34d399" : "#f87171";
      ctx.font = "bold 12px 'Space Grotesk', 'Inter', monospace";
      ctx.fillText(
        `${pctSign}${pctChange.toFixed(2)}% (${diffSign}${formattedDiff})`,
        popupX + 8,
        popupY + 18
      );

      // Card bars & duration
      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText(
        `${barsCount} баров • ${timeStr} (${timeframe})`,
        popupX + 8,
        popupY + 34
      );

      // Close button [×] for finalized rulers
      if (!isActivePreview) {
        ctx.fillStyle = "#64748b";
        ctx.font = "bold 11px monospace";
        ctx.fillText("✕", popupX + popupWidth - 13, popupY + 14);
      }

      // Handles on endpoints
      const drawHandle = (hx: number, hy: number) => {
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, 2 * Math.PI);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = themeColor;
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      };
      drawHandle(startX, startY);
      drawHandle(endX, endY);
    };

    const drawTrendLine = (
      p1: { time: number; price: number },
      p2: { time: number; price: number },
      isHovered: boolean,
      isSelected: boolean
    ) => {
      const startX = timeScale.timeToCoordinate(p1.time as UTCTimestamp);
      const startY = seriesRef.current!.priceToCoordinate(p1.price);
      const endX = timeScale.timeToCoordinate(p2.time as UTCTimestamp);
      const endY = seriesRef.current!.priceToCoordinate(p2.price);

      if (startX === null || startY === null || endX === null || endY === null) return;

      // Draw the line body
      ctx.beginPath();
      ctx.strokeStyle = isSelected ? "#3b82f6" : isHovered ? "#fbbf24" : "#f59e0b"; // yellow glow or amber default
      ctx.lineWidth = isSelected ? 3.0 : isHovered ? 2.5 : 2.0;
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      // If selected or hovered, draw nice control point handles
      if (isSelected || isHovered) {
        const drawHandle = (hx: number, hy: number) => {
          ctx.beginPath();
          ctx.arc(hx, hy, 5, 0, 2 * Math.PI);
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = isSelected ? "#3b82f6" : "#fbbf24";
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
        };
        drawHandle(startX, startY);
        drawHandle(endX, endY);
      }
    };

    const drawHLine = (
      price: number,
      isHovered: boolean,
      isSelected: boolean
    ) => {
      const y = seriesRef.current!.priceToCoordinate(price);
      if (y === null) return;

      const color = isSelected ? "#3b82f6" : isHovered ? "#fbbf24" : "#3b82f6";

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : isHovered ? 2.0 : 1.5;
      ctx.setLineDash(isHovered || isSelected ? [] : [4, 4]); // solid when active, dashed by default
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Neat price badge over coordinate
      const labelText = `$${formatChartPrice(price)}`;
      ctx.font = "bold 9px 'JetBrains Mono', 'Fira Code', monospace";
      const textWidth = ctx.measureText(labelText).width;
      const labelWidth = Math.max(64, textWidth + 12);
      const labelX = canvas.width - labelWidth - 6;
      const labelY = y - 9;
      const labelHeight = 18;

      ctx.fillStyle = isSelected ? "#3b82f6" : isHovered ? "#fbbf24" : "rgba(30, 41, 59, 0.92)";
      ctx.strokeStyle = isSelected ? "#60a5fa" : isHovered ? "#fde047" : "rgba(71, 85, 105, 0.6)";
      ctx.lineWidth = 1;
      drawRoundRect(ctx, labelX, labelY, labelWidth, labelHeight, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isSelected || isHovered ? "#ffffff" : "#cbd5e1";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        labelText,
        labelX + labelWidth / 2,
        y
      );
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    };

    // 1. Draw all completed rulers
    rulersRef.current.forEach((r) => {
      const isH = hoveredDrawing?.type === "ruler" && hoveredDrawing.id === r.id;
      const isS = selectedDrawing?.type === "ruler" && selectedDrawing.id === r.id;
      drawRuler(r.p1, r.p2, false, isH, isS);
    });

    // 2. Draw all completed trendlines
    tLinesRef.current.forEach((t) => {
      const isH = hoveredDrawing?.type === "tline" && hoveredDrawing.id === t.id;
      const isS = selectedDrawing?.type === "tline" && selectedDrawing.id === t.id;
      drawTrendLine(t.p1, t.p2, isH, isS);
    });

    // 3. Draw all completed horizontal lines
    hLinesRef.current.forEach((h) => {
      const isH = hoveredDrawing?.type === "hline" && hoveredDrawing.id === h.id;
      const isS = selectedDrawing?.type === "hline" && selectedDrawing.id === h.id;
      drawHLine(h.price, isH, isS);
    });

    // Observed limit-order walls from the live Binance futures book.
    bookWallsRef.current.forEach((wall) => {
      const y = seriesRef.current?.priceToCoordinate(wall.price);
      if (y == null || y < 0 || y > canvas.height) return;
      const isBid = wall.side === "bid";
      const isSolid = wall.status === "solid" || wall.ageSeconds >= 180;
      const isConfirmed = wall.status === "confirmed" || wall.ageSeconds >= 60;
      
      const color = isSolid 
        ? (isBid ? "#34D399" : "#F87171") 
        : isConfirmed 
        ? (isBid ? "#32B79A" : "#E66A78") 
        : "#8A9BAF";
      
      const size = wall.notional >= 1_000_000
        ? "$" + (wall.notional / 1_000_000).toFixed(2) + "M"
        : "$" + Math.round(wall.notional / 1_000) + "K";
      
      const ageStr = wall.ageSeconds >= 60 
        ? `${Math.floor(wall.ageSeconds / 60)}м ${wall.ageSeconds % 60}с` 
        : `${wall.ageSeconds}с`;

      const statusTag = isSolid 
        ? " · 🛡️ ЖЕЛЕЗОБЕТОН (" + ageStr + ")" 
        : isConfirmed 
        ? " · ⏱️ НАСТОЯЩАЯ (" + ageStr + ")" 
        : " · " + ageStr + " (проверка)";
      
      const priceStr = wall.price >= 1 ? "$" + wall.price : "$" + wall.price.toFixed(5);
      const label = (isBid ? "BID " : "ASK ") + size + " @ " + priceStr + statusTag;
      
      ctx.save();
      ctx.strokeStyle = isSolid 
        ? (isBid ? "rgba(52,211,153,.9)" : "rgba(248,113,113,.9)") 
        : isConfirmed 
        ? (isBid ? "rgba(50,183,154,.75)" : "rgba(230,106,120,.75)") 
        : "rgba(138,155,175,.45)";
      ctx.lineWidth = isSolid ? 2 : 1;
      ctx.setLineDash(isSolid ? [8, 4] : [5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = isSolid ? "bold 11px 'JetBrains Mono', monospace" : "bold 10px 'JetBrains Mono', monospace";
      const width = ctx.measureText(label).width + 16;
      const x = canvas.width - width - 74;
      ctx.fillStyle = "#10161F";
      ctx.strokeStyle = color;
      drawRoundRect(ctx, x, y - 10, width, 20, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + width / 2, y);
      ctx.restore();
    });

    // 3.5. Render Market Structure (Clear Russian Badges: СЛОМ В ЛОНГ / СЛОМ В ШОРТ)
    if (showStructureRef.current && marketStructureRef.current) {
      const ms = marketStructureRef.current;
      ctx.save();

      // We only show the last 3 most recent breaks to keep the chart crystal clean
      const recentBreaks = ms.breaks.slice(-3);

      recentBreaks.forEach((brk) => {
        const startX = timeScale.timeToCoordinate(brk.pivotTime as UTCTimestamp);
        const endX = timeScale.timeToCoordinate(brk.breakTime as UTCTimestamp);
        const y = seriesRef.current?.priceToCoordinate(brk.pivotPrice);

        if (y === null || y === undefined) return;
        const x1 = startX !== null ? Math.max(0, startX) : 0;
        const x2 = endX !== null ? Math.min(canvas.width, endX) : canvas.width;
        if (x2 <= x1) return;

        const isChoch = brk.type === "BULLISH_CHOCH" || brk.type === "BEARISH_CHOCH";
        const isBullish = brk.type === "BULLISH_CHOCH" || brk.type === "BULLISH_BOS";
        const strokeColor = isBullish ? "#32B79A" : "#f43f5e";

        // Clean subtle dashed break horizontal line
        ctx.beginPath();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small pivot point anchor
        if (startX !== null && startX >= 0 && startX <= canvas.width) {
          ctx.fillStyle = strokeColor;
          ctx.beginPath();
          ctx.arc(startX, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Clear, human-friendly Russian badge on the breaking candle
        if (endX !== null && endX >= 0 && endX <= canvas.width) {
          const badgeText = isChoch
            ? (isBullish ? "▲ СЛОМ В ЛОНГ" : "▼ СЛОМ В ШОРТ")
            : (isBullish ? "▲ ТРЕНД ВВЕРХ" : "▼ ТРЕНД ВНИЗ");
          ctx.font = "bold 9.5px 'JetBrains Mono', -apple-system, sans-serif";
          const textMetrics = ctx.measureText(badgeText);
          const badgeW = textMetrics.width + 12;
          const badgeH = 18;
          const badgeX = Math.max(6, Math.min(canvas.width - badgeW - 75, endX - badgeW / 2));
          const badgeY = isBullish ? y - badgeH - 4 : y + 4;

          // Contrast rounded badge
          ctx.fillStyle = isBullish
            ? "rgba(6, 78, 59, 0.96)"
            : "rgba(136, 19, 55, 0.96)";
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1.2;
          drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4);
          ctx.fill();
          ctx.stroke();

          // Text
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
        }
      });

      // C. Draw Current Key Defensive Pivot (Active Level to be broken for next CHoCH)
      if (ms.currentKeyPivot) {
        const kp = ms.currentKeyPivot;
        const ky = seriesRef.current?.priceToCoordinate(kp.price);
        const kx = timeScale.timeToCoordinate(kp.time as UTCTimestamp);

        if (ky !== null && ky !== undefined) {
          const isHL = kp.type === "KEY_HL";
          const keyColor = isHL ? "#38bdf8" : "#fbbf24"; // Sky blue for HL, Amber for LH
          const rayStart = kx !== null ? Math.max(0, kx) : 0;

          ctx.beginPath();
          ctx.strokeStyle = keyColor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.moveTo(rayStart, ky);
          ctx.lineTo(canvas.width, ky);
          ctx.stroke();
          ctx.setLineDash([]);

          // Anchor point at the defensive pivot
          if (kx !== null && kx >= 0 && kx <= canvas.width) {
            ctx.fillStyle = keyColor;
            ctx.beginPath();
            ctx.arc(kx, ky, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // Clear, human-friendly defensive pivot badge on right edge
          const pivotBadge = isHL
            ? `🛡 Защита лонга: $${formatChartPrice(kp.price)}`
            : `🛡 Защита шорта: $${formatChartPrice(kp.price)}`;
          ctx.font = "bold 9px 'JetBrains Mono', -apple-system, sans-serif";
          const pBadgeW = ctx.measureText(pivotBadge).width + 12;
          const pBadgeH = 17;
          const pBadgeX = canvas.width - pBadgeW - 75;
          const pBadgeY = ky - pBadgeH / 2;

          ctx.fillStyle = isHL ? "rgba(12, 74, 110, 0.94)" : "rgba(120, 53, 15, 0.94)";
          ctx.strokeStyle = keyColor;
          ctx.lineWidth = 1;
          drawRoundRect(ctx, pBadgeX, pBadgeY, pBadgeW, pBadgeH, 3);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(pivotBadge, pBadgeX + pBadgeW / 2, ky);
        }
      }

      ctx.restore();
    }

    // 4. Draw active tool ruler preview
    const isRulerActive = (activeTool === "ruler" || isShiftPressedRef.current) && !!rulerStartRef.current;
    if (isRulerActive && rulerStartRef.current) {
      const mouseX = currentMouse.x;
      const mouseY = currentMouse.y;
      const mousePos = getMouseTimeAndPrice(mouseX, mouseY);
      if (mousePos) {
        const hoveredPriceSnapped = findMagnetPrice(mousePos.time, mousePos.price);
        drawRuler(
          rulerStartRef.current,
          { time: mousePos.time, price: hoveredPriceSnapped },
          true,
          false,
          false
        );
      }
    }

    // 5. Draw rubber-band Trendline preview
    if (activeTool === "tline" && tlineStartRef.current) {
      const startX = timeScale.timeToCoordinate(tlineStartRef.current.time as UTCTimestamp);
      const startY = seriesRef.current.priceToCoordinate(tlineStartRef.current.price);

      if (startX !== null && startY !== null) {
        const mouseX = currentMouse.x;
        const mouseY = currentMouse.y;
        const mousePos = getMouseTimeAndPrice(mouseX, mouseY);
        let targetY = mouseY;
        if (mousePos) {
          const hoveredPriceSnapped = findMagnetPrice(mousePos.time, mousePos.price);
          targetY = seriesRef.current.priceToCoordinate(hoveredPriceSnapped) || mouseY;
        }

        ctx.strokeStyle = "#f59e0b"; // orange
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(mouseX, targetY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small indicator circle
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.arc(mouseX, targetY, 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // 6. Draw hline preview snap
    if (activeTool === "hline") {
      const mouseX = currentMouse.x;
      const mouseY = currentMouse.y;
      const mousePos = getMouseTimeAndPrice(mouseX, mouseY);
      if (mousePos) {
        const hoveredPriceSnapped = findMagnetPrice(mousePos.time, mousePos.price);
        const targetY = seriesRef.current.priceToCoordinate(hoveredPriceSnapped) || mouseY;

        ctx.strokeStyle = "rgba(56, 189, 248, 0.6)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, targetY);
        ctx.lineTo(canvas.width, targetY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Live price badge on right side
        const formattedPrice = formatChartPrice(hoveredPriceSnapped);
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        const badgeW = ctx.measureText(formattedPrice).width + 14;
        const badgeH = 18;
        const badgeX = canvas.width - badgeW - 65;
        const badgeY = targetY - badgeH / 2;
        ctx.fillStyle = "#0284c7";
        drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, 3.5);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(formattedPrice, badgeX + badgeW / 2, targetY);
      }
    }
  }, [activeTool, timeframe, findMagnetPrice, hoveredDrawing, selectedDrawing, getMouseTimeAndPrice]);

  useEffect(() => {
    updateCanvasRef.current = drawOverlayCanvas;
  }, [drawOverlayCanvas]);

  // Window-level escape and delete binding
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedDrawing) {
        const { id, type } = selectedDrawing;
        if (type === "hline") {
          const updated = hLinesRef.current.filter((x) => x.id !== id);
          setHLines(updated);
          hLinesRef.current = updated;
          localStorage.setItem(`hLines_${binanceSymbol}`, JSON.stringify(updated));
        } else if (type === "tline") {
          const updated = tLinesRef.current.filter((x) => x.id !== id);
          setTLines(updated);
          tLinesRef.current = updated;
          localStorage.setItem(`tLines_${binanceSymbol}`, JSON.stringify(updated));
        } else if (type === "ruler") {
          const updated = rulersRef.current.filter((x) => x.id !== id);
          setRulers(updated);
          rulersRef.current = updated;
          localStorage.setItem(`rulers_${binanceSymbol}`, JSON.stringify(updated));
        }
        setSelectedDrawing(null);
        setHoveredDrawing(null);
        if (updateCanvasRef.current) updateCanvasRef.current();
      } else if (e.key === "Escape") {
        if (activeToolRef.current) {
          setActiveTool(null);
        }
        rulerStartRef.current = null;
        tlineStartRef.current = null;
        toolDrawingRef.current = null;
        if (rulersRef.current.length > 0) {
          setRulers([]);
          rulersRef.current = [];
          localStorage.removeItem(`rulers_${binanceSymbol}`);
        }
        setSelectedDrawing(null);
        setHoveredDrawing(null);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedDrawing, binanceSymbol]);

  // Capture event handlers for non-blocking canvas dragging and drawing intercept
  const handleMouseDownCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (draggingDrawingRef.current) {
      const finished = draggingDrawingRef.current;
      draggingDrawingRef.current = null;
      if (finished.type === "hline") localStorage.setItem(`hLines_${binanceSymbol}`, JSON.stringify(hLinesRef.current));
      else if (finished.type === "tline") localStorage.setItem(`tLines_${binanceSymbol}`, JSON.stringify(tLinesRef.current));
      else localStorage.setItem(`rulers_${binanceSymbol}`, JSON.stringify(rulersRef.current));
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // 1. Check if user clicked the [✕] close button on the ruler card
    if (rulerCardRef.current && rulersRef.current.length > 0) {
      const card = rulerCardRef.current;
      if (
        mx >= card.closeX - 6 &&
        mx <= card.closeX + card.closeW + 6 &&
        my >= card.closeY - 6 &&
        my <= card.closeY + card.closeH + 6
      ) {
        setRulers([]);
        rulersRef.current = [];
        localStorage.removeItem(`rulers_${binanceSymbol}`);
        rulerCardRef.current = null;
        if (updateCanvasRef.current) updateCanvasRef.current();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }

    const isRulerTool = activeTool === "ruler" || isShiftPressedRef.current;

    // 2. Active tool creation interaction
    if (isRulerTool || activeTool === "tline" || activeTool === "hline") {
      const mousePos = getMouseTimeAndPrice(mx, my);
      if (!mousePos) return;

      const closestCandle = findClosestCandle(mousePos.time);
      const snappedTime = closestCandle ? closestCandle.time : mousePos.time;
      const snappedPrice = findMagnetPrice(mousePos.time, mousePos.price);

      if (activeTool === "hline") {
        const newHLine = { id: `hline-${Date.now()}-${Math.random()}`, price: snappedPrice };
        const updatedHLines = [...hLinesRef.current, newHLine];
        setHLines(updatedHLines);
        hLinesRef.current = updatedHLines;
        localStorage.setItem(`hLines_${binanceSymbol}`, JSON.stringify(updatedHLines));
        setActiveTool(null);
        if (updateCanvasRef.current) updateCanvasRef.current();
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      if (isRulerTool) {
        if (!rulerStartRef.current) {
          // Point 1
          rulerStartRef.current = { time: snappedTime, price: snappedPrice };
          toolDrawingRef.current = {
            tool: "ruler",
            isMouseDown: true,
            startX: mx,
            startY: my,
            startTime: snappedTime,
            startPrice: snappedPrice,
            hasDragged: false,
          };
          e.stopPropagation();
          e.preventDefault();
          if (updateCanvasRef.current) updateCanvasRef.current();
        } else {
          // Point 2 (click-move-click mode)
          const newRuler = {
            id: String(Date.now()),
            p1: rulerStartRef.current,
            p2: { time: snappedTime, price: snappedPrice },
          };
          setRulers([newRuler]);
          rulersRef.current = [newRuler];
          localStorage.setItem(`rulers_${binanceSymbol}`, JSON.stringify([newRuler]));
          rulerStartRef.current = null;
          toolDrawingRef.current = null;
          if (activeTool === "ruler") setActiveTool(null);
          e.stopPropagation();
          e.preventDefault();
          if (updateCanvasRef.current) updateCanvasRef.current();
        }
        return;
      }

      if (activeTool === "tline") {
        if (!tlineStartRef.current) {
          tlineStartRef.current = { time: snappedTime, price: snappedPrice };
          toolDrawingRef.current = {
            tool: "tline",
            isMouseDown: true,
            startX: mx,
            startY: my,
            startTime: snappedTime,
            startPrice: snappedPrice,
            hasDragged: false,
          };
          e.stopPropagation();
          e.preventDefault();
          if (updateCanvasRef.current) updateCanvasRef.current();
        } else {
          const newTLine = {
            id: String(Date.now()),
            p1: tlineStartRef.current,
            p2: { time: snappedTime, price: snappedPrice },
          };
          const updatedTLines = [...tLinesRef.current, newTLine];
          setTLines(updatedTLines);
          tLinesRef.current = updatedTLines;
          localStorage.setItem(`tLines_${binanceSymbol}`, JSON.stringify(updatedTLines));
          tlineStartRef.current = null;
          toolDrawingRef.current = null;
          setActiveTool(null);
          e.stopPropagation();
          e.preventDefault();
          if (updateCanvasRef.current) updateCanvasRef.current();
        }
        return;
      }
    }

    // 3. Normal mode: check if clicking an existing drawing (handle or line)
    const hovered = findHoveredDrawing(mx, my);
    if (hovered) {
      // A plain drag always belongs to the chart. Editing a drawing requires
      // an explicit modifier, otherwise nearby lines steal the pan gesture.
      if (!e.altKey) {
        setSelectedDrawing({ type: hovered.type, id: hovered.id });
        return;
      }
      e.stopPropagation();
      e.preventDefault();

      let startP1, startP2, startPrice;
      if (hovered.type === "tline") {
        const item = tLinesRef.current.find((t) => t.id === hovered.id);
        if (item) {
          startP1 = { ...item.p1 };
          startP2 = { ...item.p2 };
        }
      } else if (hovered.type === "ruler") {
        const item = rulersRef.current.find((r) => r.id === hovered.id);
        if (item) {
          startP1 = { ...item.p1 };
          startP2 = { ...item.p2 };
        }
      } else if (hovered.type === "hline") {
        const item = hLinesRef.current.find((h) => h.id === hovered.id);
        if (item) {
          startPrice = item.price;
        }
      }

      const mousePos = getMouseTimeAndPrice(mx, my);

      draggingDrawingRef.current = {
        type: hovered.type,
        id: hovered.id,
        part: hovered.part,
        startMouseX: mx,
        startMouseY: my,
        startMouseTime: mousePos?.time || 0,
        startMousePrice: mousePos?.price || 0,
        startP1,
        startP2,
        startPrice,
      };

      setSelectedDrawing({ type: hovered.type, id: hovered.id });
      if (updateCanvasRef.current) updateCanvasRef.current();
    } else {
      // Clicked on empty chart area
      if (selectedDrawing) {
        setSelectedDrawing(null);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
      // If a ruler exists on chart, clicking empty space dismisses it (TradingView standard)
      if (rulersRef.current.length > 0 && !activeTool && !isShiftPressedRef.current) {
        setRulers([]);
        rulersRef.current = [];
        localStorage.removeItem(`rulers_${binanceSymbol}`);
        if (updateCanvasRef.current) updateCanvasRef.current();
      }
    }
  };

  const handleMouseMoveCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    mousePosRef.current = { x: mx, y: my };

    // Mouseup may happen outside the chart. Never keep a stale drag armed when
    // the pointer comes back without the left mouse button pressed.
    if (draggingDrawingRef.current && (e.buttons & 1) === 0) {
      const finished = draggingDrawingRef.current;
      draggingDrawingRef.current = null;
      if (finished.type === "hline") localStorage.setItem(`hLines_${binanceSymbol}`, JSON.stringify(hLinesRef.current));
      else if (finished.type === "tline") localStorage.setItem(`tLines_${binanceSymbol}`, JSON.stringify(tLinesRef.current));
      else localStorage.setItem(`rulers_${binanceSymbol}`, JSON.stringify(rulersRef.current));
      setHoveredDrawing(null);
      updateCanvasRef.current?.();
    }

    // Update drag threshold for click-and-drag tool drawing
    if (toolDrawingRef.current && toolDrawingRef.current.isMouseDown) {
      const dist = Math.hypot(mx - toolDrawingRef.current.startX, my - toolDrawingRef.current.startY);
      if (dist > 6) {
        toolDrawingRef.current.hasDragged = true;
      }
    }

    // Drawing drag movement (updating existing drawing or handle)
    if (draggingDrawingRef.current && chartRef.current && seriesRef.current) {
      e.stopPropagation();
      e.preventDefault();

      const d = draggingDrawingRef.current;
      const mousePos = getMouseTimeAndPrice(mx, my);
      if (!mousePos || mousePos.price === null || mousePos.time === null) return;

      const closestCandle = findClosestCandle(mousePos.time);
      const snappedPrice = findMagnetPrice(mousePos.time, mousePos.price);
      const snappedTime = closestCandle ? closestCandle.time : mousePos.time;

      if (d.type === "hline") {
        const updated = hLinesRef.current.map((h) => {
          if (h.id === d.id) return { ...h, price: snappedPrice };
          return h;
        });
        setHLines(updated);
        hLinesRef.current = updated;
      } else if (d.type === "tline") {
        if (d.part === "p1") {
          const updated = tLinesRef.current.map((t) => {
            if (t.id === d.id) return { ...t, p1: { time: snappedTime, price: snappedPrice } };
            return t;
          });
          setTLines(updated);
          tLinesRef.current = updated;
        } else if (d.part === "p2") {
          const updated = tLinesRef.current.map((t) => {
            if (t.id === d.id) return { ...t, p2: { time: snappedTime, price: snappedPrice } };
            return t;
          });
          setTLines(updated);
          tLinesRef.current = updated;
        } else {
          if (d.startMouseTime !== undefined && d.startMousePrice !== undefined && d.startP1 && d.startP2) {
            const deltaPrice = snappedPrice - d.startMousePrice;
            const deltaTime = snappedTime - d.startMouseTime;
            const updated = tLinesRef.current.map((t) => {
              if (t.id === d.id) {
                return {
                  ...t,
                  p1: { time: d.startP1!.time + deltaTime, price: d.startP1!.price + deltaPrice },
                  p2: { time: d.startP2!.time + deltaTime, price: d.startP2!.price + deltaPrice },
                };
              }
              return t;
            });
            setTLines(updated);
            tLinesRef.current = updated;
          }
        }
      } else if (d.type === "ruler") {
        if (d.part === "p1") {
          const updated = rulersRef.current.map((r) => {
            if (r.id === d.id) return { ...r, p1: { time: snappedTime, price: snappedPrice } };
            return r;
          });
          setRulers(updated);
          rulersRef.current = updated;
        } else if (d.part === "p2") {
          const updated = rulersRef.current.map((r) => {
            if (r.id === d.id) return { ...r, p2: { time: snappedTime, price: snappedPrice } };
            return r;
          });
          setRulers(updated);
          rulersRef.current = updated;
        }
      }

      if (updateCanvasRef.current) updateCanvasRef.current();
    } else if (!activeTool && !isShiftPressedRef.current) {
      const hovered = findHoveredDrawing(mx, my);
      if (JSON.stringify(hovered) !== JSON.stringify(hoveredDrawing)) {
        setHoveredDrawing(hovered);
      }
    }

    if (
      (activeTool === "ruler" && rulerStartRef.current) ||
      (isShiftPressedRef.current && rulerStartRef.current) ||
      (activeTool === "tline" && tlineStartRef.current) ||
      activeTool === "hline"
    ) {
      if (updateCanvasRef.current) updateCanvasRef.current();
    }
  };

  const handleMouseUpCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Finish drag-and-drop creation (if user held down mouse and dragged)
    if (toolDrawingRef.current) {
      const td = toolDrawingRef.current;
      if (td.hasDragged && td.isMouseDown) {
        const mousePos = getMouseTimeAndPrice(mx, my);
        if (mousePos) {
          const closestCandle = findClosestCandle(mousePos.time);
          const snappedTime = closestCandle ? closestCandle.time : mousePos.time;
          const snappedPrice = findMagnetPrice(mousePos.time, mousePos.price);

          if (td.tool === "ruler") {
            const newRuler = {
              id: String(Date.now()),
              p1: { time: td.startTime, price: td.startPrice },
              p2: { time: snappedTime, price: snappedPrice },
            };
            setRulers([newRuler]);
            rulersRef.current = [newRuler];
            localStorage.setItem(`rulers_${binanceSymbol}`, JSON.stringify([newRuler]));
            rulerStartRef.current = null;
            toolDrawingRef.current = null;
            if (activeTool === "ruler") setActiveTool(null);
            if (updateCanvasRef.current) updateCanvasRef.current();
            e.stopPropagation();
            e.preventDefault();
            return;
          } else if (td.tool === "tline") {
            const newTLine = {
              id: String(Date.now()),
              p1: { time: td.startTime, price: td.startPrice },
              p2: { time: snappedTime, price: snappedPrice },
            };
            const updatedTLines = [...tLinesRef.current, newTLine];
            setTLines(updatedTLines);
            tLinesRef.current = updatedTLines;
            localStorage.setItem(`tLines_${binanceSymbol}`, JSON.stringify(updatedTLines));
            tlineStartRef.current = null;
            toolDrawingRef.current = null;
            setActiveTool(null);
            if (updateCanvasRef.current) updateCanvasRef.current();
            e.stopPropagation();
            e.preventDefault();
            return;
          }
        }
      } else {
        // User just clicked (without dragging) - keep start point active for 2nd click!
        td.isMouseDown = false;
      }
    }

    if (draggingDrawingRef.current) {
      e.stopPropagation();
      e.preventDefault();

      const d = draggingDrawingRef.current;
      draggingDrawingRef.current = null;

      if (d.type === "hline") {
        localStorage.setItem(`hLines_${binanceSymbol}`, JSON.stringify(hLinesRef.current));
      } else if (d.type === "tline") {
        localStorage.setItem(`tLines_${binanceSymbol}`, JSON.stringify(tLinesRef.current));
      } else if (d.type === "ruler") {
        localStorage.setItem(`rulers_${binanceSymbol}`, JSON.stringify(rulersRef.current));
      }

      setHoveredDrawing(null);
      if (updateCanvasRef.current) updateCanvasRef.current();
    }
  };

  return (
    <div className="pulse-chart">
      <div className="pulse-chart-status" role="status">
        <span>{chartStatus}</span>
        <button className="px-2 py-1 border border-slate-600 rounded" onClick={() => setRetry(n => n + 1)}>Повторить загрузку</button>
      </div>
      {historyError && <div role="alert" className="text-xs text-amber-300">{historyError}. Новые реальные свечи могут поступать без полной истории.</div>}
      {levelsError && <div role="alert" className="text-xs text-amber-300">{levelsError}</div>}
      <div className="pulse-chart-toolbar">
      <div className="pulse-symbol-header">
        <div className="pulse-symbol-name"><div><h1>{symbol.split('/')[0]} <span>/ USDT</span><button onClick={handleCopy} title="Быстро скопировать тикер (например, BTCUSDT)">{copied ? <Check size={13}/> : <Copy size={13}/>}</button></h1></div></div>
        <div className="pulse-current-price flex items-center gap-1.5">
          <span>{currentPrice !== null ? '$'+formatChartPrice(currentPrice) : '—'}</span>
          <small>LAST PRICE</small>
          {countdown && (
            <span className="inline-flex items-center gap-1 text-[11px] text-cyan-400 font-mono bg-[#141C26] px-1.5 py-0.5 rounded border border-[#1E2936] ml-1.5" title="Время до закрытия текущей свечи">
              <Timer size={11} className="text-cyan-400" />
              {countdown}
            </span>
          )}
        </div>
        <div className="pulse-symbol-metric"><span className={(markets?.[symbol]?.change??0)>=0?'positive':'negative'}>{markets?.[symbol] ? ((markets[symbol].change>=0?'+':'')+markets[symbol].change.toFixed(2)+'%') : '—'}</span><small>24H CHANGE</small></div>
        <div className="pulse-symbol-metric"><span>{markets?.[symbol] ? '$'+(markets[symbol].volume/1e6).toLocaleString('en-US',{maximumFractionDigits:1})+'M' : '—'}</span><small>24H VOLUME</small></div>
        <div className="pulse-venue">USDⓈ-M <span>PERPETUAL</span></div>
      </div>
      <div className="pulse-chart-controls">
        {/* Timeframes */}
        <div className="pulse-timeframes">
          {(["1m", "5m", "15m", "1h", "4h", "1d"] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2.5 py-1 rounded transition-all cursor-pointer ${
                timeframe === tf
                  ? "bg-cyan-600 text-white shadow-md shadow-cyan-950/20"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <span className="pulse-book-status" title="Публичный стакан Binance Futures · серые плотности наблюдаются, цветные держатся 30 секунд и дольше">Book walls · live</span>

        {/* Market Structure CHoCH Toggle */}
        <button
          onClick={() => {
            setShowStructure(!showStructure);
            if (updateCanvasRef.current) {
              setTimeout(() => updateCanvasRef.current?.(), 0);
            }
          }}
          className={`px-2.5 py-1 rounded transition-all cursor-pointer flex items-center gap-1.5 text-xs font-mono font-bold border ${
            showStructure
              ? "bg-emerald-950/80 border-emerald-500 text-emerald-300 shadow-md shadow-emerald-950/40"
              : "bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300"
          }`}
          title="Включить/выключить отображение слома структуры (CHoCH / BOS / Защитные уровни тренда)"
        >
          <GitBranch className="h-3.5 w-3.5" />
          <span>Structure</span>
          {marketStructure && (
            <span className={`px-1 py-0.2 rounded text-[9px] font-bold ${
              marketStructure.trend === "BULLISH"
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-rose-500/20 text-rose-400"
            }`}>
              {marketStructure.trend === "BULLISH" ? "ЛОНГ" : "ШОРТ"}
            </span>
          )}
        </button>

        <button onClick={()=>window.dispatchEvent(new Event('pulse-alerts'))}>Alerts</button>
        <button className="pulse-indicators" onClick={()=>setShowLegend(!showLegend)} aria-expanded={showLegend}>Indicators</button>
        {/* Utility Drawing Controls */}
        <div className="pulse-drawing-tools">
          {/* Magnet Toggle Button */}
          <button
            onClick={() => {
              setMagnetMode(!magnetMode);
              if (updateCanvasRef.current) {
                setTimeout(() => updateCanvasRef.current?.(), 0);
              }
            }}
            title="Магнит (привязка к OHLC свечи). Кликните для постоянного переключения или удерживайте CTRL"
            className={`p-1.5 rounded border transition-all cursor-pointer ${
              magnetMode
                ? "bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-950/20"
                : "bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300"
            }`}
          >
            <Magnet className="h-3.5 w-3.5" />
          </button>

          {/* Horizontal Level Tool */}
          <button
            onClick={() => {
              setActiveTool(activeTool === "hline" ? null : "hline");
              rulerStartRef.current = null;
              tlineStartRef.current = null;
            }}
            title="Добавить горизонтальный уровень"
            className={`p-1.5 rounded border transition-all cursor-pointer ${
              activeTool === "hline"
                ? "bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-950/20 animate-pulse"
                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            <MoveHorizontal className="h-3.5 w-3.5" />
          </button>

          {/* Trendline Tool */}
          <button
            onClick={() => {
              setActiveTool(activeTool === "tline" ? null : "tline");
              rulerStartRef.current = null;
              tlineStartRef.current = null;
            }}
            title="Добавить трендовую линию"
            className={`p-1.5 rounded border transition-all cursor-pointer ${
              activeTool === "tline"
                ? "bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-950/20 animate-pulse"
                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            <LineChart className="h-3.5 w-3.5" />
          </button>

          {/* Scalper Ruler Tool */}
          <button
            onClick={() => {
              setActiveTool(activeTool === "ruler" ? null : "ruler");
              rulerStartRef.current = null;
              tlineStartRef.current = null;
            }}
            title="Линейка диапазона цены и времени (быстрый запуск: зажмите Shift на графике)"
            className={`p-1.5 rounded border transition-all cursor-pointer ${
              activeTool === "ruler" || isShiftPressed
                ? "bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-950/20 animate-pulse"
                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            <Ruler className="h-3.5 w-3.5" />
          </button>

          {/* Delete Drawings Tool */}
          <button
            onClick={handleClearDrawings}
            title="Очистить все графические фигуры"
            className="p-1.5 bg-slate-900 border border-slate-800 text-rose-400 hover:text-rose-300 hover:bg-rose-950/20 rounded transition-all cursor-pointer shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      </div>

      {/* Floating Mode HUD Tip */}
      {(activeTool || isShiftPressed) && (
        <div className="absolute top-20 left-6 z-20 bg-[#0B0E14]/95 backdrop-blur border border-cyan-500/40 px-3.5 py-2 rounded shadow-xl text-[11px] text-cyan-300 text-center animate-pulse flex items-center gap-2">
          {activeTool === "hline" && (
            <span>📍 <b>Уровень</b>: кликните в любое место на графике для фиксации ценового уровня (Esc — отмена).</span>
          )}
          {activeTool === "tline" && (
            <span>
              {!tlineStartRef.current
                ? "📐 <b>Трендовая линия</b>: зажмите ЛКМ и потяните (или кликните первую точку)."
                : "📐 <b>Трендовая линия</b>: кликните вторую точку для завершения (Esc — сброс)."}
            </span>
          )}
          {(activeTool === "ruler" || isShiftPressed) && (
            <span>
              {!rulerStartRef.current
                ? "📏 <b>Линейка</b>: зажмите ЛКМ и потяните область (или кликните старт и конец). Esc — сброс."
                : "📏 <b>Линейка</b>: отпустите мышь или кликните для фиксации измерения (Esc — сброс)."}
            </span>
          )}
        </div>
      )}
      
      {/* Chart Canvas & Main Plotter Area */}
      <div
        id="chart-wrapper"
        title="Перемещение графика: перетаскивайте мышью. Изменение нарисованной линии: Alt + перетаскивание."
        className="pulse-chart-canvas"
        onMouseMoveCapture={handleMouseMoveCapture}
        onMouseDownCapture={handleMouseDownCapture}
        onMouseUpCapture={handleMouseUpCapture}
        style={{
          height: "100%",
          cursor: activeTool || isShiftPressed ? "crosshair" : "default"
        }}
      >
        {/* Clean, Non-intrusive Legend on top-left (away from active candles) */}
        <div className="absolute top-3 left-3 z-20 select-none">
          {!showLegend ? (
            <button
              onClick={() => setShowLegend(true)}
              className="flex items-center gap-1.5 px-2 py-1 bg-[#0B0E14]/80 hover:bg-[#0B0E14] border border-slate-700/60 hover:border-slate-500 rounded text-[10px] font-mono text-slate-400 hover:text-slate-200 backdrop-blur transition-all shadow-md cursor-pointer"
              title="Показать расшифровку обозначений на графике"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
              <span>Chart legend</span>
              <span className="text-[9px] text-slate-500">▼</span>
            </button>
          ) : (
            <div className="bg-[#0B0E14]/95 border border-slate-700/70 rounded-lg p-2.5 text-[10px] font-mono text-slate-300 flex flex-col gap-1.5 shadow-2xl backdrop-blur min-w-[210px]">
              <div className="flex items-center justify-between gap-3 font-bold text-slate-200 border-b border-slate-800 pb-1">
                <span className="text-[11px] text-slate-300">Обозначения</span>
                <button
                  onClick={() => setShowLegend(false)}
                  className="text-slate-500 hover:text-slate-300 px-1 rounded hover:bg-slate-800 text-xs cursor-pointer"
                  title="Свернуть"
                >
                  ✕
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-4 border-t-2 border-dashed border-purple-500 inline-block"></span>
                <span className="text-purple-300">🟣 Полка ликвидности [2K / 3K]</span>
              </div>
              <div className="text-slate-400">Нарисованные линии: Alt + перетаскивание для изменения.</div>

              {showStructure && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="px-1 py-0.2 bg-emerald-950 border border-emerald-500 text-emerald-300 rounded text-[9px] font-bold">▲ СЛОМ В ЛОНГ</span>
                    <span className="text-slate-400 text-[9px]">Разворот вверх (CHoCH)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-1 py-0.2 bg-rose-950 border border-rose-500 text-rose-300 rounded text-[9px] font-bold">▼ СЛОМ В ШОРТ</span>
                    <span className="text-slate-400 text-[9px]">Разворот вниз (CHoCH)</span>
                  </div>
                  {marketStructure?.currentKeyPivot && (
                    <div className="flex items-center gap-1.5 text-[9px] text-amber-300 pt-0.5 border-t border-slate-800/80">
                      <span>🛡 Защита тренда: ${formatChartPrice(marketStructure.currentKeyPivot.price)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div ref={containerRef} className="absolute inset-0 z-0" />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-none z-10"
          style={{ width: "100%", height: "100%" }}
        />
        {/* Caption for Volume Histogram */}
        <div className="absolute bottom-[20%] left-4 text-[10px] text-slate-500 font-mono select-none z-20 pointer-events-none">
          VOLUME · Binance
        </div>
      </div>
    </div>
  );
}
