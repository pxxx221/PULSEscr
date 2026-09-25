import { GravityShieldData } from "../types";
// No score is available without actual order-book and trade-flow observations.
export function getGravityShieldAnalysis(symbol: string, _currentPrice: number, _livePools?: {price:number;type:"BSL"|"SSL"}[]): GravityShieldData {
  return {symbol, type:"NONE", gravityScore:0};
}
