import { fetchMarketJson, parseKlines, volumeRatio } from "../services/marketData";
import React, { useState, useEffect, useMemo, useRef } from "react";
import { X, Search, Sparkles, ChevronRight, RefreshCw, AlertTriangle, Layers2, Zap, ArrowUpRight, ArrowDownRight, Flame, Send, CheckCircle2, Loader2 } from "lucide-react";
import { TickerData, LiquidityRadarItem } from "../types";
import { isPureCryptoTicker, detectConfirmedPurpleLevels, ScannerCandle, calculateATR14 } from "../utils/liquidityScanner";
import { sendTelegramMessage, formatTelegramPrice } from "../services/telegramService";
import TelegramTestButton from "./TelegramTestButton";

interface LiquidityRadarModalProps {
  isOpen: boolean;
  onClose: () => void;
  markets: Record<string, TickerData>;
  currentCoin: string;
  selectCoin: (symbol: string, confirmedLevel?: { price: number; touches: number; volumeRatio: number; touchesLabel?: string; type?: "BSL" | "SSL" } | null) => void;
}

async function fetchBinanceKlinesForScanner(symbol: string, signal: AbortSignal) {
  const cleanSymbol = symbol.replace(/[\/_]/g, "").toUpperCase();
  return parseKlines(await fetchMarketJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=5m&limit=180`, 4500, signal));
}

export default function LiquidityRadarModal({
  isOpen,
  onClose,
  markets,
  currentCoin,
  selectCoin,
}: LiquidityRadarModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState<"ALL" | "BSL" | "SSL">("ALL");
  const [selectedTouches, setSelectedTouches] = useState<"ALL" | "2K" | "3K" | "4K+">("ALL");
  const [selectedStatus, setSelectedStatus] = useState<"ALL" | "Разъедание" | "Поджатие" | "Отскок">("ALL");
  const [minVolumeM, setMinVolumeM] = useState<number>(15); // Min $15M Volume default
  const [minAtrPercent, setMinAtrPercent] = useState<number>(0.15); // Min 0.15% ATR
  const [isScanning, setIsScanning] = useState(false);
  const [scanWarning, setScanWarning] = useState('');
  const scanController = useRef<AbortController | null>(null);
  const [radarItems, setRadarItems] = useState<LiquidityRadarItem[]>([]);
  const [lastScanTime, setLastScanTime] = useState<string>("");
  const [sendingTgId, setSendingTgId] = useState<string | null>(null);
  const [sentSuccessId, setSentSuccessId] = useState<string | null>(null);

  const handleManualSendTelegram = async (item: LiquidityRadarItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sendingTgId) return;

    setSendingTgId(item.id);
    const tickerData = markets[item.symbol];

    try {
      const cleanTicker = item.symbol.replace("/USDT", "").replace("USDT", "").toUpperCase();
      const typeLabel = item.type === "BSL" ? "🔴 BSL (Шорт-стопы)" : "🟢 SSL (Лонг-стопы)";
      const formattedLevelPrice = formatTelegramPrice(item.levelPrice);
      const formattedDistance = item.distancePercent.toFixed(2);
      const formattedVol24h = item.volumeM >= 1000 ? (item.volumeM / 1000).toFixed(2) + "B" : item.volumeM.toFixed(1);
      const formattedChange = tickerData ? `${tickerData.change >= 0 ? "+" : ""}${tickerData.change.toFixed(2)}` : "0.00";
      const timeStr = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      const messageHtml = `🎯 <b>УРОВЕНЬ ЛИКВИДНОСТИ</b>
━━━━━━━━━━━━━━━━━
🪙 <b>Монета:</b> <code>${cleanTicker}</code> <i>(нажми для копирования)</i>
📊 <b>Пул:</b> ${typeLabel} ($${formattedLevelPrice})
📍 <b>Дистанция:</b> ${formattedDistance}%
📈 <b>Объем 24h:</b> $${formattedVol24h}M | <b>Изм:</b> ${formattedChange}%
━━━━━━━━━━━━━━━━━
⏰ ${timeStr}`;

      const res = await sendTelegramMessage(messageHtml);
      if (res.success) {
        setSentSuccessId(item.id);
        setTimeout(() => setSentSuccessId(null), 3000);
      }
    } finally {
      setSendingTgId(null);
    }
  };

  // Run scanner on markets for CONFIRMED PURPLE LEVELS ONLY (Scalper Clean Levels Engine v4 - Calibrated)
  const runScan = async () => {
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
    setIsScanning(true);
    setScanWarning('');
    setRadarItems([]);
    setLastScanTime('');
    let failed = 0;
    const results: LiquidityRadarItem[] = [];
    const marketEntries = Object.values(markets)
      .filter((ticker) => isPureCryptoTicker(ticker.symbol.replace(/[\/_]/g, "")) && ticker.volume / 1_000_000 >= minVolumeM && ticker.price > 0)
      .sort((a, b) => b.volume - a.volume).slice(0, 60);

    // Process in batches of 8 concurrent requests for responsive real market scanning
    const batchSize = 8;
    for (let b = 0; b < Math.min(marketEntries.length, 60); b += batchSize) {
      if (controller.signal.aborted) return;
      const batch = marketEntries.slice(b, b + batchSize);
      await Promise.all(
        batch.map(async (ticker) => {
          const symbol = ticker.symbol;
          const volM = ticker.volume / 1_000_000;


          let candles;
          try { candles = await fetchBinanceKlinesForScanner(symbol, controller.signal); }
          catch { failed++; return; }
          if (controller.signal.aborted) return;
          if (candles.length < 30) { failed++; return; }

          // 3. ATR(14) Volatility Check
          const atrCheck = calculateATR14(candles, minAtrPercent);
          if (!atrCheck.isVolatileEnough || atrCheck.atrPercent < minAtrPercent) {
            return;
          }

          const surgeMultiplier = volumeRatio(candles);

          // 4. DETECT CONFIRMED PURPLE LEVELS on real candlestick structure
          const detectedLevels = detectConfirmedPurpleLevels(candles, symbol, ticker.volume, surgeMultiplier, minVolumeM);

          detectedLevels.forEach((dl) => {
            // Дистанция до 5.5% — позволяет находить сильные уровни для ожидания подходов в течение дня
            if (dl.distancePercent >= 0.01 && dl.distancePercent <= 5.50) {
              results.push({
                id: dl.id,
                symbol,
                type: dl.type,
                levelPrice: dl.price,
                touches: dl.touches,
                touchesLabel: dl.touchesLabel,
                distancePercent: dl.distancePercent,
                volumeMultiplier: dl.volumeMultiplier,
                status: dl.status,
                volumeM: volM,
                currentPrice: candles[candles.length - 1].close,
                atrPercent: atrCheck.atrPercent,
                surgeMultiplier: dl.surgeMultiplier,
                lastTouchTime: candles[dl.lastIndex]?.time,
              });
            }
          });
        })
      );
    }

    // Sort strictly by distance to confirmed purple level (from lowest distance to highest)
    results.sort((a, b) => a.distancePercent - b.distancePercent);

    if (controller.signal.aborted) return;
    setScanWarning(failed ? `Не удалось получить свечи для ${failed} из ${marketEntries.length} монет. Результат неполный; вымышленные данные не используются.` : marketEntries.length ? '' : 'Нет рыночных данных для сканирования. Обновите статистику Binance.');
    setRadarItems(results);
    setIsScanning(false);
    setLastScanTime(new Date().toLocaleTimeString());
  };

  useEffect(() => {
    if (isOpen) {
      setSelectedTouches("ALL"); // Значение по умолчанию: Все касания (2K, 3K, 4K+)
      runScan();
    }
    return () => { scanController.current?.abort(); };
  }, [isOpen, Object.keys(markets).length]);

  // Filtered Items
  const filteredItems = useMemo(() => {
    return radarItems.filter(item => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.toUpperCase();
        if (!item.symbol.toUpperCase().includes(q)) return false;
      }
      // Type
      if (selectedType !== "ALL" && item.type !== selectedType) return false;
      // Touches
      if (selectedTouches !== "ALL" && item.touchesLabel !== selectedTouches) return false;
      // Status
      if (selectedStatus !== "ALL" && item.status !== selectedStatus) return false;
      // Volume
      if (item.volumeM < minVolumeM) return false;

      return true;
    });
  }, [radarItems, searchQuery, selectedType, selectedTouches, selectedStatus, minVolumeM]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl bg-[#0B0E14] border border-purple-500/40 rounded-xl shadow-[0_0_50px_rgba(168,85,247,0.15)] flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-purple-500/20 bg-gradient-to-r from-purple-950/40 via-[#0E131F] to-[#0B0E14] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.3)]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100 tracking-wide">
                  РАДАР УРОВНЕЙ ЛИКВИДНОСТИ
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 shadow-[0_0_10px_rgba(6,182,212,0.25)]">
                  🎯 СКАЛЬПЕРСКИЙ СКАНЕР
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">
                Уровни по реальным свечам Binance 5m • объем текущей свечи относительно 20 предыдущих
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {lastScanTime && (
              <span className="text-[11px] text-slate-400 font-mono hidden sm:inline">
                Обновлено: {lastScanTime}
              </span>
            )}
            <TelegramTestButton variant="compact" />
            <button
              onClick={runScan}
              disabled={isScanning}
              className="px-3 py-1.5 rounded-lg bg-purple-900/60 hover:bg-purple-800 text-purple-200 border border-purple-500/40 text-xs font-mono flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isScanning ? "animate-spin" : ""}`} />
              <span>Пересканировать</span>
            </button>
            <button
              onClick={onClose}
              aria-label="Close liquidity radar"
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="px-6 py-3 border-b border-slate-800 bg-[#090C12] flex flex-wrap items-center justify-between gap-3 shrink-0">
          {/* Search Input */}
          <div className="relative min-w-[200px] flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
            <input
              type="text"
              placeholder="Поиск по монете..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#0E131F] border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 font-mono focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Type Filter */}
          <div className="flex items-center bg-[#0E131F] p-1 rounded-lg border border-slate-800 text-xs font-mono">
            <button
              onClick={() => setSelectedType("ALL")}
              className={`px-2.5 py-1 rounded transition cursor-pointer ${
                selectedType === "ALL" ? "bg-purple-600 text-white font-bold" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Все
            </button>
            <button
              onClick={() => setSelectedType("BSL")}
              className={`px-2.5 py-1 rounded flex items-center gap-1 transition cursor-pointer ${
                selectedType === "BSL" ? "bg-red-950/80 text-red-300 font-bold border border-red-500/50" : "text-slate-400 hover:text-red-300"
              }`}
            >
              <ArrowUpRight className="h-3 w-3" />
              BSL
            </button>
            <button
              onClick={() => setSelectedType("SSL")}
              className={`px-2.5 py-1 rounded flex items-center gap-1 transition cursor-pointer ${
                selectedType === "SSL" ? "bg-emerald-950/80 text-emerald-300 font-bold border border-emerald-500/50" : "text-slate-400 hover:text-emerald-300"
              }`}
            >
              <ArrowDownRight className="h-3 w-3" />
              SSL
            </button>
          </div>

          {/* Touches Filter */}
          <div className="flex items-center bg-[#0E131F] p-1 rounded-lg border border-slate-800 text-xs font-mono">
            {(["ALL", "2K", "3K", "4K+"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setSelectedTouches(t)}
                className={`px-2.5 py-1 rounded transition cursor-pointer ${
                  selectedTouches === t ? "bg-purple-600 text-white font-bold" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {t === "ALL" ? "Все кас." : t}
              </button>
            ))}
          </div>

          {/* Min Volume Threshold */}
          <div className="flex items-center gap-1 text-xs font-mono text-slate-400 bg-[#0E131F] px-2.5 py-1 rounded-lg border border-slate-800">
            <span>Объем 24h &gt; $</span>
            <select
              value={minVolumeM}
              onChange={(e) => setMinVolumeM(Number(e.target.value))}
              className="bg-transparent text-purple-400 font-bold focus:outline-none cursor-pointer"
            >
              <option value={20} className="bg-slate-900 text-slate-100">20M</option>
              <option value={50} className="bg-slate-900 text-slate-100">50M</option>
              <option value={100} className="bg-slate-900 text-slate-100">100M</option>
              <option value={250} className="bg-slate-900 text-slate-100">250M</option>
            </select>
          </div>
        </div>

        {scanWarning && <div role="alert" className="px-4 py-3 text-xs text-amber-300 border-b border-amber-800">{scanWarning}</div>}
        {/* Table Content */}
        <div className="flex-1 overflow-y-auto min-h-[320px]">
          {isScanning ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
              <RefreshCw className="h-8 w-8 text-purple-400 animate-spin" />
              <div className="text-sm font-mono">Сканирование рынка на подтвержденные фиолетовые уровни...</div>
              <div className="text-xs text-slate-500">Загрузка реальных свечей Binance и расчёт уровней</div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-2">
              <AlertTriangle className="h-8 w-8 text-amber-400/80" />
              <div className="text-sm font-bold text-slate-300 font-mono">{scanWarning ? 'Нет результатов по доступным данным' : 'Подтвержденные фиолетовые уровни не найдены'}</div>
              <div className="text-xs text-slate-500 max-w-md text-center">
                Попробуйте уменьшить порог объема 24h или изменить фильтры типа (BSL / SSL).
              </div>
            </div>
          ) : (
            <table className="w-full text-left border-collapse font-mono text-xs">
              <thead className="sticky top-0 bg-[#090C12] border-b border-slate-800 text-slate-400 text-[11px] uppercase tracking-wider z-10">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">Монета</th>
                  <th className="py-2.5 px-3 font-semibold">Тип</th>
                  <th className="py-2.5 px-3 font-semibold">Фиолетовый уровень</th>
                  <th className="py-2.5 px-3 font-semibold">Касания</th>
                  <th className="py-2.5 px-3 font-semibold text-purple-300">Объем свечи / SMA20</th>
                  <th className="py-2.5 px-3 font-semibold">Дистанция</th>
                  <th className="py-2.5 px-3 font-semibold">Статус</th>
                  <th className="py-2.5 px-3 font-semibold">ATR(14)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Объем 24h</th>
                  <th className="py-2.5 px-4 font-semibold text-center">График</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850/60">
                {filteredItems.map((item) => {
                  const isCurrent = currentCoin.toUpperCase().replace(/[\/_]/g, "") === item.symbol.toUpperCase().replace(/[\/_]/g, "");
                  const formattedLevelPrice = item.levelPrice >= 100 
                    ? item.levelPrice.toFixed(2) 
                    : item.levelPrice >= 1 
                      ? item.levelPrice.toFixed(4) 
                      : item.levelPrice.toFixed(6);

                  const formattedCurrentPrice = item.currentPrice >= 100 
                    ? item.currentPrice.toFixed(2) 
                    : item.currentPrice >= 1 
                      ? item.currentPrice.toFixed(4) 
                      : item.currentPrice.toFixed(6);

                  return (
                    <tr
                      key={item.id}
                      onClick={() => {
                        selectCoin(item.symbol, {
                          price: item.levelPrice,
                          touches: item.touches,
                          volumeRatio: item.volumeMultiplier,
                          touchesLabel: item.touchesLabel,
                          type: item.type,
                        });
                        onClose();
                      }}
                      className={`hover:bg-purple-950/20 transition cursor-pointer ${
                        isCurrent ? "bg-purple-950/40 border-l-2 border-purple-400" : ""
                      }`}
                    >
                      {/* Symbol */}
                      <td className="py-3 px-4 font-bold text-slate-100 flex items-center gap-2">
                        <span className="text-purple-300">{item.symbol}</span>
                        {isCurrent && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-500/20 text-purple-300 border border-purple-500/40">
                            Текущий
                          </span>
                        )}
                      </td>

                      {/* Type */}
                      <td className="py-3 px-3">
                        {item.type === "BSL" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-950/70 border border-red-500/40 text-red-400">
                            <ArrowUpRight className="h-3 w-3" />
                            BSL
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950/70 border border-emerald-500/40 text-emerald-400">
                            <ArrowDownRight className="h-3 w-3" />
                            SSL
                          </span>
                        )}
                      </td>

                      {/* Level Price */}
                      <td className="py-3 px-3">
                        <div className="font-bold text-purple-200 text-[13px] flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shadow-[0_0_6px_#A855F7]"></span>
                          <span>${formattedLevelPrice}</span>
                        </div>
                        <div className="text-[10px] text-slate-500">Тек: ${formattedCurrentPrice}</div>
                      </td>

                      {/* Touches */}
                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded font-extrabold text-[11px] ${
                            item.touchesLabel === "4K+"
                              ? "bg-purple-600 text-white shadow-[0_0_8px_rgba(168,85,247,0.6)]"
                              : item.touchesLabel === "3K"
                                ? "bg-purple-900/80 border border-purple-500/70 text-purple-200"
                                : "bg-slate-800 border border-purple-500/40 text-purple-300"
                          }`}
                        >
                          🟣 {item.touchesLabel} ({item.touches} кас.)
                        </span>
                      </td>

                      {/* Volume at Level (ОБЪЕМ НА УРОВНЕ) */}
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-extrabold bg-purple-950/90 border border-purple-500/60 text-purple-300 shadow-[0_0_8px_rgba(168,85,247,0.3)]">
                          ⚡ {item.volumeMultiplier.toFixed(1)}x SMA
                        </span>
                      </td>

                      {/* Distance */}
                      <td className="py-3 px-3 font-bold">
                        <span className={item.distancePercent < 0.20 ? "text-amber-400 font-extrabold animate-pulse" : "text-purple-300"}>
                          {item.distancePercent.toFixed(2)}%
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-3">
                        {item.status === "Разъедание" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 border border-amber-500/60 text-amber-300 animate-pulse shadow-[0_0_8px_rgba(245,158,11,0.3)]">
                            <Flame className="h-3 w-3 text-amber-400" />
                            🔥 Разъедание
                          </span>
                        ) : item.status === "Поджатие" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-950/60 border border-cyan-500/40 text-cyan-300">
                            <Zap className="h-3 w-3 text-cyan-400" />
                            ⚡ Поджатие
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">
                            🛡️ Отскок
                          </span>
                        )}
                      </td>

                      {/* ATR Volatility */}
                      <td className="py-3 px-3 text-slate-300">
                        <span className="px-1.5 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 text-[10px] text-emerald-400">
                          {item.atrPercent.toFixed(2)}%
                        </span>
                      </td>

                      {/* Volume 24h */}
                      <td className="py-3 px-3 text-right font-bold text-slate-300">
                        ${item.volumeM.toFixed(1)}M
                      </td>

                      {/* Action */}
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={(e) => handleManualSendTelegram(item, e)}
                            disabled={sendingTgId === item.id}
                            title="Отправить алерт этого уровня в Telegram"
                            className={`px-2 py-1 rounded text-[10px] font-mono font-bold flex items-center gap-1 transition cursor-pointer border ${
                              sentSuccessId === item.id
                                ? "bg-emerald-950 border-emerald-400 text-emerald-300"
                                : sendingTgId === item.id
                                ? "bg-slate-800 border-slate-700 text-slate-400"
                                : "bg-blue-950/70 hover:bg-blue-900 border-blue-500/40 text-blue-300"
                            }`}
                          >
                            {sendingTgId === item.id ? (
                              <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                            ) : sentSuccessId === item.id ? (
                              <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Send className="h-3 w-3 text-blue-400" />
                            )}
                            <span>{sentSuccessId === item.id ? "Отправлен" : "TG"}</span>
                          </button>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectCoin(item.symbol, {
                                price: item.levelPrice,
                                touches: item.touches,
                                volumeRatio: item.volumeMultiplier,
                                touchesLabel: item.touchesLabel,
                                type: item.type,
                              });
                              onClose();
                            }}
                            className="px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white font-bold text-[11px] flex items-center gap-1 transition cursor-pointer shadow-sm"
                          >
                            <span>График</span>
                            <ChevronRight className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-2.5 bg-[#0F1420] border-t border-slate-800 flex flex-wrap items-center justify-between text-xs text-slate-400 font-mono shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#06B6D4]"></span>
            <span>Выводятся активы с наторгованным подтвержденным уровнем (касания 2K+, всплеск объёма ≥1.5x)</span>
          </div>
          <div className="text-[11px] text-cyan-300 font-semibold">
            Сортировка по дистанции до уровня
          </div>
        </div>

      </div>
    </div>
  );
}
