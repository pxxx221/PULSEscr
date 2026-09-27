export interface Trade {
  id: string;
  symbol: string; // e.g. "LSKUSDT"
  side: "LONG" | "SHORT";
  category?: string;
  entryReason?: string;
  exitReason?: string;
  openPrice: number;
  closePrice: number;
  openTime: number; // timestamp in ms
  closeTime: number; // timestamp in ms
  qty: number;
  notional: number; // USD turnover
  realizedPnl: number; // USD
  pnlPercent: number; // %
  commission: number; // USD fee
  isFutures: boolean;
  notes?: string;
}

export interface JournalStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number; // %
  netPnl: number; // USD
  totalVolume: number; // USD
  totalCommission: number; // USD
  profitFactor: number;
  longCount: number;
  shortCount: number;
  avgWinPercent: number;
  avgLossPercent: number;
  maxDrawdown: number; // %
  avgHoldSec: number;
  avgWinUsd: number;
  avgLossUsd: number;
  equityCurveUsd: { date: string; value: number }[];
  equityCurvePercent: { date: string; value: number }[];
}

export interface WeekSummary {
  id: string;
  rangeLabel: string; // e.g. "21 — 27 Сент"
  pnl: number;
  tradesCount: number;
  volume: number;
  winRate: number;
}

export interface JournalApiConfig {
  apiKey: string;
  apiSecret: string;
  exchange: "binance" | "tiger";
  timezone: string;
  autoRefresh: boolean;
  lastSyncTime?: number;
}
