import React, { useState, useMemo, useCallback } from "react";
import { 
  BarChart3, 
  PieChart, 
  Calendar, 
  TrendingUp, 
  TrendingDown, 
  Key, 
  RefreshCw, 
  Clock, 
  ExternalLink, 
  ShieldCheck, 
  Filter, 
  Search, 
  Download, 
  ArrowUpRight, 
  ArrowDownRight, 
  CheckCircle2, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  X,
  Sparkles,
  Layers,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import { Trade, JournalStats, JournalApiConfig, WeekSummary } from "../../types/journal";
import { 
  loadSavedTrades, 
  saveTrades, 
  loadApiConfig, 
  saveApiConfig, 
  calculateJournalStats, 
  calculateWeekSummaries, 
  formatTradeTime,
  syncBinanceTrades 
} from "../../services/journalService";

interface TradingJournalTabProps {
  onOpenChart: (symbol: string) => void;
}

export default function TradingJournalTab({ onOpenChart }: TradingJournalTabProps) {
  // Navigation inside Journal: "dashboard" | "summary" | "trades"
  const [activeSubTab, setActiveSubTab] = useState<"dashboard" | "summary" | "trades">("dashboard");
  const [trades, setTrades] = useState<Trade[]>(() => loadSavedTrades());
  const [apiConfig, setApiConfig] = useState<JournalApiConfig>(() => loadApiConfig());
  const [isApiModalOpen, setIsApiModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Timezone setting
  const [timezone, setTimezone] = useState<string>(apiConfig.timezone || "GMT+10 (Vladivostok)");

  // Summary Tab month vs day filter
  const [summaryPeriod, setSummaryPeriod] = useState<"month" | "day">("month");

  // Trades Tab filters
  const [tradeSearch, setTradeSearch] = useState("");
  const [sideFilter, setSideFilter] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [pnlFilter, setPnlFilter] = useState<"ALL" | "WIN" | "LOSS">("ALL");
  const [tradePage, setTradePage] = useState(1);
  const rowsPerPage = 20;

  // Calculate live stats from current trades
  const stats: JournalStats = useMemo(() => calculateJournalStats(trades), [trades]);
  const weekSummaries: WeekSummary[] = useMemo(() => calculateWeekSummaries(trades), [trades]);

  // Filtered trades for table
  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (tradeSearch && !t.symbol.toLowerCase().includes(tradeSearch.toLowerCase())) {
        return false;
      }
      if (sideFilter !== "ALL" && t.side !== sideFilter) {
        return false;
      }
      if (pnlFilter === "WIN" && t.realizedPnl <= 0) return false;
      if (pnlFilter === "LOSS" && t.realizedPnl >= 0) return false;
      return true;
    });
  }, [trades, tradeSearch, sideFilter, pnlFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredTrades.length / rowsPerPage));
  const paginatedTrades = useMemo(() => {
    const start = (tradePage - 1) * rowsPerPage;
    return filteredTrades.slice(start, start + rowsPerPage);
  }, [filteredTrades, tradePage]);

  // Sync handler with API
  const handleSync = async () => {
    if (!apiConfig.apiKey || !apiConfig.apiSecret) {
      setIsApiModalOpen(true);
      return;
    }
    setIsSyncing(true);
    setSyncStatus("Синхронизация с биржей...");
    try {
      const fetched = await syncBinanceTrades(apiConfig.apiKey, apiConfig.apiSecret);
      if (fetched.length) {
        // Merge without duplicates by ID
        const existingIds = new Set(trades.map((t) => t.id));
        const newOnes = fetched.filter((t) => !existingIds.has(t.id));
        const updated = [...newOnes, ...trades];
        setTrades(updated);
        saveTrades(updated);
        setSyncStatus(`Успешно! Добавлено ${newOnes.length} новых сделок.`);
      } else {
        setSyncStatus("Новых сделок не обнаружено.");
      }
    } catch (err: any) {
      setSyncStatus(`Ошибка синхронизации: ${err.message || "Неверный API ключ"}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus(null), 4000);
    }
  };

  // Export CSV handler
  const handleExportCsv = () => {
    const headers = ["ID", "Тикер", "Сторона", "Категория", "Вход $", "Выход $", "Время входа", "Время выхода", "PnL $", "PnL %", "Комиссия $", "Объём $"];
    const rows = filteredTrades.map((t) => [
      t.id,
      t.symbol,
      t.side,
      t.category || "",
      t.openPrice,
      t.closePrice,
      formatTradeTime(t.openTime, timezone),
      formatTradeTime(t.closeTime, timezone),
      t.realizedPnl,
      t.pnlPercent,
      t.commission,
      t.notional,
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `pulse_journal_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0B0F14] text-slate-200 select-none overflow-hidden font-sans">
      {/* Top Bar: Brand, Navigation Tabs, Actions */}
      <div className="h-12 flex-shrink-0 flex items-center justify-between px-4 bg-[#10161F] border-b border-[#1E2936] text-xs">
        {/* Left: Brand Badge & Sub-navigation */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#161F2C] border border-[#233144] font-semibold text-slate-300">
            <span className="text-white font-bold tracking-wider">tiger.com</span>
            <span className="text-slate-500 font-mono">✕</span>
            <span className="text-amber-400 font-bold">Binance</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1 animate-pulse" title="Подключено" />
          </div>

          <div className="flex items-center gap-1 bg-[#141C26] p-0.5 rounded border border-[#1E2936]">
            <button
              className={`px-3 py-1 rounded font-semibold transition-all ${
                activeSubTab === "dashboard"
                  ? "bg-[#1E2936] text-cyan-400 shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setActiveSubTab("dashboard")}
            >
              Дашборд
            </button>
            <button
              className={`px-3 py-1 rounded font-semibold transition-all ${
                activeSubTab === "summary"
                  ? "bg-[#1E2936] text-cyan-400 shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setActiveSubTab("summary")}
            >
              Итоги
            </button>
            <button
              className={`px-3 py-1 rounded font-semibold transition-all ${
                activeSubTab === "trades"
                  ? "bg-[#1E2936] text-cyan-400 shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setActiveSubTab("trades")}
            >
              Мои сделки ({trades.length})
            </button>
          </div>
        </div>

        {/* Right: Timezone, Refresh, API Settings */}
        <div className="flex items-center gap-2">
          {/* Timezone Indicator */}
          <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono bg-[#141C26] px-2.5 py-1 rounded border border-[#1E2936]">
            <Clock size={12} className="text-cyan-400" />
            <span>Время:</span>
            <select
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                const updated = { ...apiConfig, timezone: e.target.value };
                setApiConfig(updated);
                saveApiConfig(updated);
              }}
              className="bg-transparent text-emerald-400 font-semibold outline-none cursor-pointer text-[11px]"
            >
              <option value="GMT+10 (Vladivostok)" className="bg-[#10161F] text-slate-200">GMT+10 (Vladivostok)</option>
              <option value="GMT+3 (Moscow)" className="bg-[#10161F] text-slate-200">GMT+3 (Moscow)</option>
              <option value="GMT+2 (Kaliningrad)" className="bg-[#10161F] text-slate-200">GMT+2 (Kaliningrad)</option>
              <option value="UTC" className="bg-[#10161F] text-slate-200">UTC</option>
            </select>
          </div>

          {/* Sync / Refresh Button */}
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#141C26] border border-[#1E2936] text-slate-300 hover:border-slate-500 hover:text-white transition-all text-[11px]"
            title="Обновить историю сделок из Tiger.Trade / Binance"
          >
            <RefreshCw size={12} className={isSyncing ? "animate-spin text-cyan-400" : "text-slate-400"} />
            <span>Обновить</span>
          </button>

          {/* API Keys Configuration Button */}
          <button
            onClick={() => setIsApiModalOpen(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-semibold transition-all ${
              apiConfig.apiKey 
                ? "bg-[#141C26] border-emerald-500/50 text-emerald-400" 
                : "bg-cyan-950/60 border-cyan-500/60 text-cyan-300 hover:bg-cyan-900/60"
            }`}
          >
            <Key size={12} />
            <span>API {apiConfig.apiKey ? "✓" : "Подключить"}</span>
          </button>
        </div>
      </div>

      {/* Sync Status Banner */}
      {syncStatus && (
        <div className={`px-4 py-1.5 text-xs font-mono text-center transition-all ${
          syncStatus.includes("Ошибка") ? "bg-rose-950/80 text-rose-300 border-b border-rose-800" : "bg-emerald-950/80 text-emerald-300 border-b border-emerald-800"
        }`}>
          {syncStatus}
        </div>
      )}

      {/* Tab 1: ДАШБОРД */}
      {activeSubTab === "dashboard" && (
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Top Row: Metrics Cards matching Screenshot 3 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3">
            {/* Speedometer Winrate Card */}
            <div className="col-span-1 md:col-span-2 xl:col-span-2 bg-[#10161F] p-3.5 rounded-lg border border-[#1E2936] flex items-center justify-between shadow-sm">
              <div className="flex flex-col">
                <span className="text-[11px] text-slate-400 font-semibold">% плюсовых сделок</span>
                <span className="text-2xl font-bold font-mono text-white mt-1">
                  {stats.winRate.toFixed(2)} %
                </span>
                <span className="text-[11px] text-slate-500 font-mono mt-0.5">
                  {stats.totalTrades} сделок
                </span>
              </div>
              {/* Circular Gauge / Speedometer */}
              <div className="relative w-20 h-20 flex items-center justify-center">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-[#1E2936]"
                    strokeWidth="3.5"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className={stats.winRate >= 50 ? "text-emerald-400" : "text-cyan-400"}
                    strokeDasharray={`${stats.winRate}, 100`}
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <div className="absolute text-[11px] font-mono font-bold text-cyan-300">
                  {stats.winningTrades}W/{stats.losingTrades}L
                </div>
              </div>
            </div>

            {/* Turnover (Оборот) */}
            <div className="bg-[#10161F] p-3.5 rounded-lg border border-[#1E2936] flex flex-col justify-between">
              <span className="text-[11px] text-slate-400 font-semibold">Оборот</span>
              <span className="text-xl font-bold font-mono text-white mt-1">
                {stats.totalVolume.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $
              </span>
              <span className="text-[10px] text-slate-500 font-mono mt-1">Объём торгов</span>
            </div>

            {/* Cumulative Profit (Совокупная прибыль) */}
            <div className={`p-3.5 rounded-lg border flex flex-col justify-between ${
              stats.netPnl >= 0 
                ? "bg-emerald-950/20 border-emerald-500/40 text-emerald-400" 
                : "bg-rose-950/20 border-rose-500/40 text-rose-400"
            }`}>
              <span className="text-[11px] font-semibold text-slate-300">Совокупная прибыль</span>
              <span className="text-xl font-bold font-mono mt-1">
                {stats.netPnl >= 0 ? "+" : ""}{stats.netPnl.toFixed(2)} $
              </span>
              <span className="text-[10px] font-mono opacity-80 mt-1">Чистый результат</span>
            </div>

            {/* Long / Short Donut Card */}
            <div className="col-span-1 md:col-span-2 xl:col-span-2 bg-[#10161F] p-3.5 rounded-lg border border-[#1E2936] flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[11px] text-slate-400 font-semibold">Распределение по L/S</span>
                <div className="flex items-center gap-3 mt-2 text-xs font-mono font-bold">
                  <span className="flex items-center gap-1.5 text-emerald-400">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    {stats.totalTrades ? Math.round((stats.longCount / stats.totalTrades) * 100) : 0}% LONG
                  </span>
                  <span className="flex items-center gap-1.5 text-amber-400">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    {stats.totalTrades ? Math.round((stats.shortCount / stats.totalTrades) * 100) : 0}% SHORT
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono mt-1">
                  {stats.longCount} лонгов · {stats.shortCount} шортов
                </span>
              </div>
              {/* Donut graphic */}
              <div className="relative w-14 h-14">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-amber-500"
                    strokeWidth="4"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className="text-emerald-400"
                    strokeDasharray={`${stats.totalTrades ? (stats.longCount / stats.totalTrades) * 100 : 50}, 100`}
                    strokeWidth="4"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
              </div>
            </div>

            {/* Commissions */}
            <div className="bg-[#10161F] p-3.5 rounded-lg border border-[#1E2936] flex flex-col justify-between">
              <span className="text-[11px] text-slate-400 font-semibold">Комиссия</span>
              <span className="text-xl font-bold font-mono text-amber-300 mt-1">
                {stats.totalCommission.toFixed(2)} $
              </span>
              <span className="text-[10px] text-slate-500 font-mono mt-1">Биржевой сбор</span>
            </div>

            {/* Profit Factor */}
            <div className="bg-[#10161F] p-3.5 rounded-lg border border-[#1E2936] flex flex-col justify-between">
              <span className="text-[11px] text-slate-400 font-semibold">Коэфф. прибыли</span>
              <span className="text-xl font-bold font-mono text-cyan-300 mt-1">
                {stats.profitFactor.toFixed(2)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono mt-1">Profit Factor</span>
            </div>
          </div>

          {/* Secondary Stats Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[#10161F] px-4 py-2.5 rounded-lg border border-[#1E2936] flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Сред. плюс. сделка</span>
              <span className="font-mono font-bold text-emerald-400">+{stats.avgWinPercent.toFixed(2)} %</span>
            </div>
            <div className="bg-[#10161F] px-4 py-2.5 rounded-lg border border-[#1E2936] flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Сред. минус. сделка</span>
              <span className="font-mono font-bold text-rose-400">-{stats.avgLossPercent.toFixed(2)} %</span>
            </div>
            <div className="bg-[#10161F] px-4 py-2.5 rounded-lg border border-[#1E2936] flex items-center justify-between">
              <span className="text-[11px] text-slate-400">МПУ (Макс. просадка)</span>
              <span className="font-mono font-bold text-amber-400">-{stats.maxDrawdown.toFixed(2)} %</span>
            </div>
            <div className="bg-[#10161F] px-4 py-2.5 rounded-lg border border-[#1E2936] flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Ср. удержание</span>
              <span className="font-mono font-bold text-slate-200">{stats.avgHoldSec} сек</span>
            </div>
          </div>

          {/* Charts Row: Equity Curves matching Screenshot 3 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Chart 1: Кумулятивный прирост к депозиту (%) */}
            <div className="bg-[#10161F] p-4 rounded-lg border border-[#1E2936] shadow-sm flex flex-col">
              <div className="flex items-center justify-between pb-3 border-b border-[#1E2936]/60">
                <span className="font-bold text-sm text-slate-200">Кумулятивный прирост к депозиту</span>
                <span className="text-xs font-mono text-cyan-400 font-semibold">% эквити</span>
              </div>
              <div className="h-64 w-full pt-4 flex items-center justify-center">
                <EquityChart data={stats.equityCurvePercent} unit="%" color="#6366F1" />
              </div>
            </div>

            {/* Chart 2: Кумулятивная прибыль ($) */}
            <div className="bg-[#10161F] p-4 rounded-lg border border-[#1E2936] shadow-sm flex flex-col">
              <div className="flex items-center justify-between pb-3 border-b border-[#1E2936]/60">
                <span className="font-bold text-sm text-slate-200">Кумулятивная прибыль</span>
                <span className={`text-xs font-mono font-semibold ${stats.netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {stats.netPnl >= 0 ? "+" : ""}{stats.netPnl.toFixed(2)} $
                </span>
              </div>
              <div className="h-64 w-full pt-4 flex items-center justify-center">
                <EquityChart data={stats.equityCurveUsd} unit="$" color={stats.netPnl >= 0 ? "#10B981" : "#8B5CF6"} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: ИТОГИ / КАЛЕНДАРЬ */}
      {activeSubTab === "summary" && (
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold font-mono text-white">2026</span>
              <span className="text-sm font-semibold text-slate-400">Сентябрь</span>
            </div>
            <div className="flex items-center gap-1 bg-[#141C26] p-0.5 rounded border border-[#1E2936]">
              <button
                className={`px-3 py-1 rounded text-xs font-semibold ${
                  summaryPeriod === "month" ? "bg-[#1E2936] text-cyan-400 font-bold" : "text-slate-400"
                }`}
                onClick={() => setSummaryPeriod("month")}
              >
                Текущий месяц
              </button>
              <button
                className={`px-3 py-1 rounded text-xs font-semibold ${
                  summaryPeriod === "day" ? "bg-[#1E2936] text-cyan-400 font-bold" : "text-slate-400"
                }`}
                onClick={() => setSummaryPeriod("day")}
              >
                Текущий день
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* Left Card: Итоги Месяца (matching Screenshot 1) */}
            <div className="lg:col-span-1 bg-[#10161F] p-4 rounded-lg border border-[#1E2936] space-y-4 shadow-sm">
              <div className="border-b border-[#1E2936] pb-2 flex items-center justify-between">
                <span className="font-bold text-sm text-white">Итоги</span>
                <span className="text-[10px] text-slate-500 font-mono">СЕНТ 2026</span>
              </div>

              <div>
                <span className="text-[11px] text-slate-400">Чистая прибыль</span>
                <div className={`text-2xl font-bold font-mono mt-0.5 ${stats.netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {stats.netPnl >= 0 ? "+" : ""}{stats.netPnl.toFixed(2)} $
                </div>
              </div>

              <div>
                <span className="text-[11px] text-slate-400">Процент побед</span>
                <div className="text-2xl font-bold font-mono text-white mt-0.5">
                  {stats.winRate.toFixed(2)} %
                </div>
              </div>

              <div className="pt-2 border-t border-[#1E2936] space-y-2 text-xs">
                <div className="flex justify-between font-mono">
                  <span className="text-slate-400">L/S Соотношение</span>
                  <span className="text-slate-200">
                    {stats.totalTrades ? Math.round((stats.longCount / stats.totalTrades) * 100) : 0}% / {stats.totalTrades ? Math.round((stats.shortCount / stats.totalTrades) * 100) : 0}%
                  </span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-slate-400">Коэфф. прибыли</span>
                  <span className="text-cyan-400 font-bold">{stats.profitFactor.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-slate-400">Комиссия</span>
                  <span className="text-amber-300">{stats.totalCommission.toFixed(2)} $</span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-slate-400">Объём</span>
                  <span className="text-white font-semibold">{stats.totalVolume.toFixed(2)} $</span>
                </div>
              </div>
            </div>

            {/* Right Cards: Weeks of September (matching Screenshot 1) */}
            <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {weekSummaries.map((w) => (
                <div
                  key={w.id}
                  className="bg-[#10161F] p-4 rounded-lg border border-[#1E2936] flex flex-col justify-between space-y-4 hover:border-slate-600 transition-all shadow-sm"
                >
                  <div className="text-center pb-2 border-b border-[#1E2936]">
                    <span className="text-xs font-mono font-bold tracking-wider text-slate-300">
                      {w.rangeLabel}
                    </span>
                  </div>

                  <div className="text-center py-2">
                    <div className={`text-2xl font-bold font-mono ${
                      w.pnl > 0 ? "text-emerald-400" : w.pnl < 0 ? "text-rose-400" : "text-slate-400"
                    }`}>
                      {w.pnl > 0 ? "+" : ""}{w.pnl.toFixed(2)} $
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">Чистая прибыль</span>
                  </div>

                  <div className="space-y-2 text-xs font-mono pt-2 border-t border-[#1E2936]">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Сделки</span>
                      <span className="text-white font-bold">{w.tradesCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Объём</span>
                      <span className="text-slate-300">{w.volume.toFixed(2)} $</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Винрейт</span>
                      <span className={`font-bold ${w.winRate >= 50 ? "text-emerald-400" : "text-cyan-400"}`}>
                        {w.winRate.toFixed(2)} %
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: МОИ СДЕЛКИ (matching Screenshot 2) */}
      {activeSubTab === "trades" && (
        <div className="flex-1 min-h-0 flex flex-col p-4">
          {/* Controls & Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Поиск монеты (LSK, H, BTC)..."
                  value={tradeSearch}
                  onChange={(e) => {
                    setTradeSearch(e.target.value);
                    setTradePage(1);
                  }}
                  className="bg-[#10161F] border border-[#1E2936] rounded pl-8 pr-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500 w-56 font-mono"
                />
              </div>

              {/* Side Filter */}
              <div className="flex items-center bg-[#10161F] p-0.5 rounded border border-[#1E2936] text-[11px]">
                <button
                  className={`px-2 py-1 rounded font-semibold ${sideFilter === "ALL" ? "bg-[#1E2936] text-white" : "text-slate-400"}`}
                  onClick={() => setSideFilter("ALL")}
                >
                  Все
                </button>
                <button
                  className={`px-2 py-1 rounded font-semibold ${sideFilter === "LONG" ? "bg-emerald-950 text-emerald-400" : "text-slate-400"}`}
                  onClick={() => setSideFilter("LONG")}
                >
                  Long
                </button>
                <button
                  className={`px-2 py-1 rounded font-semibold ${sideFilter === "SHORT" ? "bg-rose-950 text-rose-400" : "text-slate-400"}`}
                  onClick={() => setSideFilter("SHORT")}
                >
                  Short
                </button>
              </div>

              {/* PnL Filter */}
              <div className="flex items-center bg-[#10161F] p-0.5 rounded border border-[#1E2936] text-[11px]">
                <button
                  className={`px-2 py-1 rounded font-semibold ${pnlFilter === "ALL" ? "bg-[#1E2936] text-white" : "text-slate-400"}`}
                  onClick={() => setPnlFilter("ALL")}
                >
                  Все результаты
                </button>
                <button
                  className={`px-2 py-1 rounded font-semibold ${pnlFilter === "WIN" ? "bg-emerald-950 text-emerald-400" : "text-slate-400"}`}
                  onClick={() => setPnlFilter("WIN")}
                >
                  Плюсовые
                </button>
                <button
                  className={`px-2 py-1 rounded font-semibold ${pnlFilter === "LOSS" ? "bg-rose-950 text-rose-400" : "text-slate-400"}`}
                  onClick={() => setPnlFilter("LOSS")}
                >
                  Минусовые
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleExportCsv}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#10161F] border border-[#1E2936] hover:border-slate-600 text-xs font-semibold text-slate-300 transition-all"
                title="Экспорт в CSV"
              >
                <Download size={13} />
                <span>Экспорт CSV</span>
              </button>
            </div>
          </div>

          {/* Table Container */}
          <div className="flex-1 min-h-0 bg-[#10161F] rounded-lg border border-[#1E2936] overflow-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-[#141C26] text-[11px] text-slate-400 font-mono uppercase tracking-wider border-b border-[#1E2936] z-10">
                <tr>
                  <th className="py-2.5 px-3 w-12 text-center">Тип</th>
                  <th className="py-2.5 px-3">Тикер</th>
                  <th className="py-2.5 px-3">Категория</th>
                  <th className="py-2.5 px-3">Причины входа</th>
                  <th className="py-2.5 px-3">Причины выхода</th>
                  <th className="py-2.5 px-3 text-right">Цена открытия</th>
                  <th className="py-2.5 px-3 text-right">Цена закрытия</th>
                  <th className="py-2.5 px-3">Дата открытия</th>
                  <th className="py-2.5 px-3">Дата закрытия</th>
                  <th className="py-2.5 px-3 text-right">Прибыль ($)</th>
                  <th className="py-2.5 px-3 text-right">Комиссия</th>
                  <th className="py-2.5 px-3 text-right">Объём</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E2936]/60 font-mono">
                {paginatedTrades.map((t) => {
                  const isWin = t.realizedPnl > 0;
                  const isLoss = t.realizedPnl < 0;

                  return (
                    <tr
                      key={t.id}
                      className="hover:bg-[#161F2C] transition-colors group cursor-pointer"
                      onClick={() => onOpenChart(t.symbol)}
                      title={`Открыть график ${t.symbol}`}
                    >
                      {/* Type icon: Link to chart + F badge */}
                      <td className="py-2.5 px-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            className="text-slate-500 hover:text-cyan-400 transition-colors p-0.5"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenChart(t.symbol);
                            }}
                            title="Открыть график"
                          >
                            <ExternalLink size={12} />
                          </button>
                          <span className="w-4 h-4 rounded bg-amber-500/20 text-amber-400 font-bold text-[10px] flex items-center justify-center border border-amber-500/40">
                            F
                          </span>
                        </div>
                      </td>

                      {/* Ticker & Side arrow */}
                      <td className="py-2.5 px-3 font-bold text-slate-100">
                        <div className="flex items-center gap-1.5">
                          <span>{t.symbol}</span>
                          {t.side === "LONG" ? (
                            <span className="text-emerald-400 text-xs">↗</span>
                          ) : (
                            <span className="text-rose-400 text-xs">↘</span>
                          )}
                        </div>
                      </td>

                      {/* Category */}
                      <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                        <span className="px-1.5 py-0.5 rounded bg-[#16202C] border border-[#233144]">
                          {t.category || "Скальпинг"}
                        </span>
                      </td>

                      {/* Entry Reason */}
                      <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                        <span className="text-slate-300">
                          {t.entryReason || "—"}
                        </span>
                      </td>

                      {/* Exit Reason */}
                      <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                        <span className="text-slate-300">
                          {t.exitReason || "—"}
                        </span>
                      </td>

                      {/* Open Price */}
                      <td className="py-2.5 px-3 text-right font-semibold text-slate-200">
                        ${t.openPrice < 1 ? t.openPrice.toFixed(6) : t.openPrice.toFixed(4)}
                      </td>

                      {/* Close Price */}
                      <td className="py-2.5 px-3 text-right font-semibold text-slate-200">
                        ${t.closePrice < 1 ? t.closePrice.toFixed(6) : t.closePrice.toFixed(4)}
                      </td>

                      {/* Open Time */}
                      <td className="py-2.5 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                        {formatTradeTime(t.openTime, timezone)}
                      </td>

                      {/* Close Time */}
                      <td className="py-2.5 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                        {formatTradeTime(t.closeTime, timezone)}
                      </td>

                      {/* Realized PnL */}
                      <td className="py-2.5 px-3 text-right font-bold">
                        <span className={`px-2 py-0.5 rounded ${
                          isWin 
                            ? "text-emerald-400 bg-emerald-950/40 border border-emerald-900/60" 
                            : isLoss 
                            ? "text-rose-400 bg-rose-950/40 border border-rose-900/60" 
                            : "text-slate-400"
                        }`}>
                          {t.realizedPnl >= 0 ? "+" : ""}{t.realizedPnl.toFixed(2)} $
                          <small className="ml-1 text-[10px] opacity-80">
                            ({t.pnlPercent >= 0 ? "+" : ""}{t.pnlPercent.toFixed(2)}%)
                          </small>
                        </span>
                      </td>

                      {/* Commission */}
                      <td className="py-2.5 px-3 text-right text-slate-400">
                        ${t.commission.toFixed(3)}
                      </td>

                      {/* Notional / Volume */}
                      <td className="py-2.5 px-3 text-right text-slate-300 font-semibold">
                        ${t.notional.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Table Pagination Footer */}
          <div className="h-10 flex-shrink-0 flex items-center justify-between px-3 mt-2 text-xs font-mono text-slate-400">
            <span>
              Показано <b>{Math.min(filteredTrades.length, (tradePage - 1) * rowsPerPage + 1)} - {Math.min(filteredTrades.length, tradePage * rowsPerPage)}</b> из <b>{filteredTrades.length}</b> сделок
            </span>
            <div className="flex items-center gap-1.5">
              <button
                disabled={tradePage <= 1}
                onClick={() => setTradePage((p) => Math.max(1, p - 1))}
                className="p-1 rounded bg-[#10161F] border border-[#1E2936] disabled:opacity-30 hover:border-slate-500"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-2 font-bold text-white">
                {tradePage} / {totalPages}
              </span>
              <button
                disabled={tradePage >= totalPages}
                onClick={() => setTradePage((p) => Math.min(totalPages, p + 1))}
                className="p-1 rounded bg-[#10161F] border border-[#1E2936] disabled:opacity-30 hover:border-slate-500"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Configuration Modal */}
      {isApiModalOpen && (
        <ApiConfigModal
          config={apiConfig}
          onClose={() => setIsApiModalOpen(false)}
          onSave={(newConfig) => {
            setApiConfig(newConfig);
            saveApiConfig(newConfig);
            setTimezone(newConfig.timezone);
            setIsApiModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

// Interactive SVG Equity Chart Component with smooth gradient area
function EquityChart({ data, unit, color }: { data: { date: string; value: number }[]; unit: string; color: string }) {
  if (!data.length) {
    return <div className="text-slate-500 text-xs font-mono">Нет данных для графика</div>;
  }

  const values = data.map((d) => d.value);
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 0.1);
  const range = maxVal - minVal || 1;

  const width = 600;
  const height = 200;
  const paddingX = 30;
  const paddingY = 20;

  const points = data.map((d, i) => {
    const x = paddingX + (i / (data.length - 1 || 1)) * (width - paddingX * 2);
    const y = height - paddingY - ((d.value - minVal) / range) * (height - paddingY * 2);
    return `${x},${y}`;
  });

  const zeroY = height - paddingY - ((0 - minVal) / range) * (height - paddingY * 2);

  const pathD = `M ${points.join(" L ")}`;
  const areaD = `M ${points[0]} L ${points.join(" L ")} L ${width - paddingX},${zeroY} L ${paddingX},${zeroY} Z`;

  return (
    <div className="w-full h-full relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
        <defs>
          <linearGradient id={`grad-${unit}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.45" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Zero baseline */}
        <line
          x1={paddingX}
          y1={zeroY}
          x2={width - paddingX}
          y2={zeroY}
          stroke="#1E2936"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />

        {/* Shaded Area */}
        <path d={areaD} fill={`url(#grad-${unit})`} />

        {/* Line Curve */}
        <path d={pathD} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />

        {/* Min / Max Labels */}
        <text x={paddingX} y={paddingY - 5} fill="#64748B" fontSize="10" fontFamily="monospace">
          {maxVal.toFixed(2)}{unit}
        </text>
        <text x={paddingX} y={height - 5} fill="#64748B" fontSize="10" fontFamily="monospace">
          {minVal.toFixed(2)}{unit}
        </text>
      </svg>
    </div>
  );
}

// Modal for API Key / Secret Input
function ApiConfigModal({
  config,
  onClose,
  onSave,
}: {
  config: JournalApiConfig;
  onClose: () => void;
  onSave: (c: JournalApiConfig) => void;
}) {
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [apiSecret, setApiSecret] = useState(config.apiSecret);
  const [exchange, setExchange] = useState(config.exchange);
  const [timezone, setTimezone] = useState(config.timezone);
  const [showSecret, setShowSecret] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    if (!apiKey || !apiSecret) {
      setTestResult("Пожалуйста, заполните API Key и Secret");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      await syncBinanceTrades(apiKey, apiSecret);
      setTestResult("✓ Соединение успешно! Ключи проверены.");
    } catch (e: any) {
      setTestResult(`Ошибка: ${e.message || "Неверный ключ или запрещён IP"}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-[#10161F] border border-[#1E2936] rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-[#1E2936]">
          <div className="flex items-center gap-2">
            <Key className="text-cyan-400" size={18} />
            <h3 className="font-bold text-base text-white">Подключение Tiger.Trade / Binance API</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label className="block text-slate-400 font-semibold mb-1">Биржа / Брокер</label>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value as any)}
              className="w-full bg-[#141C26] border border-[#1E2936] rounded px-3 py-2 text-white font-mono outline-none"
            >
              <option value="binance">Binance Futures (USDⓈ-M) через Tiger.Trade</option>
              <option value="tiger">Tiger.Trade Broker API</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-400 font-semibold mb-1">API Key (Read-Only)</label>
            <input
              type="text"
              placeholder="Вставьте ваш API Key..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full bg-[#141C26] border border-[#1E2936] rounded px-3 py-2 text-white font-mono outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-slate-400 font-semibold mb-1">API Secret</label>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                placeholder="Вставьте ваш API Secret..."
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                className="w-full bg-[#141C26] border border-[#1E2936] rounded px-3 py-2 text-white font-mono outline-none focus:border-cyan-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-slate-400 font-semibold mb-1">Часовой пояс</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full bg-[#141C26] border border-[#1E2936] rounded px-3 py-2 text-white font-mono outline-none"
            >
              <option value="GMT+10 (Vladivostok)">GMT+10 (Vladivostok)</option>
              <option value="GMT+3 (Moscow)">GMT+3 (Moscow)</option>
              <option value="GMT+2 (Kaliningrad)">GMT+2 (Kaliningrad)</option>
              <option value="UTC">UTC</option>
            </select>
          </div>

          <div className="p-3 rounded bg-[#141C26] border border-cyan-900/40 text-[11px] text-cyan-200 flex items-start gap-2">
            <ShieldCheck size={16} className="text-cyan-400 flex-shrink-0 mt-0.5" />
            <span>
              <b>Безопасность:</b> Создавайте ключ только с правами <b>«Чтение» (Read-Only)</b>. Ваши ключи хранятся локально в браузере (localStorage) и не покидают ваше устройство.
            </span>
          </div>

          {testResult && (
            <div className={`p-2.5 rounded font-mono text-[11px] ${
              testResult.includes("✓") ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800" : "bg-rose-950/60 text-rose-300 border border-rose-800"
            }`}>
              {testResult}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[#1E2936]">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing}
            className="px-3 py-1.5 rounded bg-[#141C26] border border-[#1E2936] text-xs font-semibold text-slate-300 hover:text-white"
          >
            {testing ? "Проверка..." : "Проверить связь"}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded text-xs text-slate-400 hover:text-slate-200"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => onSave({ ...config, apiKey, apiSecret, exchange, timezone })}
              className="px-4 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 font-bold text-xs text-black"
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
