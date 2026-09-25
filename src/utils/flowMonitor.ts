import type { Trade } from '../services/impulseStream';

export type FlowState = 'IMPULSE' | 'SLOWING' | 'STALL' | 'COUNTER_FLOW' | 'ABSORPTION' | 'REVERSAL_STARTED';
export interface FlowConfig {
  enabled: boolean;
  debug: boolean;
  secondAlert: boolean;
  durationSec: number;
  minimumImpulsePercent: number;
  slowing: { velocityDropPercent: number };
  stall: { windowMs: number; maxRangePercent: number };
  counterFlow: { windowMs: number; minimumRatio: number; minimumNotional: number };
  absorption: { maxPriceResponsePercent: number };
  reversal: { minPriceResponsePercent: number };
}
export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  enabled: true, debug: false, secondAlert: false, durationSec: 60, minimumImpulsePercent: 3,
  slowing: { velocityDropPercent: 70 },
  stall: { windowMs: 3000, maxRangePercent: 0.15 },
  counterFlow: { windowMs: 2000, minimumRatio: 2.5, minimumNotional: 50_000 },
  absorption: { maxPriceResponsePercent: 0.05 },
  reversal: { minPriceResponsePercent: 0.15 },
};
export function loadFlowConfig(): FlowConfig {
  try {
    const saved = JSON.parse(localStorage.getItem('pulse_flow_config') || '{}');
    return { ...DEFAULT_FLOW_CONFIG, ...saved,
      slowing: { ...DEFAULT_FLOW_CONFIG.slowing, ...saved.slowing },
      stall: { ...DEFAULT_FLOW_CONFIG.stall, ...saved.stall },
      counterFlow: { ...DEFAULT_FLOW_CONFIG.counterFlow, ...saved.counterFlow },
      absorption: { ...DEFAULT_FLOW_CONFIG.absorption, ...saved.absorption },
      reversal: { ...DEFAULT_FLOW_CONFIG.reversal, ...saved.reversal } };
  } catch { return DEFAULT_FLOW_CONFIG; }
}

export interface FlowSnapshot {
  symbol: string;
  direction: 'PUMP' | 'DUMP';
  impulsePercent: number;
  impulseDurationMs: number;
  ageMs: number;
  state: FlowState;
  peakVelocity: number;
  currentVelocity: number;
  velocityDropPercent: number;
  velocities: Record<'500ms' | '1s' | '2s' | '3s' | '5s', number>;
  buyNotional: number;
  sellNotional: number;
  counterFlowRatio: number;
  counterFlowNotional: number;
  tapeWindows: Record<'1s' | '2s' | '5s', { buyNotional: number; sellNotional: number; counterRatio: number }>;
  priceRangePercent: number;
  priceResponsePercent: number;
  alertReady: boolean;
  debug: boolean;
}
type FlowTick = { price: number; time: number; notional: number; side: 'BUY' | 'SELL' };
type Monitor = { symbol: string; direction: 1 | -1; impulsePercent: number; impulseDurationMs: number;
  startedAt: number; expiresAt: number; peakVelocity: number; slowingSeen: boolean; alertSent: boolean;
  ticks: FlowTick[]; lastState: FlowState; lastCompute: number };

export class FlowMonitor {
  private monitors = new Map<string, Monitor>();
  constructor(private config: FlowConfig = DEFAULT_FLOW_CONFIG) {}
  configure(config: FlowConfig) { this.config = config; if (!config.enabled) this.clear(); }
  clear(symbol?: string) { if (symbol) this.monitors.delete(symbol); else this.monitors.clear(); }
  prune(now: number) { for (const [symbol, monitor] of this.monitors) if (now >= monitor.expiresAt) this.monitors.delete(symbol); }
  activeSymbols() { return [...this.monitors.keys()]; }

  start(symbol: string, impulsePercent: number, durationMs: number, time: number, price: number): boolean {
    if (!this.config.enabled || Math.abs(impulsePercent) < this.config.minimumImpulsePercent || durationMs <= 0 || price <= 0) return false;
    const existing = this.monitors.get(symbol);
    if (existing && time < existing.expiresAt && Math.sign(impulsePercent) === existing.direction) return false;
    this.monitors.set(symbol, { symbol, direction: impulsePercent > 0 ? 1 : -1,
      impulsePercent, impulseDurationMs: durationMs, startedAt: time,
      expiresAt: time + this.config.durationSec * 1000,
      peakVelocity: Math.abs(impulsePercent) / Math.max(durationMs / 1000, 0.5),
      slowingSeen: false, alertSent: false, ticks: [{ price, time, notional: 0, side: 'BUY' }], lastState: 'IMPULSE', lastCompute: time });
    return true;
  }

  push(trade: Trade): FlowSnapshot | null {
    const m = this.monitors.get(trade.symbol);
    if (!m) return null;
    const now = trade.time;
    if (now >= m.expiresAt || now < m.startedAt || !Number.isFinite(trade.notional) || trade.notional <= 0) {
      if (now >= m.expiresAt) this.clear(trade.symbol);
      return null;
    }
    m.ticks.push({ price: trade.price, time: now, notional: trade.notional, side: trade.aggressiveSide });
    if (now - m.lastCompute < 100) return null;
    m.lastCompute = now;
    const keepMs = Math.max(5000, this.config.stall.windowMs, this.config.counterFlow.windowMs) + 1000;
    while (m.ticks.length > 1 && m.ticks[0].time < now - keepMs) m.ticks.shift();
    const ticksWithin = (ms: number) => m.ticks.filter(t => t.time >= now - ms);
    const velocity = (ms: number) => {
      const ticks = ticksWithin(ms);
      const first = ticks[0];
      if (!first || now <= first.time) return 0;
      return m.direction * (trade.price / first.price - 1) * 100 / ((now - first.time) / 1000);
    };
    const velocities = { '500ms': velocity(500), '1s': velocity(1000), '2s': velocity(2000),
      '3s': velocity(3000), '5s': velocity(5000) };
    const currentVelocity = velocities['2s'];
    m.peakVelocity = Math.max(m.peakVelocity, currentVelocity);
    const velocityDropPercent = m.peakVelocity > 0
      ? Math.max(0, Math.min(100, (1 - currentVelocity / m.peakVelocity) * 100)) : 0;
    if (now - m.startedAt >= 1000 && velocityDropPercent >= this.config.slowing.velocityDropPercent) m.slowingSeen = true;
    const stallTicks = ticksWithin(this.config.stall.windowMs);
    let low = Infinity, high = -Infinity;
    for (const tick of stallTicks) { low = Math.min(low, tick.price); high = Math.max(high, tick.price); }
    const priceRangePercent = trade.price > 0 ? (high - low) / trade.price * 100 : 0;
    const stalled = stallTicks.length >= 2 && now - stallTicks[0].time >= this.config.stall.windowMs * 0.8
      && priceRangePercent <= this.config.stall.maxRangePercent;
    const tapeStats = (ms: number) => {
      const windowTicks = ticksWithin(ms);
      let buyNotional = 0, sellNotional = 0;
      for (const tick of windowTicks) {
        if (tick.side === 'BUY') buyNotional += tick.notional;
        else sellNotional += tick.notional;
      }
      const counterNotional = m.direction === 1 ? sellNotional : buyNotional;
      const withNotional = m.direction === 1 ? buyNotional : sellNotional;
      return { buyNotional, sellNotional, counterRatio: counterNotional / Math.max(withNotional, 1) };
    };
    const tapeWindows = { '1s': tapeStats(1000), '2s': tapeStats(2000), '5s': tapeStats(5000) };
    const tape = ticksWithin(this.config.counterFlow.windowMs);
    const { buyNotional, sellNotional } = tapeStats(this.config.counterFlow.windowMs);
    const counterFlowNotional = m.direction === 1 ? sellNotional : buyNotional;
    const withFlowNotional = m.direction === 1 ? buyNotional : sellNotional;
    const counterFlowRatio = counterFlowNotional / Math.max(withFlowNotional, 1);
    const counter = counterFlowNotional >= this.config.counterFlow.minimumNotional
      && counterFlowRatio >= this.config.counterFlow.minimumRatio;
    const tapeStart = tape[0]?.price ?? trade.price;
    const priceResponsePercent = Math.max(0, -m.direction * (trade.price / tapeStart - 1) * 100);
    let state: FlowState = 'IMPULSE';
    if (m.slowingSeen && counter && priceResponsePercent >= this.config.reversal.minPriceResponsePercent) state = 'REVERSAL_STARTED';
    else if (counter && priceResponsePercent <= this.config.absorption.maxPriceResponsePercent) state = 'ABSORPTION';
    else if (counter) state = 'COUNTER_FLOW';
    else if (stalled) state = 'STALL';
    else if (m.slowingSeen) state = 'SLOWING';
    const alertReady = this.config.secondAlert && !m.alertSent && m.slowingSeen && counter
      && (stalled || state === 'REVERSAL_STARTED' || state === 'ABSORPTION');
    if (alertReady) m.alertSent = true;
    m.lastState = state;
    return { symbol: trade.symbol, direction: m.direction === 1 ? 'PUMP' : 'DUMP',
      impulsePercent: m.impulsePercent, impulseDurationMs: m.impulseDurationMs, ageMs: now - m.startedAt,
      state, peakVelocity: m.peakVelocity, currentVelocity, velocityDropPercent, velocities,
      buyNotional, sellNotional, counterFlowRatio, counterFlowNotional, tapeWindows,
      priceRangePercent, priceResponsePercent, alertReady, debug: this.config.debug };
  }
}
