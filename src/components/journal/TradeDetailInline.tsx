import React, { useEffect, useRef, useState, useMemo } from "react";
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  CandlestickSeries, 
  HistogramSeries, 
  LineStyle, 
  CrosshairMode, 
  UTCTimestamp,
  createSeriesMarkers
} from "lightweight-charts";
import { 
  Pencil, 
  Maximize2, 
  Minimize2, 
  ZoomIn, 
  ZoomOut, 
  Sliders, 
  TrendingUp, 
  Minus, 
  Square, 
  Ruler, 
  Trash2, 
  Activity, 
  Check, 
  Layers
} from "lucide-react";
import { Trade } from "../../types/journal";

interface TradeDetailInlineProps {
  trade: Trade;
  timezone?: string;
  onClose?: () => void;
}

const TIMEFRAMES = [
  "1s", "5s", "15s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w", "1M"
];

export default function TradeDetailInline({ trade, timezone = "GMT+10 (Vladivostok)", onClose }: TradeDetailInlineProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [timeframe, setTimeframe] = useState<string>("1m");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showIndicators, setShowIndicators] = useState(false);
  const [activeTool, setActiveTool] = useState<"crosshair" | "trendline" | "level" | "box" | "ruler">("crosshair");

  // Notes state
  const [notes, setNotes] = useState<string>(() => {
    try {
      return localStorage.getItem(`journal_trade_notes_${trade.id}`) || trade.notes || "";
    } catch {
      return trade.notes || "";
    }
  });
  const [notesSaved, setNotesSaved] = useState(false);

  const saveNotes = (val: string) => {
    setNotes(val);
    try {
      localStorage.setItem(`journal_trade_notes_${trade.id}`, val);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } catch {}
  };

  // Hover OHLC legend
  const [ohlcHover, setOhlcHover] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    changePct: number;
    volume: number;
  } | null>(null);

  // Initialize and populate chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Cleanup previous chart
    if (chartInstanceRef.current) {
      chartInstanceRef.current.remove();
      chartInstanceRef.current = null;
    }

    const container = chartContainerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 420,
      layout: {
        background: { color: "#0B0E14" },
        textColor: "#8A9BA8",
        fontSize: 11,
        fontFamily: "'JetBrains Mono', 'Roboto Mono', monospace",
      },
      grid: {
        vertLines: { color: "rgba(30, 41, 54, 0.4)", style: LineStyle.Dotted },
        horzLines: { color: "rgba(30, 41, 54, 0.4)", style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "#4A5568",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1E2936",
        },
        horzLine: {
          color: "#4A5568",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1E2936",
        },
      },
      timeScale: {
        borderColor: "#1E2936",
        timeVisible: true,
        secondsVisible: timeframe.includes("s"),
      },
      rightPriceScale: {
        borderColor: "#1E2936",
        scaleMargins: {
          top: 0.12,
          bottom: 0.22,
        },
      },
    });

    chartInstanceRef.current = chart;

    // Candlestick Series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#0ECB81",
      downColor: "#F6465D",
      borderUpColor: "#0ECB81",
      borderDownColor: "#F6465D",
      wickUpColor: "#0ECB81",
      wickDownColor: "#F6465D",
    });
    candleSeriesRef.current = candleSeries;

    // Volume Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "#26a69a",
      priceFormat: {
        type: "volume",
      },
      priceScaleId: "", // overlay
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });
    volumeSeriesRef.current = volumeSeries;

    // Load kline data
    let isMounted = true;
    const fetchOrGenerateKlines = async () => {
      let rawCandles: any[] = [];
      const interval = timeframe.endsWith("s") ? "1m" : timeframe;
      const startTime = trade.openTime - 120 * 60 * 1000;
      const endTime = trade.closeTime + 120 * 60 * 1000;

      try {
        const cleanSymbol = trade.symbol.replace(/[^A-Z0-9]/g, "");
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=300`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json) && json.length > 5) {
            rawCandles = json.map((k: any) => ({
              time: Math.floor(k[0] / 1000) as UTCTimestamp,
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }));
          }
        }
      } catch (e) {
        // Fallback to synthetic klines around trade
      }

      // If Binance REST is blocked or offline, generate synthetic realistic candles connecting open to close
      if (rawCandles.length < 5) {
        rawCandles = generateSyntheticCandles(trade, timeframe);
      }

      if (!isMounted) return;

      const candleData = rawCandles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      const volumeData = rawCandles.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(14, 203, 129, 0.35)" : "rgba(246, 70, 93, 0.35)",
      }));

      candleSeries.setData(candleData);
      volumeSeries.setData(volumeData);

      // Add Price Lines for Entry & Exit
      candleSeries.createPriceLine({
        price: trade.openPrice,
        color: "#3B82F6",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Вход: ${trade.openPrice}`,
      });

      candleSeries.createPriceLine({
        price: trade.closePrice,
        color: trade.realizedPnl >= 0 ? "#10B981" : "#EF4444",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Выход: ${trade.closePrice}`,
      });

      // Add Entry and Exit Markers
      const entryTimeSec = Math.floor(trade.openTime / 1000) as UTCTimestamp;
      const exitTimeSec = Math.floor(trade.closeTime / 1000) as UTCTimestamp;

      // Find nearest times in candleData
      const nearestEntry = findNearestTime(candleData, entryTimeSec);
      const nearestExit = findNearestTime(candleData, exitTimeSec);

      const markers = [
        {
          time: nearestEntry,
          position: trade.side === "LONG" ? ("belowBar" as const) : ("aboveBar" as const),
          color: trade.side === "LONG" ? "#10B981" : "#EF4444",
          shape: trade.side === "LONG" ? ("arrowUp" as const) : ("arrowDown" as const),
          text: `Вход ${trade.side} $${trade.openPrice}`,
          size: 2,
        },
        {
          time: nearestExit,
          position: trade.side === "LONG" ? ("aboveBar" as const) : ("belowBar" as const),
          color: trade.realizedPnl >= 0 ? "#10B981" : "#EF4444",
          shape: trade.side === "LONG" ? ("arrowDown" as const) : ("arrowUp" as const),
          text: `Выход (${trade.pnlPercent >= 0 ? "+" : ""}${trade.pnlPercent.toFixed(2)}%)`,
          size: 2,
        },
      ];

      try {
        createSeriesMarkers(candleSeries, markers);
      } catch (err) {
        console.warn("createSeriesMarkers fallback", err);
      }

      // Scroll and zoom to focus on trade window
      chart.timeScale().fitContent();
    };

    fetchOrGenerateKlines();

    // Crosshair move handler
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) {
        setOhlcHover(null);
        return;
      }
      const data: any = param.seriesData.get(candleSeries);
      const volData: any = param.seriesData.get(volumeSeries);
      if (data) {
        const d = new Date((param.time as number) * 1000);
        const diff = data.close - data.open;
        const changePct = data.open ? (diff / data.open) * 100 : 0;
        setOhlcHover({
          time: d.toISOString().replace("T", " ").substring(0, 19),
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          changePct,
          volume: volData ? volData.value : 0,
        });
      }
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (chartContainerRef.current && chartInstanceRef.current) {
        chartInstanceRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    });
    resizeObserver.observe(container);

    return () => {
      isMounted = false;
      resizeObserver.disconnect();
      if (chartInstanceRef.current) {
        chartInstanceRef.current.remove();
        chartInstanceRef.current = null;
      }
    };
  }, [trade, timeframe]);

  // Order execution calculation
  const orderDetails = useMemo(() => {
    const isLong = trade.side === "LONG";
    const qty = trade.qty || Number((trade.notional / trade.openPrice).toFixed(4));
    const entryTurnover = qty;
    const exitTurnover = qty;
    const entryVol = trade.openPrice * qty;
    const exitVol = trade.closePrice * qty;

    return [
      {
        side: isLong ? "↗ Маркет" : "↘ Маркет",
        sideColor: isLong ? "text-emerald-400" : "text-rose-400",
        turnover: entryTurnover.toFixed(2),
        price: trade.openPrice < 1 ? trade.openPrice.toFixed(5) : trade.openPrice.toFixed(4),
        notional: entryVol.toFixed(2),
        income: "0",
      },
      {
        side: isLong ? "↘ Маркет" : "↗ Маркет",
        sideColor: isLong ? "text-rose-400" : "text-emerald-400",
        turnover: exitTurnover.toFixed(2),
        price: trade.closePrice < 1 ? trade.closePrice.toFixed(5) : trade.closePrice.toFixed(4),
        notional: exitVol.toFixed(2),
        income: (trade.realizedPnl >= 0 ? "+" : "") + trade.realizedPnl.toFixed(3),
        incomeColor: trade.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400",
      },
    ];
  }, [trade]);

  return (
    <div className={`w-full bg-[#0D121A] border-t border-b border-emerald-500/40 shadow-2xl transition-all ${
      isFullscreen ? "fixed inset-0 z-50 p-6 bg-[#0B0E14] overflow-y-auto" : "p-3 my-1 rounded-b-md"
    }`}>
      {/* Top Header of Trade Window matching Screenshot 2 */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2936]">
        {/* Left Side: Side + Symbol + Timeframe bar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-black tracking-wider px-2 py-0.5 rounded ${
              trade.side === "LONG" ? "bg-emerald-950 text-emerald-400 border border-emerald-800" : "bg-rose-950 text-rose-400 border border-rose-800"
            }`}>
              {trade.side}
            </span>
            <span className="text-sm font-bold text-white tracking-wide font-mono">
              {trade.symbol}
            </span>
          </div>

          {/* Timeframe pill list matching Screenshot 2 */}
          <div className="flex items-center bg-[#10161F] p-0.5 rounded border border-[#1E2936] text-[11px] overflow-x-auto max-w-full font-mono">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-1.5 py-0.5 rounded transition-all ${
                  timeframe === tf ? "bg-[#1E2936] text-white font-bold" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Right Header Actions */}
        <div className="flex items-center gap-2">
          {/* fx Indicators button */}
          <button
            onClick={() => setShowIndicators(!showIndicators)}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded border transition-all ${
              showIndicators ? "bg-cyan-950/80 border-cyan-700 text-cyan-300" : "bg-[#10161F] border-[#1E2936] text-slate-300 hover:text-white"
            }`}
          >
            <span className="font-serif italic font-bold">fx</span>
            <span>Индикаторы</span>
          </button>

          {/* Zoom controls */}
          <div className="flex items-center bg-[#10161F] rounded border border-[#1E2936]">
            <button
              onClick={() => {
                const range = chartInstanceRef.current?.timeScale().getVisibleLogicalRange();
                if (range) {
                  const delta = (range.to - range.from) * 0.15;
                  chartInstanceRef.current?.timeScale().setVisibleLogicalRange({
                    from: range.from + delta,
                    to: range.to - delta,
                  });
                }
              }}
              className="p-1 hover:text-cyan-400 text-slate-400 transition-colors"
              title="Приблизить (+)"
            >
              <ZoomIn size={14} />
            </button>
            <button
              onClick={() => {
                const range = chartInstanceRef.current?.timeScale().getVisibleLogicalRange();
                if (range) {
                  const delta = (range.to - range.from) * 0.15;
                  chartInstanceRef.current?.timeScale().setVisibleLogicalRange({
                    from: range.from - delta,
                    to: range.to + delta,
                  });
                }
              }}
              className="p-1 hover:text-cyan-400 text-slate-400 transition-colors border-l border-[#1E2936]"
              title="Отдалить (-)"
            >
              <ZoomOut size={14} />
            </button>
          </div>

          {/* Fullscreen toggle */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded bg-[#10161F] border border-[#1E2936] text-slate-300 hover:text-white transition-colors"
            title={isFullscreen ? "Свернуть" : "Развернуть на весь экран"}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* Main Grid: Left Chart (70%) + Right Details (30%) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 mt-3">
        {/* Left Column: Chart with Left Drawing Toolbar (lg:col-span-8 or 9) */}
        <div className="lg:col-span-8 xl:col-span-9 flex flex-col bg-[#0B0E14] rounded-lg border border-[#1E2936] overflow-hidden">
          {/* OHLC Legend Bar */}
          <div className="h-7 px-3 flex items-center gap-3 text-[11px] font-mono border-b border-[#1A2330] bg-[#0E131C] text-slate-400 overflow-x-auto whitespace-nowrap">
            {ohlcHover ? (
              <>
                <span className="text-slate-300 font-semibold">{ohlcHover.time}</span>
                <span>O <b className="text-slate-200">{ohlcHover.open}</b></span>
                <span>H <b className="text-slate-200">{ohlcHover.high}</b></span>
                <span>L <b className="text-slate-200">{ohlcHover.low}</b></span>
                <span>C <b className={ohlcHover.close >= ohlcHover.open ? "text-emerald-400" : "text-rose-400"}>{ohlcHover.close}</b></span>
                <span>
                  Δ <b className={ohlcHover.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    {ohlcHover.changePct >= 0 ? "+" : ""}{ohlcHover.changePct.toFixed(2)}%
                  </b>
                </span>
                <span>V <b className="text-slate-300">{ohlcHover.volume.toLocaleString()}</b></span>
              </>
            ) : (
              <span className="text-slate-500 italic">
                {trade.symbol} • Вход: ${trade.openPrice} • Выход: ${trade.closePrice} • Итог: {trade.pnlPercent >= 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)}%
              </span>
            )}
          </div>

          {/* Chart Workspace with Left Drawing Toolbar */}
          <div className="flex-1 flex min-h-[380px] relative">
            {/* Left Drawing Sidebar Toolbar matching Tiger.Trade */}
            <div className="w-10 flex-shrink-0 bg-[#0E131C] border-r border-[#1E2936] flex flex-col items-center py-2 gap-2 text-slate-400">
              <button
                onClick={() => setActiveTool("crosshair")}
                className={`p-1.5 rounded hover:bg-[#1E2936] transition-colors ${activeTool === "crosshair" ? "bg-[#1E2936] text-cyan-400" : ""}`}
                title="Перекрестие"
              >
                <Activity size={14} />
              </button>
              <button
                onClick={() => setActiveTool("trendline")}
                className={`p-1.5 rounded hover:bg-[#1E2936] transition-colors ${activeTool === "trendline" ? "bg-[#1E2936] text-cyan-400" : ""}`}
                title="Трендовая линия"
              >
                <TrendingUp size={14} />
              </button>
              <button
                onClick={() => setActiveTool("level")}
                className={`p-1.5 rounded hover:bg-[#1E2936] transition-colors ${activeTool === "level" ? "bg-[#1E2936] text-cyan-400" : ""}`}
                title="Горизонтальный уровень"
              >
                <Minus size={14} />
              </button>
              <button
                onClick={() => setActiveTool("box")}
                className={`p-1.5 rounded hover:bg-[#1E2936] transition-colors ${activeTool === "box" ? "bg-[#1E2936] text-cyan-400" : ""}`}
                title="Прямоугольник зоны"
              >
                <Square size={14} />
              </button>
              <button
                onClick={() => setActiveTool("ruler")}
                className={`p-1.5 rounded hover:bg-[#1E2936] transition-colors ${activeTool === "ruler" ? "bg-[#1E2936] text-cyan-400" : ""}`}
                title="Линейка (Shift)"
              >
                <Ruler size={14} />
              </button>
              <div className="w-6 h-px bg-[#1E2936] my-1" />
              <button
                onClick={() => {
                  chartInstanceRef.current?.timeScale().fitContent();
                }}
                className="p-1.5 rounded hover:bg-[#1E2936] text-slate-500 hover:text-slate-300 transition-colors"
                title="Сбросить масштаб"
              >
                <Sliders size={14} />
              </button>
            </div>

            {/* Canvas Container */}
            <div className="flex-1 relative min-h-[380px]">
              <div ref={chartContainerRef} className="w-full h-full absolute inset-0" />
              
              {/* Tiger.com Watermark in Chart center matching Screenshot 2 */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-5">
                <span className="text-6xl font-black tracking-widest text-white select-none font-mono">
                  tiger.com
                </span>
              </div>

              {/* Trade Result Overlay Badge on the chart */}
              <div className="absolute top-3 right-4 pointer-events-none z-10 flex flex-col items-end gap-1">
                <span className={`px-2.5 py-1 rounded text-xs font-bold font-mono tracking-wide shadow-lg border ${
                  trade.realizedPnl >= 0 
                    ? "bg-emerald-950/90 text-emerald-400 border-emerald-700/80" 
                    : "bg-rose-950/90 text-rose-400 border-rose-700/80"
                }`}>
                  {trade.pnlPercent >= 0 ? "+" : ""}{trade.pnlPercent.toFixed(2)} %
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Notes + Execution Orders Table matching Screenshot 2 */}
        <div className="lg:col-span-4 xl:col-span-3 flex flex-col gap-3">
          {/* Notes Card: "Добавить описание" */}
          <div className="bg-[#10161F] p-3 rounded-lg border border-[#1E2936] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Pencil size={13} className="text-cyan-400" />
                <span>Добавить описание</span>
              </span>
              {notesSaved && (
                <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono">
                  <Check size={11} /> Сохранено
                </span>
              )}
            </div>
            <textarea
              rows={3}
              placeholder="Заметки по сделке: почему вошёл, соблюдение риск-менеджмента, ошибки..."
              value={notes}
              onChange={(e) => saveNotes(e.target.value)}
              className="w-full bg-[#0B0E14] border border-[#1E2936] rounded p-2 text-xs text-slate-200 outline-none focus:border-cyan-500 resize-none font-sans"
            />
          </div>

          {/* Orders Breakdown Table matching Screenshot 2 */}
          <div className="bg-[#10161F] p-3 rounded-lg border border-[#1E2936] flex flex-col">
            <span className="text-xs font-semibold text-slate-300 mb-2">
              Исполнение ордеров
            </span>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-[#1E2936] text-[11px] text-slate-400">
                    <th className="pb-1.5 font-medium">Ордер</th>
                    <th className="pb-1.5 font-medium text-right">Оборот</th>
                    <th className="pb-1.5 font-medium text-right">Цена, $</th>
                    <th className="pb-1.5 font-medium text-right">Объём, $</th>
                    <th className="pb-1.5 font-medium text-right">Доход, $</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1A2330]">
                  {orderDetails.map((order, idx) => (
                    <tr key={idx} className="hover:bg-[#16202C]">
                      <td className={`py-2 font-bold ${order.sideColor}`}>
                        {order.side}
                      </td>
                      <td className="py-2 text-right text-slate-300">
                        {order.turnover}
                      </td>
                      <td className="py-2 text-right text-slate-200 font-semibold">
                        {order.price}
                      </td>
                      <td className="py-2 text-right text-slate-300">
                        {order.notional}
                      </td>
                      <td className={`py-2 text-right font-bold ${order.incomeColor || "text-slate-400"}`}>
                        {order.income}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Quick summary stats at bottom of orders table */}
            <div className="mt-3 pt-2.5 border-t border-[#1E2936] flex items-center justify-between text-[11px] text-slate-400">
              <span>Комиссия: <b className="text-slate-300">${trade.commission.toFixed(3)}</b></span>
              <span>
                Итог: <b className={trade.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {trade.realizedPnl >= 0 ? "+" : ""}{trade.realizedPnl.toFixed(2)} $
                </b>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper: Find closest candle timestamp to target
function findNearestTime(candles: { time: UTCTimestamp }[], target: UTCTimestamp): UTCTimestamp {
  if (candles.length === 0) return target;
  let closest = candles[0].time;
  let minDiff = Math.abs(closest - target);

  for (let i = 1; i < candles.length; i++) {
    const diff = Math.abs(candles[i].time - target);
    if (diff < minDiff) {
      minDiff = diff;
      closest = candles[i].time;
    }
  }
  return closest;
}

// Helper: generate realistic synthetic candles around trade
function generateSyntheticCandles(trade: Trade, tf: string): any[] {
  const candles: any[] = [];
  const stepSec = tf.includes("s") ? 5 : tf === "5m" ? 300 : tf === "15m" ? 900 : tf === "1h" ? 3600 : 60;
  const count = 90;
  const entryIdx = Math.floor(count * 0.45);
  const exitIdx = Math.floor(count * 0.55);

  const basePrice = trade.openPrice || 1.0;
  const priceRange = Math.abs(trade.closePrice - trade.openPrice) || basePrice * 0.005;
  const startTimeSec = Math.floor(trade.openTime / 1000) - entryIdx * stepSec;

  let currentPrice = trade.openPrice - (trade.closePrice - trade.openPrice) * 0.4;

  for (let i = 0; i < count; i++) {
    const time = (startTimeSec + i * stepSec) as UTCTimestamp;
    
    // Target price progression
    let target = basePrice;
    if (i < entryIdx) {
      target = basePrice + Math.sin(i * 0.4) * priceRange * 0.5;
    } else if (i <= exitIdx) {
      // Progress from open to close price
      const prog = (i - entryIdx) / (exitIdx - entryIdx);
      target = trade.openPrice + (trade.closePrice - trade.openPrice) * prog;
    } else {
      // Post-trade action
      target = trade.closePrice + Math.sin(i * 0.3) * priceRange * 0.4;
    }

    const noise = (Math.random() - 0.49) * priceRange * 0.25;
    const open = i === 0 ? target : candles[i - 1].close;
    const close = target + noise;
    const high = Math.max(open, close) + Math.random() * priceRange * 0.2;
    const low = Math.min(open, close) - Math.random() * priceRange * 0.2;
    const volume = Math.floor(20000 + Math.random() * 80000 + (i === entryIdx || i === exitIdx ? 120000 : 0));

    candles.push({ time, open, high, low, close, volume });
  }

  // Ensure exact open and close at entry/exit candles
  if (candles[entryIdx]) {
    candles[entryIdx].open = trade.openPrice;
  }
  if (candles[exitIdx]) {
    candles[exitIdx].close = trade.closePrice;
  }

  return candles;
}
