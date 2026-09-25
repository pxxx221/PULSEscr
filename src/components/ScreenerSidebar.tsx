import React from "react";
import { Search, ChevronDown, Star, Flame, ArrowUpDown, TrendingUpDown, Zap, SlidersHorizontal, Send, Sparkles, Loader2, CheckCircle2, AlertCircle, GitBranch } from "lucide-react";
import { TickerData, SortMode, GravityShieldData } from "../types";
import TelegramTestButton from "./TelegramTestButton";
import { filterHotVolatileAltTickers } from "../utils/liquidityScanner";
import { BookWall } from "../services/orderBookWalls";
import { sendTelegramChochTestAlert } from "../services/telegramService";

// Domino Score Clustering algorithm for finding swing highs/lows stop chains
const calculateDominoScore = (pools: { price: number; type: "BSL" | "SSL" }[]): { score: number; type: "BSL" | "SSL" } | null => {
  if (!pools || pools.length < 3) return null;

  const bslPrices = pools.filter(p => p.type === "BSL").map(p => p.price).sort((a, b) => a - b);
  const sslPrices = pools.filter(p => p.type === "SSL").map(p => p.price).sort((a, b) => b - a);

  const evaluateCascade = (prices: number[]): number => {
    if (prices.length < 3) return 0;

    let bestScore = 0;
    let currentCluster: number[] = [prices[0]];
    const clusters: number[][] = [];

    for (let i = 1; i < prices.length; i++) {
      const p1 = prices[i - 1];
      const p2 = prices[i];
      const gapPct = Math.abs(p2 - p1) / Math.min(p1, p2);
      if (gapPct <= 0.001) { // 0.1% threshold for adjacent levels
        currentCluster.push(p2);
      } else {
        if (currentCluster.length >= 3) {
          clusters.push(currentCluster);
        }
        currentCluster = [p2];
      }
    }
    if (currentCluster.length >= 3) {
      clusters.push(currentCluster);
    }

    if (clusters.length === 0) return 0;

    clusters.forEach(cluster => {
      const count = cluster.length;
      let sumGap = 0;
      for (let i = 1; i < cluster.length; i++) {
        sumGap += Math.abs(cluster[i] - cluster[i-1]) / Math.min(cluster[i], cluster[i-1]);
      }
      const avgGap = sumGap / (count - 1);

      // Domino Score scaling logic based on requirements
      let baseScore = 50;
      if (count === 4) baseScore = 75;
      else if (count >= 5) baseScore = 92;

      // Tightness multiplier bonus
      const gapRatio = avgGap / 0.001;
      const tightnessBonus = (1 - gapRatio) * 15; // Up to +15% boost

      const finalScore = Math.min(100, Math.max(0, Math.round(baseScore + tightnessBonus)));
      if (finalScore > bestScore) {
        bestScore = finalScore;
      }
    });

    return bestScore;
  };

  const bslScore = evaluateCascade(bslPrices);
  const sslScore = evaluateCascade(sslPrices);

  const maxScore = Math.max(bslScore, sslScore);
  if (maxScore === 0) return null;

  return {
    score: maxScore,
    type: bslScore >= sslScore ? "BSL" : "SSL",
  };
};

interface ScreenerSidebarProps {
  markets: Record<string, TickerData>;
  currentCoin: string;
  selectCoin: (coin: string) => void;
  favorites: string[];
  toggleFav: (coin: string) => void;
  currentSort: SortMode;
  setSortMode: (mode: SortMode) => void;
  minVolume: number;
  setMinVolume: (vol: number) => void;
  squeezeSensitivity: number;
  setSqueezeSensitivity: (val: number) => void;
  alertThreshold: number;
  setAlertThreshold: (val: number) => void;
  radarOn: boolean;
  setRadarOn: (on: boolean) => void;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  pushedSymbols: Record<string, { type: "LONG" | "SHORT"; timestamp: number }>;
  activeCoinPools?: { price: number; type: "BSL" | "SSL" }[];
  gravityShieldSymbols?: Record<string, GravityShieldData>;
  bookWalls?: Record<string, BookWall[]>;
}

export default function ScreenerSidebar({
  markets,
  currentCoin,
  selectCoin,
  favorites,
  toggleFav,
  currentSort,
  setSortMode,
  minVolume,
  setMinVolume,
  squeezeSensitivity,
  setSqueezeSensitivity,
  alertThreshold,
  setAlertThreshold,
  radarOn,
  setRadarOn,
  searchQuery,
  setSearchQuery,
  pushedSymbols,
  activeCoinPools = [],
  gravityShieldSymbols = {},
  bookWalls = {},
}: ScreenerSidebarProps) {
  const [showSettings, setShowSettings] = React.useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("screener_show_settings");
      return saved === "true"; // default to false/collapsed for maximum space
    } catch (e) {
      return false;
    }
  });

  const [hotAltsOnly, setHotAltsOnly] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem("screener_hot_alts_only") === "true";
    } catch {
      return false;
    }
  });

  const [chochTestStatus, setChochTestStatus] = React.useState<"idle" | "loading" | "success" | "error">("idle");
  const [chochTestError, setChochTestError] = React.useState<string>("");

  React.useEffect(() => {
    try {
      localStorage.setItem("screener_show_settings", String(showSettings));
    } catch (e) {}
  }, [showSettings]);

  React.useEffect(() => {
    try {
      localStorage.setItem("screener_hot_alts_only", String(hotAltsOnly));
    } catch (e) {}
  }, [hotAltsOnly]);

  React.useEffect(() => { const open=()=>setShowSettings(s=>!s); window.addEventListener('pulse-settings',open); return ()=>window.removeEventListener('pulse-settings',open); }, []);
  const marketKeys = Object.keys(markets);

  // Hot Volatile Altcoins filter candidate set (>= $100M, |Change| >= 4.5%, no synthetics/BTC/ETH)
  const hotAltCandidates = React.useMemo(() => {
    return filterHotVolatileAltTickers(Object.values(markets));
  }, [markets]);

  const hotAltSymbolsSet = React.useMemo(() => {
    return new Set(hotAltCandidates.map((c) => c.symbol));
  }, [hotAltCandidates]);

  const handleTestChochAlert = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (chochTestStatus === "loading") return;

    setChochTestStatus("loading");
    setChochTestError("");
    try {
      const res = await sendTelegramChochTestAlert();
      if (res.success) {
        setChochTestStatus("success");
        setTimeout(() => setChochTestStatus("idle"), 4000);
      } else {
        setChochTestStatus("error");
        setChochTestError(res.error || "Ошибка отправки");
        setTimeout(() => setChochTestStatus("idle"), 5000);
      }
    } catch (err: any) {
      setChochTestStatus("error");
      setChochTestError(err.message || "Сбой соединения");
      setTimeout(() => setChochTestStatus("idle"), 5000);
    }
  };

  // Filter keys
  const filteredKeys = marketKeys.filter((key) => {
    const info = markets[key];
    if (!info) return false;
    const cleanKey = key.toUpperCase().replace("/USDT", "");
    const cleanSearch = searchQuery.trim().toUpperCase().replace("/USDT", "");
    const matchesSearch = !cleanSearch || cleanKey.includes(cleanSearch) || key.toUpperCase().includes(cleanSearch);
    const volM = info.volume / 1_000_000;
    
    // If Hot Alts Only filter is toggled
    if (hotAltsOnly && !hotAltSymbolsSet.has(key)) {
      return false;
    }

    // Volume threshold logic: if searching specifically or in Hot Alts mode, don't clip by slider
    const matchesVolume = cleanSearch || hotAltsOnly ? true : volM >= minVolume;

    return matchesSearch && matchesVolume;
  });

  // Sort keys
  const sortedKeys = [...filteredKeys].sort((a, b) => {
    const infoA = markets[a];
    const infoB = markets[b];

    if (currentSort === "A-Z") {
      return a.localeCompare(b);
    } else if (currentSort === "%") {
      return Math.abs(infoB.change) - Math.abs(infoA.change); // sort by highest absolute percent change
    } else if (currentSort === "$") {
      return infoB.volume - infoA.volume; // sort by top volume
    }
    return 0;
  });

  // Extract Favorites vs Standard roster list
  const favoritedKeys = sortedKeys.filter((key) => favorites.includes(key));
  const standardKeys = sortedKeys.filter((key) => !favorites.includes(key)).slice(0, searchQuery ? 120 : 45); // expand during active search


  const getSqueezeClass = (info: TickerData) => {
    const volM = info.volume / 1_000_000;
    const isSqueeze = volM >= 150.0 && Math.abs(info.change) >= squeezeSensitivity * 4.0;
    return isSqueeze;
  };

  const renderContractRow = (key: string, isFavSection: boolean) => {
    const info = markets[key];
    if (!info) return null;

    const isActive = key === currentCoin;
    const volM = info.volume / 1_000_000;
    const isSqueezePotential = getSqueezeClass(info);

    const formattedVol = volM >= 1000 ? `${(volM / 1000).toFixed(1)}B` : `${volM.toFixed(1)}M`;
    const formattedPrice = info.price >= 1 ? info.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : info.price.toFixed(6);

    const isFav = favorites.includes(key);
    const nearestWall = (bookWalls[key] || []).slice().sort((a, b) => a.distancePercent - b.distancePercent)[0];

    const domino = isActive 
      ? calculateDominoScore(activeCoinPools)
      : null;

    const gravityShield = gravityShieldSymbols[key];

    return (
      <div key={key} className={'pulse-market-row '+(isActive?'is-selected':'')}>
        <button className={'pulse-favorite '+(isFav?'is-favorite':'')} aria-label={'Favorite '+key} onClick={()=>toggleFav(key)}><Star size={12}/></button>
        <button className="pulse-market-select" onClick={()=>selectCoin(key)} aria-pressed={isActive}>
          <span className="pulse-market-symbol">{key.split('/')[0]} {hotAltSymbolsSet.has(key) && <Flame size={11} className="pulse-hot-icon"/>}{nearestWall && <span className="pulse-level-indicator" style={{ color: nearestWall.status === 'confirmed' ? (nearestWall.side === 'bid' ? '#32B79A' : '#E66A78') : '#8A9BAF' }} title={`${nearestWall.status === 'confirmed' ? 'Устойчивая' : 'Наблюдается'} · ${nearestWall.side === 'bid' ? 'Покупка' : 'Продажа'} · $${nearestWall.price} · $${Math.round(nearestWall.notional).toLocaleString('en-US')} · держится ${nearestWall.ageSeconds} с`}>{nearestWall.status === 'confirmed' ? '▰' : '◇'} <small>{nearestWall.side === 'bid' ? 'BID' : 'ASK'}</small></span>}{pushedSymbols[key] && <i className={pushedSymbols[key].type==='LONG'?'positive-dot':'negative-dot'}/>}</span>
          <span className={info.change>=0?'positive':'negative'}>{info.change>=0?'+':''}{info.change.toFixed(2)}%</span>
          <span className="pulse-row-price">{'$'}{formattedPrice}</span><span className="pulse-row-volume">{'$'}{formattedVol}</span>
        </button>
      </div>
    );
  };
  return <div className="pulse-sidebar">
    <div className="pulse-sidebar-top"><div className="pulse-sidebar-title"><h2>Markets <small>{marketKeys.length}</small></h2><button onClick={()=>setShowSettings(!showSettings)} title="Показать / скрыть настройки сканера" aria-expanded={showSettings}><SlidersHorizontal size={14}/> Filters</button></div>
    <div className="pulse-sidebar-search"><Search size={14}/><input aria-label="Filter markets" placeholder="Search ticker..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value.toUpperCase())}/></div>
    <div className="pulse-market-tabs"><button className={!hotAltsOnly?'active':''} onClick={()=>setHotAltsOnly(false)}>All futures</button><button id="hot-alts-filter-toggle" className={hotAltsOnly?'active':''} onClick={()=>setHotAltsOnly(!hotAltsOnly)} title="Объем ≥$100M, изменение ≥4.5%"><Flame size={12}/> Hot <small>{hotAltCandidates.length}</small></button></div>
    <div className="pulse-filter-settings">        {showSettings && (
          <div className="bg-[#0B0E14]/80 border border-slate-800/80 rounded-lg p-3 flex flex-col gap-3.5 mb-3.5 animate-in fade-in slide-in-from-top-2 duration-150">
            {/* 24h volume selectivity */}
            <div>
              <div className="flex justify-between items-center text-[10px] mb-1">
                <span className="text-slate-400 font-semibold">Мин. объем за 24 ч</span>
                <span className="text-cyan-400 font-mono font-bold">${minVolume}M+</span>
              </div>
              <input
                type="range"
                min="0"
                max="1000"
                step="10"
                value={minVolume}
                onChange={(e) => setMinVolume(Number(e.target.value))}
                className="w-full h-1 bg-slate-950 rounded appearance-none cursor-pointer accent-cyan-500"
              />
              <div className="flex justify-between text-[8px] text-slate-500 font-mono mt-1">
                <span>$0M</span>
                <span>$500M</span>
                <span>$1000M</span>
              </div>
            </div>

            {/* Predictor Squeeze Sensitivity */}
            <div>
              <div className="flex justify-between items-center text-[10px] mb-1">
                <span className="text-slate-400 font-semibold">Отклонение для сквиза</span>
                <span className="text-purple-400 font-mono font-bold">{squeezeSensitivity.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min="1.0"
                max="5.0"
                step="0.1"
                value={squeezeSensitivity}
                onChange={(e) => setSqueezeSensitivity(Number(e.target.value))}
                className="w-full h-1 bg-slate-950 rounded appearance-none cursor-pointer accent-purple-500"
              />
            </div>

            {/* Live scanner config */}
            <div className="border-t border-slate-800/60 pt-2.5">
              <div className="flex items-center justify-between text-[10px] mb-2">
                <span className="text-slate-400 font-semibold">Живой радар импульсов</span>
                <button
                  onClick={() => setRadarOn(!radarOn)}
                  className={`text-[9px] cursor-pointer px-1.5 py-0.5 rounded border transition-all ${
                    radarOn
                      ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-400 font-bold"
                      : "bg-slate-800 border-slate-700 text-slate-400 font-medium"
                  }`}
                >
                  {radarOn ? "📡 ВКЛ" : "ВЫКЛ"}
                </button>
              </div>

              <div className="flex justify-between items-center text-[10px] mb-1">
                <span className="text-slate-400 font-semibold">Отклонение алерта %</span>
                <span className="text-cyan-455 text-cyan-400 font-mono font-bold">{alertThreshold.toFixed(1)}%</span>
              </div>
              <input
                type="range"
                min="1.0"
                max="9.0"
                step="0.1"
                value={alertThreshold}
                disabled={!radarOn}
                onChange={(e) => setAlertThreshold(Number(e.target.value))}
                className={`w-full h-1 bg-slate-950 rounded appearance-none cursor-pointer accent-cyan-400 ${!radarOn ? "opacity-30" : ""}`}
              />
            </div>

            {/* Telegram Bot Alerts Info & Test */}
            <div className="border-t border-slate-800/60 pt-2.5 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-slate-400 font-semibold flex items-center gap-1">
                  <span>📱 Telegram Бот</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                </span>
                <TelegramTestButton variant="compact" />
              </div>
              <div className="text-[9px] text-slate-500 font-mono">
                Chat ID: 395934082 • Импульс (≥3%) + CHoCH (5m)
              </div>

              {/* CHoCH Market Structure Shift Card in Settings */}
              <div className="bg-emerald-950/25 border border-emerald-500/30 rounded p-2 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-emerald-300 flex items-center gap-1">
                    <GitBranch className="h-3 w-3 text-emerald-400" />
                    <span>🔄 СЛОМЫ СТРУКТУРЫ (CHoCH 5m)</span>
                  </span>
                  <button
                    onClick={handleTestChochAlert}
                    disabled={chochTestStatus === "loading"}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold flex items-center gap-1 border transition-all cursor-pointer ${
                      chochTestStatus === "loading"
                        ? "bg-slate-800 text-slate-400 border-slate-700"
                        : chochTestStatus === "success"
                        ? "bg-emerald-950 border-emerald-500 text-emerald-300"
                        : chochTestStatus === "error"
                        ? "bg-rose-950 border-rose-500 text-rose-300"
                        : "bg-emerald-950/80 hover:bg-emerald-900 border-emerald-500/50 text-emerald-200"
                    }`}
                    title={chochTestError || "Отправить проверочный алерт СЛОМ СТРУКТУРЫ в Telegram"}
                  >
                    {chochTestStatus === "loading" ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin text-emerald-400" />
                    ) : chochTestStatus === "success" ? (
                      <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400" />
                    ) : chochTestStatus === "error" ? (
                      <AlertCircle className="h-2.5 w-2.5 text-rose-400" />
                    ) : (
                      <Send className="h-2.5 w-2.5 text-emerald-400" />
                    )}
                    <span>{chochTestStatus === "loading" ? "..." : chochTestStatus === "success" ? "OK" : chochTestStatus === "error" ? "ERR" : "Тест TG"}</span>
                  </button>
                </div>
                <div className="text-[8.5px] text-emerald-200/70 font-mono leading-tight">
                  5m таймфрейм • Подтверждение закрытием телом свечи (без сбора ликвидности тенями) • Cooldown 5 мин • Импульсы в TG только от 3.0%
                </div>
              </div>
            </div>
          </div>
        )}
</div>
    <div className="pulse-sort">{(['A-Z','%','$'] as SortMode[]).map(mode=><button key={mode} className={currentSort===mode?'active':''} onClick={()=>setSortMode(mode)}>{mode==='A-Z'?'Ticker':mode==='%'?'Change %':'Volume'}{currentSort===mode && <ChevronDown size={12}/>}</button>)}</div>
    <div className="pulse-columns"><span>SYMBOL / PRICE</span><span>24H % / VOLUME</span></div></div>
    <div className="pulse-market-list custom-scrollbar">{!searchQuery && markets[currentCoin] && !favoritedKeys.includes(currentCoin) && !standardKeys.includes(currentCoin) && <><div className="pulse-list-label">SELECTED MARKET</div>{renderContractRow(currentCoin,false)}<div className="pulse-list-label">ALL MARKETS</div></>}{favoritedKeys.length>0 && <><div className="pulse-list-label">WATCHLIST</div>{favoritedKeys.map(k=>renderContractRow(k,true))}<div className="pulse-list-label">ALL MARKETS</div></>}{standardKeys.map(k=>renderContractRow(k,false))}{!sortedKeys.length && <div className="pulse-empty">No matching markets</div>}</div>
    <div className="pulse-sidebar-bottom"><span>{sortedKeys.length} matching markets</span><span>USDT</span></div>
  </div>;
}
