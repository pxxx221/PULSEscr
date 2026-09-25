export interface TickerData {
  symbol: string;
  price: number;
  change: number; // Percentage change
  volume: number; // Quote-volume (24h) in USDT
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface DrawingPoint {
  time: number; // Unix timestamp
  price: number;
}

export interface TrendLine {
  id: string;
  p1: DrawingPoint;
  p2: DrawingPoint;
}

export interface HudAlert {
  id: string;
  symbol: string;
  change: number;
  timestamp: number;
  isUp: boolean;
  muted?: boolean;
}

export type SortMode = "A-Z" | "%" | "$";

export interface GravityShieldData {
  symbol: string;
  type: "MAGNET_BSL" | "MAGNET_SSL" | "SHIELD_BSL" | "SHIELD_SSL" | "NONE";
  gravityScore: number;
  targetPrice?: number;
}

export interface LiquidityRadarItem {
  id: string;
  symbol: string;
  type: "BSL" | "SSL";
  levelPrice: number;
  touches: number;
  touchesLabel: "2K" | "3K" | "4K+";
  distancePercent: number;
  volumeMultiplier: number; // Volume / SMA20 (e.g. 2.1x)
  status: "Разъедание" | "Поджатие" | "Отскок";
  volumeM: number;
  currentPrice: number;
  atrPercent: number;
  surgeMultiplier: number;
  lastTouchTime?: number;
}

export interface ConfirmedPurpleLevel {
  id: string;
  price: number;
  type: "BSL" | "SSL";
  touches: number;
  touchesLabel: "2K" | "3K" | "4K+";
  distancePercent: number;
  volumeMultiplier: number; // e.g. 2.1x SMA20
  atrPercent: number;
  status: "Разъедание" | "Поджатие" | "Отскок";
}

export interface LiquidityFilterConfig {
  minVolumeM: number;
  minAtrPercent: number;
  maxDistancePercent: number;
  minTouches: number;
  excludeBlacklisted: boolean;
}


