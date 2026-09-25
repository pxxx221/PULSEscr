import React, { useState, useMemo } from "react";
import { BookWall, TickerData } from "../types";
import { 
  Layers, 
  Search, 
  Zap, 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  ArrowUpDown, 
  ExternalLink, 
  SlidersHorizontal,
  ShieldCheck,
  Shield,
  Eye,
  Flame,
  CheckCircle2,
  RefreshCw,
  Timer
} from "lucide-react";
import { convertRuToEnLayout } from "../utils/keyboardTranslit";

interface DensityMapTabProps {
  bookWalls: Record<string, BookWall[]>;
  markets: Record<string, TickerData>;
  currentCoin: string;
  onSelectCoin: (symbol: string) => void;
  onOpenChart: (symbol: string) => void;
}

type SortField = "notional" | "distance" | "age" | "price";
type SortDirection = "asc" | "desc";

export default function DensityMapTab({
  bookWalls,
  markets,
  currentCoin,
  onSelectCoin,
  onOpenChart,
}: DensityMapTabProps) {
  const [search, setSearch] = useState("");
  const [sideFilter, setSideFilter] = useState<"ALL" | "bid" | "ask">("ALL");
  const [distanceFilter, setDistanceFilter] = useState<number>(2.5); // max distance %
  const [minNotionalFilter, setMinNotionalFilter] = useState<number>(25); // in thousands ($25K default for alts)
  const [minAgeFilter, setMinAgeFilter] = useState<number>(60); // Default to >= 60s (от 1 минуты!)
  const [sortField, setSortField] = useState<SortField>("notional");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Flatten all walls across monitored symbols
  const allWallsList = useMemo(() => {
    const list: Array<BookWall & { currentPrice: number; change24h: number }> = [];
    for (const [symbol, walls] of Object.entries(bookWalls)) {
      const market = markets[symbol];
      const currentPrice = market?.price || 0;
      const change24h = market?.change || 0;
      for (const wall of walls) {
        list.push({
          ...wall,
          currentPrice,
          change24h,
        });
      }
    }
    return list;
  }, [bookWalls, markets]);

  // Aggregate stats
  const stats = useMemo(() => {
    let totalNotional = 0;
    let bidNotional = 0;
    let askNotional = 0;
    let bidCount = 0;
    let askCount = 0;
    let nearCount = 0; // distance <= 0.4%
    let stableCount = 0; // age >= 60s
    let solidCount = 0; // age >= 180s

    for (const w of allWallsList) {
      totalNotional += w.notional;
      if (w.side === "bid") {
        bidNotional += w.notional;
        bidCount++;
      } else {
        askNotional += w.notional;
        askCount++;
      }
      if (w.distancePercent <= 0.4) {
        nearCount++;
      }
      if (w.ageSeconds >= 60) {
        stableCount++;
      }
      if (w.ageSeconds >= 180) {
        solidCount++;
      }
    }

    return {
      totalCount: allWallsList.length,
      symbolsCount: new Set(allWallsList.map(w => w.symbol)).size,
      totalNotional,
      bidNotional,
      askNotional,
      bidCount,
      askCount,
      nearCount,
      stableCount,
      solidCount,
    };
  }, [allWallsList]);

  // Filtered and sorted walls
  const filteredWalls = useMemo(() => {
    const query = convertRuToEnLayout(search).trim().toUpperCase();

    return allWallsList
      .filter((w) => {
        // Search filter
        if (query && !w.symbol.toUpperCase().includes(query)) return false;

        // Side filter
        if (sideFilter !== "ALL" && w.side !== sideFilter) return false;

        // Distance filter
        if (w.distancePercent > distanceFilter) return false;

        // Min notional filter (in thousands)
        if (w.notional < minNotionalFilter * 1000) return false;

        // Min age filter (filtration against spoofing / jumping orders)
        if (w.ageSeconds < minAgeFilter) return false;

        return true;
      })
      .sort((a, b) => {
        let comp = 0;
        if (sortField === "notional") {
          comp = a.notional - b.notional;
        } else if (sortField === "distance") {
          comp = a.distancePercent - b.distancePercent;
        } else if (sortField === "age") {
          comp = a.ageSeconds - b.ageSeconds;
        } else if (sortField === "price") {
          comp = a.price - b.price;
        }
        return sortDirection === "desc" ? -comp : comp;
      });
  }, [allWallsList, search, sideFilter, distanceFilter, minNotionalFilter, minAgeFilter, sortField, sortDirection]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const formatNotional = (val: number) => {
    if (val >= 1_000_000) {
      return `$${(val / 1_000_000).toFixed(2)}M`;
    }
    return `$${Math.round(val / 1_000)}K`;
  };

  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return p.toFixed(6);
  };

  const formatAge = (seconds: number) => {
    if (seconds < 60) return `${seconds}с`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}м ${s < 10 ? '0' : ''}${s}с`;
  };

  return (
    <div className="density-map-container">
      {/* Top Banner & Key Metrics */}
      <div className="density-map-header">
        <div className="density-header-left">
          <div className="density-title-row">
            <div className="density-badge-icon">
              <Layers size={18} className="text-cyan-400" />
            </div>
            <div>
              <h1 className="density-title">Карта плотностей стакана (Real-Time)</h1>
              <p className="density-subtitle">
                Крупные неподвижные заявки институционалов с фильтрацией спуфинга и мигающих ордеров
              </p>
            </div>
          </div>
        </div>

        {/* Global Summary Cards */}
        <div className="density-stats-grid">
          <div className="density-stat-card border-cyan-900/40 bg-cyan-950/20">
            <span className="stat-label text-cyan-300 flex items-center gap-1">
              <Timer size={12} className="text-cyan-400" /> Настоящие (&ge;1 мин)
            </span>
            <span className="stat-value text-cyan-300">
              {stats.stableCount} <small className="text-xs text-slate-400">из {stats.totalCount}</small>
            </span>
            <span className="stat-sub text-cyan-400/80">Не двигаются &ge;60 сек</span>
          </div>

          <div className="density-stat-card border-emerald-900/40 bg-emerald-950/20">
            <span className="stat-label text-emerald-400">Покупки (BID)</span>
            <span className="stat-value text-emerald-400">
              {stats.bidCount} <small className="text-xs opacity-75">плотностей</small>
            </span>
            <span className="stat-sub text-emerald-300/80">{formatNotional(stats.bidNotional)} объём</span>
          </div>

          <div className="density-stat-card border-rose-900/40 bg-rose-950/20">
            <span className="stat-label text-rose-400">Продажи (ASK)</span>
            <span className="stat-value text-rose-400">
              {stats.askCount} <small className="text-xs opacity-75">плотностей</small>
            </span>
            <span className="stat-sub text-rose-300/80">{formatNotional(stats.askNotional)} объём</span>
          </div>

          <div className="density-stat-card border-amber-900/40 bg-amber-950/20">
            <span className="stat-label text-amber-300 flex items-center gap-1">
              <Zap size={12} className="text-amber-400" /> Поджатие (&le;0.4%)
            </span>
            <span className="stat-value text-amber-400">{stats.nearCount}</span>
            <span className="stat-sub text-amber-300/80">Готовы к разбору/пробою</span>
          </div>
        </div>
      </div>

      {/* Filter and Control Toolbar */}
      <div className="density-toolbar">
        {/* Search */}
        <div className="density-search-box">
          <Search size={14} className="text-slate-400" />
          <input
            type="text"
            placeholder="Поиск монеты (напр. SOL, BTC, PEPE)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="text-slate-500 hover:text-slate-300 text-xs" onClick={() => setSearch("")}>
              ✕
            </button>
          )}
        </div>

        {/* PRIMARY FILTER: Lifetime / Anti-Spoofing */}
        <div className="density-filter-group">
          <span className="density-filter-label flex items-center gap-1 text-cyan-300 font-bold">
            <Timer size={13} /> Время удержания:
          </span>
          <div className="density-pill-selector">
            <button
              className={minAgeFilter === 60 ? "active text-cyan-300 font-bold" : ""}
              onClick={() => setMinAgeFilter(60)}
              title="Показать только заявки, которые стоят на месте более 1 минуты (без спуфинга)"
            >
              ⏱️ От 1 мин (Рекомендуется)
            </button>
            <button
              className={minAgeFilter === 180 ? "active text-amber-300 font-bold" : ""}
              onClick={() => setMinAgeFilter(180)}
              title="Железобетонные плотности: стоят более 3 минут"
            >
              🛡️ От 3 мин
            </button>
            <button
              className={minAgeFilter === 300 ? "active text-yellow-300 font-bold" : ""}
              onClick={() => setMinAgeFilter(300)}
              title="Монолитные заявки: стоят более 5 минут"
            >
              🏛️ От 5 мин
            </button>
            <button
              className={minAgeFilter === 0 ? "active" : ""}
              onClick={() => setMinAgeFilter(0)}
              title="Показать все заявки, включая только что выставленные"
            >
              Все (от 0с)
            </button>
          </div>
        </div>

        {/* Side filter pills */}
        <div className="density-filter-group">
          <span className="density-filter-label">Сторона:</span>
          <div className="density-pill-selector">
            <button
              className={sideFilter === "ALL" ? "active" : ""}
              onClick={() => setSideFilter("ALL")}
            >
              Все
            </button>
            <button
              className={sideFilter === "bid" ? "active text-emerald-400" : ""}
              onClick={() => setSideFilter("bid")}
            >
              🟢 BID
            </button>
            <button
              className={sideFilter === "ask" ? "active text-rose-400" : ""}
              onClick={() => setSideFilter("ask")}
            >
              🔴 ASK
            </button>
          </div>
        </div>

        {/* Distance filter */}
        <div className="density-filter-group">
          <span className="density-filter-label">Дистанция:</span>
          <select
            className="density-select"
            value={distanceFilter}
            onChange={(e) => setDistanceFilter(Number(e.target.value))}
          >
            <option value={0.5}>⚡ До 0.5% (Поджатие)</option>
            <option value={1.0}>До 1.0%</option>
            <option value={2.5}>До 2.5% (Все)</option>
          </select>
        </div>

        {/* Min Notional filter */}
        <div className="density-filter-group">
          <span className="density-filter-label">Мин. объем:</span>
          <select
            className="density-select"
            value={minNotionalFilter}
            onChange={(e) => setMinNotionalFilter(Number(e.target.value))}
          >
            <option value={25}>$25K+ (Для всех альтов)</option>
            <option value={50}>$50K+</option>
            <option value={100}>$100K+</option>
            <option value={250}>$250K+</option>
            <option value={500}>$500K+</option>
            <option value={1000}>$1M+ (Крупные киты)</option>
          </select>
        </div>
      </div>

      {/* Main Table Content */}
      <div className="density-table-wrap">
        {filteredWalls.length === 0 ? (
          <div className="density-empty-state">
            <Eye size={36} className="text-slate-600 mb-2" />
            <p className="text-sm font-semibold text-slate-300">
              {minAgeFilter > 0 
                ? "Заявки с удержанием от 1 минуты пока накапливают время"
                : "Плотности по выбранным фильтрам не найдены"}
            </p>
            <p className="text-xs text-slate-500 max-w-md text-center mt-1">
              {minAgeFilter > 0 
                ? "Стенки отслеживаются в реальном времени. Если крупный ордер стоит неподвижно, он появится здесь ровно через 60 секунд. Вы также можете переключить на «Все (от 0с)»."
                : "Попробуйте снизить минимальный объём ($25K-$50K) или увеличить дистанцию."}
            </p>
          </div>
        ) : (
          <table className="density-table">
            <thead>
              <tr>
                <th className="text-left">Монета</th>
                <th className="text-center">Сторона</th>
                <th className="text-right cursor-pointer" onClick={() => toggleSort("price")}>
                  <div className="flex items-center justify-end gap-1">
                    Точная цена заявки {sortField === "price" && <ArrowUpDown size={12} />}
                  </div>
                </th>
                <th className="text-right">Текущая цена</th>
                <th className="text-right cursor-pointer" onClick={() => toggleSort("distance")}>
                  <div className="flex items-center justify-end gap-1">
                    Дистанция {sortField === "distance" && <ArrowUpDown size={12} />}
                  </div>
                </th>
                <th className="text-right cursor-pointer" onClick={() => toggleSort("notional")}>
                  <div className="flex items-center justify-end gap-1">
                    Объём заявки ($) {sortField === "notional" && <ArrowUpDown size={12} />}
                  </div>
                </th>
                <th className="text-center cursor-pointer" onClick={() => toggleSort("age")}>
                  <div className="flex items-center justify-center gap-1">
                    Время на месте {sortField === "age" && <ArrowUpDown size={12} />}
                  </div>
                </th>
                <th className="text-center">Надежность (Anti-Spoof)</th>
                <th className="text-center">График</th>
              </tr>
            </thead>
            <tbody>
              {filteredWalls.map((wall, index) => {
                const isBid = wall.side === "bid";
                const isSelected = wall.symbol === currentCoin;
                const isNear = wall.distancePercent <= 0.4;
                const isSolid = wall.status === "solid" || wall.ageSeconds >= 180;
                const isConfirmed = wall.status === "confirmed" || wall.ageSeconds >= 60;

                return (
                  <tr
                    key={`${wall.symbol}-${wall.side}-${wall.price}-${index}`}
                    className={`density-row ${isSelected ? "is-selected-coin" : ""} ${isNear ? "is-near-breakout" : ""}`}
                    onClick={() => onSelectCoin(wall.symbol)}
                  >
                    {/* Coin Symbol */}
                    <td className="font-semibold text-slate-200">
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-bold tracking-wide">
                          {wall.symbol.split("/")[0]}
                        </span>
                        <span className="text-xs text-slate-500 font-mono">/USDT</span>
                        {wall.change24h !== 0 && (
                          <span className={`text-[11px] font-mono ${wall.change24h >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {wall.change24h >= 0 ? "+" : ""}{wall.change24h.toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Side */}
                    <td className="text-center">
                      <span className={`density-side-badge ${isBid ? "is-bid" : "is-ask"}`}>
                        {isBid ? "🟢 BID (ПОКУПКА)" : "🔴 ASK (ПРОДАЖА)"}
                      </span>
                    </td>

                    {/* Exact Wall Price */}
                    <td className="text-right font-mono font-bold text-sm text-cyan-300">
                      ${formatPrice(wall.price)}
                    </td>

                    {/* Current Market Price */}
                    <td className="text-right font-mono text-xs text-slate-400">
                      ${formatPrice(wall.currentPrice)}
                    </td>

                    {/* Distance from price */}
                    <td className="text-right font-mono">
                      <div className="flex items-center justify-end gap-1.5">
                        {isNear && (
                          <span className="density-near-tag" title="Цена вплотную подошла к плотности! Идеально для входа в разбор или отскок">
                            ⚡ Поджатие
                          </span>
                        )}
                        <span className={`text-xs font-semibold ${isNear ? "text-amber-400 font-bold" : "text-slate-300"}`}>
                          {wall.distancePercent.toFixed(2)}%
                        </span>
                      </div>
                    </td>

                    {/* Notional (Volume in USD) */}
                    <td className="text-right font-mono font-bold">
                      <div className="flex flex-col items-end">
                        <span className={`text-sm ${wall.notional >= 500_000 ? "text-yellow-300" : "text-slate-100"}`}>
                          {formatNotional(wall.notional)}
                        </span>
                        {wall.relativeSize > 1 && (
                          <span className="text-[10px] text-slate-500">
                            в {wall.relativeSize.toFixed(0)}x выше средней
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Age / Holding duration */}
                    <td className="text-center font-mono">
                      <div className="inline-flex items-center gap-1.5">
                        {isSolid ? (
                          <span className="text-amber-400 font-bold text-xs flex items-center gap-1">
                            <Shield size={12} /> {formatAge(wall.ageSeconds)}
                          </span>
                        ) : isConfirmed ? (
                          <span className="text-cyan-400 font-bold text-xs flex items-center gap-1">
                            <Clock size={12} /> {formatAge(wall.ageSeconds)}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs flex items-center gap-1">
                            <Clock size={11} /> {formatAge(wall.ageSeconds)}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Status */}
                    <td className="text-center">
                      {isSolid ? (
                        <span className="density-status-solid" title="Заявка стоит неподвижно более 3 минут! Настоящая крупная позиция">
                          <ShieldCheck size={12} /> 🛡️ ЖЕЛЕЗОБЕТОН (3м+)
                        </span>
                      ) : isConfirmed ? (
                        <span className="density-status-confirmed" title="Заявка стоит на месте более 1 минуты. Не спуфинг">
                          <CheckCircle2 size={12} /> ⏱️ НАСТОЯЩАЯ (1м+)
                        </span>
                      ) : (
                        <span className="density-status-observing" title="Стоит менее 1 минуты, проверяется на движение">
                          ◇ Проверка ({wall.ageSeconds}с)
                        </span>
                      )}
                    </td>

                    {/* Action: Open on Chart */}
                    <td className="text-center">
                      <button
                        className="density-chart-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenChart(wall.symbol);
                        }}
                        title={`Открыть график ${wall.symbol} с этой стенкой`}
                      >
                        График <ExternalLink size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer Info */}
      <div className="density-footer-tip">
        <span>🛡️ <b>Защита от спуфинга:</b> Заявки со временем удержания &ge;1 мин не являются алгоритмическим шумом — участник намерен исполнить свой объём по указанной цене.</span>
        <span>Показано: <b>{filteredWalls.length}</b> из <b>{allWallsList.length}</b> найденных плотностей</span>
      </div>
    </div>
  );
}
