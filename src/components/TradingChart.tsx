import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  UTCTimestamp, 
  CandlestickSeries, 
  HistogramSeries,
  LineStyle,
  CrosshairMode,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer
} from "lightweight-charts";
import { 
  Timer, 
  Magnet, 
  Trash2, 
  Layers, 
  BarChart3, 
  X,
  Target,
  ArrowRight,
  Ruler,
  Copy,
  Check
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

interface RayPoint {
  x: number | null;
  y: number | null;
  price: number;
  time: number;
  type: "HIGH" | "LOW";
}

class HorizontalRayPaneRenderer implements IPrimitivePaneRenderer {
  private _points: RayPoint[];
  private _currentPrice: number | null;

  constructor(points: RayPoint[], currentPrice: number | null) {
    this._points = points;
    this._currentPrice = currentPrice;
  }

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio || 1;
      const vpr = scope.verticalPixelRatio || 1;
      const width = scope.bitmapSize.width;

      for (const pt of this._points) {
        if (pt.y === null || typeof pt.y !== "number" || isNaN(pt.y)) continue;
        if (typeof pt.price !== "number" || isNaN(pt.price)) continue;

        try {
          const yScaled = Math.round(pt.y * vpr);
          // Start X: if candle is visible, start at candle X; if scrolled left, start at 0
          const startX = pt.x !== null && !isNaN(pt.x) ? Math.max(0, Math.round(pt.x * hpr)) : 0;
          const endX = width; // Draw all the way to the right edge!

          if (startX >= endX) continue;

          // 1. Draw horizontal dashed ray
          ctx.strokeStyle = "#C084FC"; // Purple
          ctx.lineWidth = Math.round(1.8 * vpr);
          ctx.setLineDash([Math.round(6 * hpr), Math.round(4 * hpr)]);
          ctx.beginPath();
          ctx.moveTo(startX, yScaled);
          ctx.lineTo(endX, yScaled);
          ctx.stroke();
          ctx.setLineDash([]);

          // 2. Draw origin dot at the exact candle High/Low
          if (pt.x !== null && !isNaN(pt.x) && pt.x >= 0 && pt.x <= (scope.mediaSize?.width || width)) {
            const originX = Math.round(pt.x * hpr);
            ctx.fillStyle = "#A855F7";
            ctx.beginPath();
            ctx.arc(originX, yScaled, Math.round(4 * vpr), 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#FFFFFF";
            ctx.lineWidth = Math.round(1.5 * vpr);
            ctx.stroke();
          }

          // 3. Draw badge at the right end of the ray
          const dist = (this._currentPrice && this._currentPrice > 0)
            ? ((pt.price - this._currentPrice) / this._currentPrice) * 100
            : 0;
          const distStr = `${dist >= 0 ? "+" : ""}${dist.toFixed(2)}%`;
          const priceStr = pt.price >= 1000 
            ? pt.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : pt.price >= 1 
            ? pt.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
            : pt.price.toFixed(6);

          const label = `${pt.type} $${priceStr} (${distStr})`;
          const fontSize = Math.round(11 * vpr);
          ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
          const textWidth = ctx.measureText(label).width;
          const badgeW = textWidth + Math.round(14 * hpr);
          const badgeH = Math.round(20 * vpr);
          const badgeX = Math.max(0, endX - badgeW - Math.round(6 * hpr));
          const badgeY = yScaled - badgeH / 2;

          ctx.fillStyle = "rgba(16, 22, 31, 0.95)";
          ctx.strokeStyle = "rgba(168, 85, 247, 0.8)";
          ctx.lineWidth = Math.round(1 * vpr);
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(badgeX, badgeY, badgeW, badgeH, Math.round(4 * vpr));
          } else {
            ctx.rect(badgeX, badgeY, badgeW, badgeH);
          }
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#F3E8FF";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, badgeX + badgeW / 2, yScaled);
        } catch {}
      }
    });
  }
}

class HorizontalRayPaneView implements IPrimitivePaneView {
  private _source: HorizontalRayPrimitive;
  private _points: RayPoint[] = [];

  constructor(source: HorizontalRayPrimitive) {
    this._source = source;
  }

  update() {
    const series = this._source.series;
    const chart = this._source.chart;
    if (!series || !chart) {
      this._points = [];
      return;
    }

    const timeScale = chart.timeScale();
    const levels = this._source.levels;

    this._points = levels.map((lvl) => {
      const y = series.priceToCoordinate(lvl.price);
      const x = timeScale.timeToCoordinate(lvl.time as UTCTimestamp);
      return {
        x: x !== null ? Number(x) : null,
        y: y !== null ? Number(y) : null,
        price: lvl.price,
        time: lvl.time,
        type: lvl.type,
      };
    });
  }

  renderer(): IPrimitivePaneRenderer {
    return new HorizontalRayPaneRenderer(this._points, this._source.currentPrice);
  }
}

class HorizontalRayPrimitive implements ISeriesPrimitive {
  private _chart: IChartApi;
  private _series: ISeriesApi<any>;
  private _levels: UserLevel[] = [];
  private _currentPrice: number | null = null;
  private _paneViews: HorizontalRayPaneView[];
  private _requestUpdate: (() => void) | null = null;

  constructor(chart: IChartApi, series: ISeriesApi<any>) {
    this._chart = chart;
    this._series = series;
    this._paneViews = [new HorizontalRayPaneView(this)];
  }

  attached(param: any) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this.requestUpdate();
  }

  detached() {
    this._requestUpdate = null;
  }

  requestUpdate() {
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  updateAllViews() {
    this._paneViews.forEach((pv) => pv.update());
  }

  paneViews() {
    return this._paneViews;
  }

  setLevels(levels: UserLevel[], currentPrice: number | null) {
    this._levels = levels;
    this._currentPrice = currentPrice;
    this.updateAllViews();
    this.requestUpdate();
  }

  get chart() { return this._chart; }
  get series() { return this._series; }
  get levels() { return this._levels; }
  get currentPrice() { return this._currentPrice; }
}

interface RulerData {
  timeA: number;
  priceA: number;
  timeB: number;
  priceB: number;
  isLocked: boolean;
  barsCount?: number;
  timeSpanStr?: string;
  volStr?: string;
}

interface RulerRenderData {
  xA: number | null;
  yA: number | null;
  xB: number | null;
  yB: number | null;
  priceA: number;
  priceB: number;
  barsCount?: number;
  timeSpanStr?: string;
  volStr?: string;
  isLocked: boolean;
}

function formatRulerTimeSpan(sec: number): string {
  if (sec < 60) return `${sec}с`;
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins}м`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}ч ${remMins}м` : `${hours}ч`;
}

function formatRulerVolUsd(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

class RulerPaneRenderer implements IPrimitivePaneRenderer {
  private _data: RulerRenderData | null;

  constructor(data: RulerRenderData | null) {
    this._data = data;
  }

  draw(target: any) {
    if (!this._data) return;
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio || 1;
      const vpr = scope.verticalPixelRatio || 1;
      const d = this._data;
      if (!d || d.xA === null || d.yA === null || d.xB === null || d.yB === null) return;
      if (isNaN(d.xA) || isNaN(d.yA) || isNaN(d.xB) || isNaN(d.yB)) return;

      const xA = Math.round(d.xA * hpr);
      const yA = Math.round(d.yA * vpr);
      const xB = Math.round(d.xB * hpr);
      const yB = Math.round(d.yB * vpr);

      const minX = Math.min(xA, xB);
      const maxX = Math.max(xA, xB);
      const minY = Math.min(yA, yB);
      const maxY = Math.max(yA, yB);
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);

      const deltaPrice = d.priceB - d.priceA;
      const percent = d.priceA > 0 ? (deltaPrice / d.priceA) * 100 : 0;
      const isUp = deltaPrice >= 0;

      // 1. Shaded Measurement Area (soft tint)
      ctx.fillStyle = isUp ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)";
      ctx.fillRect(minX, minY, w, h);

      // 2. Dashed Boundary Rectangle
      ctx.strokeStyle = isUp ? "rgba(34, 197, 94, 0.75)" : "rgba(239, 68, 68, 0.75)";
      ctx.lineWidth = Math.round(1 * vpr);
      ctx.setLineDash([Math.round(4 * hpr), Math.round(3 * hpr)]);
      ctx.strokeRect(minX, minY, w, h);
      ctx.setLineDash([]);

      // 3. Diagonal Vector Line from Point A to Point B
      ctx.strokeStyle = isUp ? "#22C55E" : "#EF4444";
      ctx.lineWidth = Math.round(1.5 * vpr);
      ctx.beginPath();
      ctx.moveTo(xA, yA);
      ctx.lineTo(xB, yB);
      ctx.stroke();

      // 4. Anchor Point Circles
      const drawAnchor = (x: number, y: number) => {
        ctx.fillStyle = isUp ? "#22C55E" : "#EF4444";
        ctx.beginPath();
        ctx.arc(x, y, Math.round(3.5 * vpr), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.round(1.5 * vpr);
        ctx.stroke();
      };
      drawAnchor(xA, yA);
      drawAnchor(xB, yB);

      // 5. Scalper Info Card (Floating Badge)
      const sign = isUp ? "+" : "";
      const priceFmt = Math.abs(deltaPrice) >= 1000 
        ? Math.abs(deltaPrice).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : Math.abs(deltaPrice) >= 1
        ? Math.abs(deltaPrice).toFixed(4)
        : Math.abs(deltaPrice).toFixed(6);

      const line1 = `${sign}${percent.toFixed(2)}% (${sign}$${priceFmt})`;
      const line2 = `${d.barsCount || 1} баров${d.timeSpanStr ? ` (${d.timeSpanStr})` : ""}${d.volStr ? ` · ${d.volStr}` : ""}`;

      const fontTitle = `bold ${Math.round(11 * vpr)}px 'JetBrains Mono', monospace`;
      const fontSub = `${Math.round(10 * vpr)}px 'JetBrains Mono', monospace`;

      ctx.font = fontTitle;
      const w1 = ctx.measureText(line1).width;
      ctx.font = fontSub;
      const w2 = ctx.measureText(line2).width;

      const badgeW = Math.max(w1, w2) + Math.round(18 * hpr);
      const badgeH = Math.round(38 * vpr);

      const padding = Math.round(8 * hpr);
      let badgeX = xB + padding;
      if (badgeX + badgeW > scope.bitmapSize.width - padding) {
        badgeX = xB - badgeW - padding;
      }
      if (badgeX < padding) badgeX = padding;

      let badgeY = yB - badgeH / 2;
      if (badgeY < padding) badgeY = padding;
      if (badgeY + badgeH > scope.bitmapSize.height - padding) {
        badgeY = scope.bitmapSize.height - badgeH - padding;
      }

      ctx.fillStyle = "rgba(11, 15, 20, 0.94)";
      ctx.strokeStyle = isUp ? "rgba(34, 197, 94, 0.85)" : "rgba(239, 68, 68, 0.85)";
      ctx.lineWidth = Math.round(1.2 * vpr);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, Math.round(5 * vpr));
      } else {
        ctx.rect(badgeX, badgeY, badgeW, badgeH);
      }
      ctx.fill();
      ctx.stroke();

      ctx.font = fontTitle;
      ctx.fillStyle = isUp ? "#4ADE80" : "#F87171";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(line1, badgeX + Math.round(9 * hpr), badgeY + Math.round(6 * vpr));

      ctx.font = fontSub;
      ctx.fillStyle = "#94A3B8";
      ctx.fillText(line2, badgeX + Math.round(9 * hpr), badgeY + Math.round(21 * vpr));
    });
  }
}

class RulerPaneView implements IPrimitivePaneView {
  private _source: RulerPrimitive;
  private _renderData: RulerRenderData | null = null;

  constructor(source: RulerPrimitive) {
    this._source = source;
  }

  update() {
    const series = this._source.series;
    const chart = this._source.chart;
    const ruler = this._source.ruler;
    if (!series || !chart || !ruler) {
      this._renderData = null;
      return;
    }

    const timeScale = chart.timeScale();
    const xA = timeScale.timeToCoordinate(ruler.timeA as UTCTimestamp);
    const yA = series.priceToCoordinate(ruler.priceA);
    const xB = timeScale.timeToCoordinate(ruler.timeB as UTCTimestamp);
    const yB = series.priceToCoordinate(ruler.priceB);

    this._renderData = {
      xA: xA !== null ? Number(xA) : null,
      yA: yA !== null ? Number(yA) : null,
      xB: xB !== null ? Number(xB) : null,
      yB: yB !== null ? Number(yB) : null,
      priceA: ruler.priceA,
      priceB: ruler.priceB,
      barsCount: ruler.barsCount,
      timeSpanStr: ruler.timeSpanStr,
      volStr: ruler.volStr,
      isLocked: ruler.isLocked,
    };
  }

  renderer(): IPrimitivePaneRenderer {
    return new RulerPaneRenderer(this._renderData);
  }
}

class RulerPrimitive implements ISeriesPrimitive {
  private _chart: IChartApi;
  private _series: ISeriesApi<any>;
  private _ruler: RulerData | null = null;
  private _paneViews: RulerPaneView[];
  private _requestUpdate: (() => void) | null = null;

  constructor(chart: IChartApi, series: ISeriesApi<any>) {
    this._chart = chart;
    this._series = series;
    this._paneViews = [new RulerPaneView(this)];
  }

  attached(param: any) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this.requestUpdate();
  }

  detached() {
    this._requestUpdate = null;
  }

  requestUpdate() {
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  updateAllViews() {
    this._paneViews.forEach((pv) => pv.update());
  }

  paneViews() {
    return this._paneViews;
  }

  setRuler(ruler: RulerData | null) {
    this._ruler = ruler;
    this.updateAllViews();
    this.requestUpdate();
  }

  get chart() { return this._chart; }
  get series() { return this._series; }
  get ruler() { return this._ruler; }
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
  const rayPrimitiveRef = useRef<HorizontalRayPrimitive | null>(null);
  const rulerPrimitiveRef = useRef<RulerPrimitive | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // States
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [userLevels, setUserLevels] = useState<UserLevel[]>([]);
  const [magnetMode, setMagnetMode] = useState<boolean>(true);
  const [levelToolActive, setLevelToolActive] = useState<boolean>(false);
  const [rulerToolActive, setRulerToolActive] = useState<boolean>(false);
  const [isShiftPressed, setIsShiftPressed] = useState<boolean>(false);
  const [copiedTicker, setCopiedTicker] = useState<boolean>(false);
  const [showWalls, setShowWalls] = useState<boolean>(true);
  const [showVolume, setShowVolume] = useState<boolean>(true);
  const [chartStatus, setChartStatus] = useState<string>("Загрузка свечей...");
  const [countdown, setCountdown] = useState<string>("");
  const [reloadTrigger, setReloadTrigger] = useState<number>(0);

  // Mutable refs to prevent chart re-initialization on state updates
  const candlesRef = useRef<MarketCandle[]>([]);
  const wallLinesRef = useRef<any[]>([]);
  const userLevelsRef = useRef<UserLevel[]>(userLevels);
  userLevelsRef.current = userLevels;
  const levelToolActiveRef = useRef<boolean>(levelToolActive);
  levelToolActiveRef.current = levelToolActive;
  const rulerToolActiveRef = useRef<boolean>(rulerToolActive);
  rulerToolActiveRef.current = rulerToolActive;
  const isShiftPressedRef = useRef<boolean>(false);
  const rulerMeasuringRef = useRef<boolean>(false);
  const rulerStartRef = useRef<{ time: number; price: number } | null>(null);
  const rulerStateRef = useRef<RulerData | null>(null);
  const magnetModeRef = useRef<boolean>(magnetMode);
  magnetModeRef.current = magnetMode;
  const currentPriceRef = useRef<number | null>(currentPrice);
  currentPriceRef.current = currentPrice;

  // Global hotkey listener for 'H' (Level), 'Shift' (Ruler), and 'Escape'
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement || 
        e.target instanceof HTMLTextAreaElement || 
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (e.key === "Shift") {
        isShiftPressedRef.current = true;
        setIsShiftPressed(true);
      } else if (e.key === "h" || e.key === "H" || e.key === "р" || e.key === "Р") {
        e.preventDefault();
        setLevelToolActive((prev) => !prev);
      } else if (e.key === "Escape") {
        setLevelToolActive(false);
        setRulerToolActive(false);
        rulerMeasuringRef.current = false;
        rulerStartRef.current = null;
        rulerStateRef.current = null;
        rulerPrimitiveRef.current?.setRuler(null);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        isShiftPressedRef.current = false;
        setIsShiftPressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const cleanSymbol = symbol.replace("/", "").toUpperCase();
  const tickerInfo = markets ? markets[symbol] : null;

  // Copy ticker to clipboard utility
  const copyTicker = useCallback(() => {
    const text = cleanSymbol;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const input = document.createElement("input");
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopiedTicker(true);
    setTimeout(() => setCopiedTicker(false), 1500);
  }, [cleanSymbol]);

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
        const parsed = JSON.parse(saved);
        userLevelsRef.current = parsed;
        setUserLevels(parsed);
        rayPrimitiveRef.current?.setLevels(parsed, currentPriceRef.current);
      } else {
        userLevelsRef.current = [];
        setUserLevels([]);
        rayPrimitiveRef.current?.setLevels([], currentPriceRef.current);
      }
    } catch {
      userLevelsRef.current = [];
      setUserLevels([]);
      rayPrimitiveRef.current?.setLevels([], currentPriceRef.current);
    }
  }, [cleanSymbol]);

  // Save levels to localStorage
  const saveLevels = useCallback((levels: UserLevel[]) => {
    userLevelsRef.current = levels;
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

    // Attach native HorizontalRayPrimitive (renders directly in chart's canvas loop)
    const rayPrimitive = new HorizontalRayPrimitive(chart, candleSeries);
    rayPrimitiveRef.current = rayPrimitive;
    rayPrimitive.setLevels(userLevelsRef.current, currentPriceRef.current);
    candleSeries.attachPrimitive(rayPrimitive);

    // Attach native RulerPrimitive (Shift + ЛКМ scalper measurement tool)
    const rulerPrimitive = new RulerPrimitive(chart, candleSeries);
    rulerPrimitiveRef.current = rulerPrimitive;
    candleSeries.attachPrimitive(rulerPrimitive);

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

    // 5. Live data: Dual WebSocket (/market/ws/ kline + aggTrade) + REST polling fallback
    let wsReconnectTimeout: any = null;
    let wsKlineInstance: WebSocket | null = null;
    let wsTradeInstance: WebSocket | null = null;
    let wsFailCount = 0;
    let wsGotMessage = false;
    let restPollInterval: any = null;

    // Helper: update chart with a single candle tick
    const applyTick = (candle: MarketCandle) => {
      if (isDisposed || !isValidCandle(candle)) return;
      const time = candle.time as UTCTimestamp;

      setCurrentPrice(candle.close);
      candleSeries.update({
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });

      const isUp = candle.close >= candle.open;
      volumeSeries.update({
        time,
        value: candle.volume,
        color: isUp ? "rgba(34, 197, 94, 0.65)" : "rgba(239, 68, 68, 0.65)",
      });

      // Update cache
      const cache = candlesRef.current;
      if (cache.length) {
        const lastIdx = cache.length - 1;
        if (cache[lastIdx].time === candle.time) {
          cache[lastIdx] = candle;
        } else if (candle.time > cache[lastIdx].time) {
          cache.push(candle);
          if (cache.length > 1000) cache.shift();
        }
      }
    };

    // Helper: update chart with an aggTrade tick for zero-latency, buttery smooth Binance tick-by-tick updates
    const applyTradeTick = (price: number, qty: number, tradeTimeMs: number) => {
      if (isDisposed || !Number.isFinite(price) || price <= 0) return;
      setCurrentPrice(price);

      const cache = candlesRef.current;
      if (!cache.length) return;

      let tfSec = 60;
      if (timeframe === "5m") tfSec = 300;
      else if (timeframe === "15m") tfSec = 900;
      else if (timeframe === "1h") tfSec = 3600;
      else if (timeframe === "4h") tfSec = 14400;
      else if (timeframe === "1d") tfSec = 86400;

      const last = cache[cache.length - 1];
      const tradeSec = Math.floor(tradeTimeMs / 1000);

      // If trade has crossed into the next candle period
      if (tradeSec >= last.time + tfSec) {
        const nextCandleTime = Math.floor(tradeSec / tfSec) * tfSec;
        const newCandle: MarketCandle = {
          time: nextCandleTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: Number.isFinite(qty) && qty > 0 ? qty * price : 0,
        };
        applyTick(newCandle);
      } else {
        // Update current active candle tick-by-tick
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        if (Number.isFinite(qty) && qty > 0) {
          last.volume += qty * price;
        }
        applyTick(last);
      }
    };

    // REST polling fallback: fetch last 2 candles every 1000ms
    // Starts immediately as safety net; WS will disable it if alive
    const startRestPolling = () => {
      if (restPollInterval || isDisposed) return;
      restPollInterval = setInterval(async () => {
        if (isDisposed) return;
        try {
          const raw = await fetchMarketJson(
            `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=${timeframe}&limit=2`,
            4000,
            abortCtrl.signal
          );
          const candles = parseKlines(raw);
          if (candles.length) {
            const last = candles[candles.length - 1];
            applyTick(last);
          }
        } catch {}
      }, 1000);
    };

    const stopRestPolling = () => {
      if (restPollInterval) {
        clearInterval(restPollInterval);
        restPollInterval = null;
      }
    };

    const connectWS = () => {
      if (isDisposed) return;
      if (wsKlineInstance) {
        try { wsKlineInstance.close(); } catch {}
      }
      if (wsTradeInstance) {
        try { wsTradeInstance.close(); } catch {}
      }

      // Binance Futures active WebSocket endpoints use /market/ws/
      const domain = wsFailCount >= 2 ? "fstream.binance.info" : "fstream.binance.com";
      const wsKlineUrl = `wss://${domain}/market/ws/${cleanSymbol.toLowerCase()}@kline_${timeframe}`;
      const wsTradeUrl = `wss://${domain}/market/ws/${cleanSymbol.toLowerCase()}@aggTrade`;

      const wsKline = new WebSocket(wsKlineUrl);
      const wsTrade = new WebSocket(wsTradeUrl);
      wsKlineInstance = wsKline;
      wsTradeInstance = wsTrade;
      wsRef.current = wsKline;
      wsGotMessage = false;

      const onWsMessageReceived = () => {
        if (!wsGotMessage) {
          wsGotMessage = true;
          wsFailCount = 0;
          if (restPollInterval) {
            stopRestPolling();
          }
          setChartStatus("Binance Futures: Live");
        }
      };

      // 1. Authoritative Kline Stream
      wsKline.onopen = () => {
        if (isDisposed) return;
        setChartStatus("Binance Futures: Live");
      };

      wsKline.onmessage = (event) => {
        if (isDisposed) return;
        onWsMessageReceived();
        try {
          const msg = JSON.parse(event.data);
          if (msg.k) {
            const k = msg.k;
            const time = Math.floor(k.t / 1000);
            const open = parseFloat(k.o);
            let high = parseFloat(k.h);
            let low = parseFloat(k.l);
            const close = parseFloat(k.c);
            const quoteVol = parseFloat(k.q);

            high = Math.max(high, open, close);
            low = Math.min(low, open, close);

            applyTick({ time, open, high, low, close, volume: quoteVol });
          }
        } catch {}
      };

      wsKline.onclose = () => {
        if (isDisposed) return;
        wsFailCount++;
        if (wsFailCount >= 3) {
          startRestPolling();
        } else {
          setChartStatus("Переподключение WS...");
        }
        wsReconnectTimeout = setTimeout(connectWS, wsFailCount >= 3 ? 10000 : 2500);
      };

      wsKline.onerror = () => {
        if (isDisposed) return;
        try { wsKline.close(); } catch {}
      };

      // 2. Millisecond Tick-by-Tick aggTrade Stream (instant Binance smoothness)
      wsTrade.onmessage = (event) => {
        if (isDisposed) return;
        onWsMessageReceived();
        try {
          const msg = JSON.parse(event.data);
          if (msg.e === "aggTrade" && msg.p) {
            applyTradeTick(parseFloat(msg.p), parseFloat(msg.q), msg.T || Date.now());
          }
        } catch {}
      };

      wsTrade.onerror = () => {
        if (isDisposed) return;
        try { wsTrade.close(); } catch {}
      };
    };

    const loadHistory = async () => {
      setChartStatus("Загрузка свечей Binance...");
      const endpoints = [
        `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=${timeframe}&limit=500`,
        `https://fapi.binance.info/fapi/v1/klines?symbol=${cleanSymbol}&interval=${timeframe}&limit=500`,
      ];

      let rawData: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (isDisposed) return false;
        const endpoint = endpoints[attempt % endpoints.length];
        try {
          rawData = await fetchMarketJson(endpoint, 7000, abortCtrl.signal);
          if (rawData) break;
        } catch (err) {
          if (isDisposed || abortCtrl.signal.aborted) return false;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      if (!rawData) {
        if (!isDisposed) {
          setChartStatus("Ошибка соединения с Binance");
        }
        return false;
      }

      try {
        const candles = parseKlines(rawData);
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

        candleSeries.setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );

        const volData = candles.map((c, i) => {
          const slice = candles.slice(Math.max(0, i - 20), i);
          const avgVol = slice.length ? slice.reduce((acc, curr) => acc + curr.volume, 0) / slice.length : c.volume;
          const isSpike = c.volume > avgVol * 1.8;
          const isUp = c.close >= c.open;
          let color = isUp ? "rgba(34, 197, 94, 0.65)" : "rgba(239, 68, 68, 0.65)";
          if (isSpike) color = isUp ? "#EAB308" : "#F97316";
          return { time: c.time as UTCTimestamp, value: c.volume, color };
        });

        volumeSeries.setData(volData);
        chart.timeScale().fitContent();
        rayPrimitiveRef.current?.updateAllViews();
        setChartStatus("Binance Futures: Live");
        return true;
      } catch (err) {
        if (!isDisposed) {
          console.error("Klines parsing error:", err);
          setChartStatus("Ошибка парсинга свечей");
        }
        return false;
      }
    };

    loadHistory().then((ok) => {
      if (ok && !isDisposed) {
        // Start REST polling IMMEDIATELY as safety net
        startRestPolling();
        // Also try WS — if WS works, it will disable polling automatically
        connectWS();
      }
    });

    // 7. Click listener on chart to place levels or measure with ruler (Shift + ЛКМ)
    chart.subscribeClick((param) => {
      if (!param.point || !candleSeriesRef.current) return;

      const isShift = !!(param.sourceEvent?.shiftKey || isShiftPressedRef.current);
      const isRulerTrigger = isShift || rulerToolActiveRef.current;

      const rawPrice = candleSeriesRef.current.coordinateToPrice(param.point.y);
      if (rawPrice === null) return;
      const clickedPrice = Number(rawPrice);

      let clickedTime: number | null = param.time ? Number(param.time) : null;
      if (clickedTime === null) {
        const timeFromCoord = chart.timeScale().coordinateToTime(param.point.x);
        if (timeFromCoord) {
          clickedTime = Number(timeFromCoord);
        } else if (candlesRef.current.length) {
          clickedTime = candlesRef.current[candlesRef.current.length - 1].time;
        }
      }
      if (clickedTime === null) return;

      // Handle Ruler Measurement (Shift + ЛКМ or Ruler Tool)
      if (isRulerTrigger || rulerMeasuringRef.current) {
        let snapPrice = clickedPrice;
        let snapTime = clickedTime;
        if (magnetModeRef.current && candlesRef.current.length) {
          const candle = candlesRef.current.find((c) => c.time === clickedTime) || 
            candlesRef.current.reduce((prev, curr) => Math.abs(curr.time - clickedTime!) < Math.abs(prev.time - clickedTime!) ? curr : prev);
          if (candle) {
            const diffHigh = Math.abs(candle.high - clickedPrice);
            const diffLow = Math.abs(candle.low - clickedPrice);
            snapPrice = diffHigh <= diffLow ? candle.high : candle.low;
            snapTime = candle.time;
          }
        }

        if (!rulerMeasuringRef.current) {
          // Point A: Start ruler
          rulerStartRef.current = { time: snapTime, price: snapPrice };
          rulerMeasuringRef.current = true;
          const initialRuler: RulerData = {
            timeA: snapTime,
            priceA: snapPrice,
            timeB: snapTime,
            priceB: snapPrice,
            isLocked: false,
            barsCount: 1,
            timeSpanStr: "0с",
          };
          rulerStateRef.current = initialRuler;
          rulerPrimitiveRef.current?.setRuler(initialRuler);
          return;
        } else {
          // Point B: Lock ruler
          if (rulerStateRef.current) {
            const lockedRuler = { ...rulerStateRef.current, isLocked: true };
            rulerStateRef.current = lockedRuler;
            rulerPrimitiveRef.current?.setRuler(lockedRuler);
          }
          rulerMeasuringRef.current = false;
          rulerStartRef.current = null;
          setRulerToolActive(false);
          return;
        }
      }

      // If a ruler was already displayed and user clicks normally, dismiss the ruler
      if (rulerStateRef.current) {
        rulerStateRef.current = null;
        rulerMeasuringRef.current = false;
        rulerStartRef.current = null;
        rulerPrimitiveRef.current?.setRuler(null);
      }

      // Handle Level placement (H)
      if (!levelToolActiveRef.current) return;

      let finalPrice = clickedPrice;
      let finalTime = clickedTime;
      let levelType: "HIGH" | "LOW" = "HIGH";

      if (magnetModeRef.current && candlesRef.current.length) {
        const candle = candlesRef.current.find((c) => c.time === clickedTime) || 
          candlesRef.current.reduce((prev, curr) => Math.abs(curr.time - clickedTime!) < Math.abs(prev.time - clickedTime!) ? curr : prev);

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
      userLevelsRef.current = updated;
      saveLevels(updated);
      rayPrimitiveRef.current?.setLevels(updated, currentPriceRef.current);
      setLevelToolActive(false);
    });

    // 8. Crosshair move listener for live ruler preview (Zero Lag 60fps)
    chart.subscribeCrosshairMove((param) => {
      if (!rulerMeasuringRef.current || !rulerStartRef.current || !param.point || !candleSeriesRef.current) return;

      const rawPrice = candleSeriesRef.current.coordinateToPrice(param.point.y);
      if (rawPrice === null) return;
      let currPrice = Number(rawPrice);

      let currTime: number | null = param.time ? Number(param.time) : null;
      if (currTime === null) {
        const timeFromCoord = chart.timeScale().coordinateToTime(param.point.x);
        if (timeFromCoord) {
          currTime = Number(timeFromCoord);
        } else if (candlesRef.current.length) {
          currTime = candlesRef.current[candlesRef.current.length - 1].time;
        }
      }
      if (currTime === null) return;

      // Magnet snap on point B
      if (magnetModeRef.current && candlesRef.current.length) {
        const candle = candlesRef.current.find((c) => c.time === currTime) || 
          candlesRef.current.reduce((prev, curr) => Math.abs(curr.time - currTime!) < Math.abs(prev.time - currTime!) ? curr : prev);
        if (candle) {
          const diffHigh = Math.abs(candle.high - currPrice);
          const diffLow = Math.abs(candle.low - currPrice);
          currPrice = diffHigh <= diffLow ? candle.high : candle.low;
          currTime = candle.time;
        }
      }

      const start = rulerStartRef.current;
      const candles = candlesRef.current;

      // Calculate bar count & volume sum
      let barsCount = 1;
      let volStr: string | undefined = undefined;
      if (candles.length) {
        const idxA = candles.findIndex((c) => c.time === start.time);
        const idxB = candles.findIndex((c) => c.time === currTime);
        if (idxA !== -1 && idxB !== -1) {
          const minIdx = Math.min(idxA, idxB);
          const maxIdx = Math.max(idxA, idxB);
          barsCount = maxIdx - minIdx + 1;
          const volSum = candles.slice(minIdx, maxIdx + 1).reduce((acc, c) => acc + c.volume, 0);
          volStr = formatRulerVolUsd(volSum);
        }
      }

      const timeSpanSec = Math.abs(currTime - start.time);
      const timeSpanStr = formatRulerTimeSpan(timeSpanSec);

      const updatedRuler: RulerData = {
        timeA: start.time,
        priceA: start.price,
        timeB: currTime,
        priceB: currPrice,
        isLocked: false,
        barsCount,
        timeSpanStr,
        volStr,
      };

      rulerStateRef.current = updatedRuler;
      rulerPrimitiveRef.current?.setRuler(updatedRuler);
    });

    return () => {
      isDisposed = true;
      abortCtrl.abort();
      if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
      stopRestPolling();
      resizeObserver.disconnect();
      if (wsKlineInstance) {
        try { wsKlineInstance.close(); } catch {}
      }
      if (wsTradeInstance) {
        try { wsTradeInstance.close(); } catch {}
      }
      if (rayPrimitiveRef.current && candleSeriesRef.current) {
        try {
          candleSeriesRef.current.detachPrimitive(rayPrimitiveRef.current);
        } catch {}
      }
      if (rulerPrimitiveRef.current && candleSeriesRef.current) {
        try {
          candleSeriesRef.current.detachPrimitive(rulerPrimitiveRef.current);
        } catch {}
      }
      rayPrimitiveRef.current = null;
      rulerPrimitiveRef.current = null;
      chart.remove();
      chartRef.current = null;
    };
  }, [cleanSymbol, timeframe, saveLevels, reloadTrigger]); // STABLE DEPENDENCIES: Never re-creates chart on tool clicks!

  // Update rays primitive whenever userLevels or currentPrice changes
  useEffect(() => {
    if (rayPrimitiveRef.current) {
      rayPrimitiveRef.current.setLevels(userLevels, currentPrice);
    }
  }, [userLevels, currentPrice]);

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
    const updated = userLevelsRef.current.filter((lvl) => lvl.id !== id);
    userLevelsRef.current = updated;
    saveLevels(updated);
    rayPrimitiveRef.current?.setLevels(updated, currentPriceRef.current);
  };

  const clearAllLevels = () => {
    userLevelsRef.current = [];
    saveLevels([]);
    rayPrimitiveRef.current?.setLevels([], currentPriceRef.current);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0B0F14] overflow-hidden select-none border-t border-[#1E2936]">
      {/* Scalper Top Toolbar */}
      <div className="h-11 flex-shrink-0 flex items-center justify-between px-3 bg-[#10161F] border-b border-[#1E2936] text-xs">
        {/* Left: Ticker, Price & Candle Countdown */}
        <div className="flex items-center gap-3">
          <div 
            className="flex items-center gap-1.5 font-bold cursor-pointer group select-none hover:opacity-90 active:scale-95 transition-all relative"
            onClick={copyTicker}
            title="Нажмите, чтобы скопировать тикер в буфер обмена"
          >
            <span className="text-white text-sm tracking-wide group-hover:text-cyan-400 transition-colors flex items-center gap-1.5">
              {symbol}
              {copiedTicker ? (
                <span className="text-emerald-400 text-[10px] font-mono font-normal flex items-center gap-1 bg-emerald-950/90 border border-emerald-500/50 px-1.5 py-0.5 rounded shadow">
                  <Check size={11} className="text-emerald-400" /> Скопировано!
                </span>
              ) : (
                <Copy size={11} className="text-slate-500 group-hover:text-cyan-400 opacity-60 group-hover:opacity-100 transition-opacity" />
              )}
            </span>
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
          {/* Ruler Tool (Shift + ЛКМ) */}
          <button
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-semibold transition-all ${
              rulerToolActive || isShiftPressed
                ? "bg-cyan-950/80 border-cyan-500 text-cyan-300 ring-2 ring-cyan-500/30" 
                : "bg-[#141C26] border-[#1E2936] text-slate-300 hover:border-slate-600"
            }`}
            onClick={() => setRulerToolActive(!rulerToolActive)}
            title="Линейка: Shift + ЛКМ на графике для замера расстояния, % и баров (Esc — сбросить)"
          >
            <Ruler size={13} className={rulerToolActive || isShiftPressed ? "text-cyan-400 animate-pulse" : "text-slate-400"} />
            <span>{rulerToolActive ? "Замер..." : "Линейка (Shift)"}</span>
          </button>

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
      <div className={`relative flex-1 w-full h-full min-h-0 ${levelToolActive || rulerToolActive || isShiftPressed ? "cursor-crosshair" : ""}`}>
        {/* TradingView Chart Container */}
        <div ref={containerRef} className="w-full h-full" />

        {/* Status Indicator Banner (When loading or reconnecting or error) */}
        {chartStatus !== "Binance Futures: Live" && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#10161F]/95 border border-[#1E2936] text-xs font-mono shadow-lg backdrop-blur-sm pointer-events-auto">
            {chartStatus.includes("Загрузка") || chartStatus.includes("WS") ? (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            ) : (
              <span className="w-2 h-2 rounded-full bg-rose-500" />
            )}
            <span className={chartStatus.includes("Ошибка") ? "text-rose-300 font-semibold" : "text-slate-300"}>
              {chartStatus}
            </span>
            {chartStatus.includes("Ошибка") && (
              <button
                onClick={() => setReloadTrigger((v) => v + 1)}
                className="ml-2 px-2 py-0.5 rounded bg-rose-950/80 border border-rose-700/60 text-rose-200 text-[10px] hover:bg-rose-900 transition-colors"
              >
                Повторить
              </button>
            )}
          </div>
        )}

        {/* Level Tool Drawing Hint */}
        {levelToolActive && (
          <div className="absolute top-3 right-4 z-30 flex items-center gap-2 px-3 py-1 rounded bg-purple-950/90 border border-purple-500/80 text-purple-200 font-mono text-xs shadow-lg backdrop-blur-sm pointer-events-none animate-pulse">
            <Target size={13} className="text-purple-400" />
            <span>Кликните по свече для установки луча (Esc — отмена)</span>
          </div>
        )}

        {/* Ruler Tool Measuring Hint */}
        {(rulerToolActive || isShiftPressed) && (
          <div className="absolute top-3 right-4 z-30 flex items-center gap-2 px-3 py-1 rounded bg-cyan-950/90 border border-cyan-500/80 text-cyan-200 font-mono text-xs shadow-lg backdrop-blur-sm pointer-events-none animate-pulse">
            <Ruler size={13} className="text-cyan-400" />
            <span>Линейка: Shift + ЛКМ или кликните две точки (Esc — сбросить)</span>
          </div>
        )}

        {/* Floating Active Levels Pills (Quick Delete) */}
        {userLevels.length > 0 && (
          <div className="absolute top-2 left-2 z-20 flex flex-wrap gap-1.5 max-w-xl pointer-events-auto">
            {userLevels.map((lvl) => (
              <span
                key={lvl.id}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#10161F]/90 border border-purple-500/40 text-purple-300 font-mono text-[11px] backdrop-blur-sm shadow-md"
              >
                <span className="text-slate-400 text-[10px]">{lvl.type}</span>
                <span className="font-semibold">${formatPrice(lvl.price)}</span>
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

        {/* Volume Legend Tip (Safely positioned above time scale with dark backdrop) */}
        {showVolume && (
          <div className="absolute bottom-10 left-3 z-20 text-[10px] text-slate-400 font-mono flex items-center gap-2 px-2 py-0.5 rounded bg-[#0B0F14]/90 border border-[#1E2936]/80 backdrop-blur-sm pointer-events-none select-none">
            <span className="text-slate-400">Объём: <b>USDT ($)</b></span>
            <span className="text-slate-600">|</span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-yellow-400" />
              <span className="text-yellow-300/90">&gt;1.8x SMA20</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
