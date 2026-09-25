export type ImpulseStage = 'early' | 'confirmed';
export interface Impulse { change: number; stage: ImpulseStage; durationMs: number }
interface Point { price: number; time: number; index: number }
class Window {
  private points: Point[] = [];
  private first = 0;
  private min: Point[] = [];
  private minFirst = 0;
  private max: Point[] = [];
  private maxFirst = 0;
  private nextIndex = 0;
  reset() { this.points = []; this.first = 0; this.min = []; this.minFirst = 0; this.max = []; this.maxFirst = 0; }
  private discardOldest() {
    const old = this.points[this.first++];
    if (this.min[this.minFirst]?.index === old.index) this.minFirst++;
    if (this.max[this.maxFirst]?.index === old.index) this.maxFirst++;
  }
  private compact() {
    if (this.first > 1024 && this.first * 2 > this.points.length) { this.points = this.points.slice(this.first); this.first = 0; }
    if (this.minFirst > 1024 && this.minFirst * 2 > this.min.length) { this.min = this.min.slice(this.minFirst); this.minFirst = 0; }
    if (this.maxFirst > 1024 && this.maxFirst * 2 > this.max.length) { this.max = this.max.slice(this.maxFirst); this.maxFirst = 0; }
  }
  push(price: number, time: number, windowMs: number, threshold: number): Omit<Impulse, 'stage'> | null {
    const previous = this.points.at(-1);
    // Do not infer a move across a missing observation interval.
    if (!previous || time - previous.time > 5000) this.reset();
    while (this.first < this.points.length && this.points[this.first].time < time - windowMs) this.discardOldest();
    const base = previous && price !== previous.price
      ? price > previous.price ? this.min[this.minFirst] : this.max[this.maxFirst]
      : undefined;
    const point = { price, time, index: this.nextIndex++ };
    this.points.push(point);
    while (this.min.length > this.minFirst && this.min.at(-1)!.price > price) this.min.pop();
    this.min.push(point);
    while (this.max.length > this.maxFirst && this.max.at(-1)!.price < price) this.max.pop();
    this.max.push(point);
    if (this.points.length - this.first > 5000) this.discardOldest();
    this.compact();
    if (!base || time <= base.time) return null;
    const change = (price / base.price - 1) * 100;
    if (Math.abs(change) + 1e-9 < threshold) return null;
    // Rearm from this price: flat prices cannot repeat; a fresh move or reversal can.
    this.reset();
    this.points = [point]; this.min = [point]; this.max = [point];
    return { change, durationMs: time - base.time };
  }
}

export class LiveImpulseDetector {
  private states = new Map<string, { time: number; id: number; early: Window; confirmed: Window }>();
  clear(symbol?: string) { if (symbol) this.states.delete(symbol); else this.states.clear(); }
  push(symbol: string, price: number, time: number, id: number, serverNow: number,
    threshold: number, earlyEnabled: boolean): Impulse | null {
    if (![price, time, id, serverNow, threshold].every(Number.isFinite) || price <= 0 || threshold <= 0
      || time <= 0 || !Number.isSafeInteger(id) || serverNow - time > 8000 || time - serverNow > 1000) return null;
    let state = this.states.get(symbol);
    if (state && (id <= state.id || time < state.time)) return null;
    if (!state) {
      state = { time, id, early: new Window(), confirmed: new Window() };
      this.states.set(symbol, state);
    }
    state.time = time; state.id = id;
    const confirmed = state.confirmed.push(price, time, 45000, threshold);
    const early = state.early.push(price, time, 10000, threshold / 2);
    if (confirmed) {
      state.early.reset();
      state.early.push(price, time, 10000, threshold / 2);
      return { ...confirmed, stage: 'confirmed' };
    }
    return earlyEnabled && early ? { ...early, stage: 'early' } : null;
  }
}
