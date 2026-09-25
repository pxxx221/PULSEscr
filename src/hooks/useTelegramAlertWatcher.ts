import { useEffect, useRef } from "react";
import { TickerData } from "../types";
import { checkAndSendMomentumAlert, checkAndSendChochAlert } from "../services/telegramService";
import {
  isPureCryptoTicker,
  ScannerCandle,
} from "../utils/liquidityScanner";
import { detectPriceMomentum } from "../utils/momentumEngine";
import { detectRecentChochSignal } from "../utils/marketStructure";

interface TelegramAlertWatcherProps {
  markets: Record<string, TickerData>;
  enabled?: boolean;
}

/**
 * Background watcher that monitors Binance Futures assets for Telegram:
 *
 * 1. CONFIRMED MARKET STRUCTURE SHIFT (CHoCH 5m):
 *    - Replaces old level compression alerts.
 *    - Monitors liquid crypto futures (Volume24h >= $25M).
 *    - Detects genuine Change of Character (BULLISH_CHOCH or BEARISH_CHOCH).
 *    - Body close confirmation rule (no wicks/sweeps).
 *    - Displacement quality filter (solid candle body >= 40-50%).
 *    - 5 min anti-spam cooldown per coin.
 *
 * 2. PRICE MOMENTUM (1m/2m Squeeze >= 3.0%):
 *    - Strictly triggered ONLY for explosive moves >= 3.0%.
 *    - Volume24h >= $30M.
 *    - 5 min anti-spam cooldown per coin.
 */
export function useTelegramAlertWatcher({
  markets,
  enabled = true,
}: TelegramAlertWatcherProps) {
  const isMomRunningRef = useRef(false);
  const isChochScanningRef = useRef(false);
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  useEffect(() => {
    if (!enabled) return;

    let isCancelled = false;

    // Scan 1: Confirmed Market Structure Breaks (CHoCH on 5m)
    const runChochScan = async () => {
      if (isChochScanningRef.current || isCancelled) return;
      isChochScanningRef.current = true;

      try {
        const allTickers = Object.values(marketsRef.current);
        const chochCandidates = allTickers
          .filter((t) => isPureCryptoTicker(t.symbol) && t.volume / 1_000_000 >= 30.0 && t.price > 0)
          .sort((a, b) => {
            // Sort by volatile activity & volume
            const scoreA = Math.abs(a.change) * 2.0 + Math.log10(Math.max(1, a.volume / 1_000_000));
            const scoreB = Math.abs(b.change) * 2.0 + Math.log10(Math.max(1, b.volume / 1_000_000));
            return scoreB - scoreA;
          })
          .slice(0, 12); // Focused top 12 volatile candidates to avoid rate limiting

        if (chochCandidates.length === 0) return;

        // Process in small parallel batches of 3 to avoid rate limits
        const chunkSize = 3;
        for (let i = 0; i < chochCandidates.length; i += chunkSize) {
          if (isCancelled) break;

          const batch = chochCandidates.slice(i, i + chunkSize);
          await Promise.allSettled(
            batch.map(async (ticker) => {
              if (isCancelled) return;
              const cleanSymbol = ticker.symbol.replace(/[\/_]/g, "").toUpperCase();

              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);

                const res = await fetch(
                  `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=5m&limit=90`,
                  { signal: controller.signal }
                );
                clearTimeout(timeoutId);

                if (!res.ok) return;
                const raw = await res.json();
                if (!Array.isArray(raw) || raw.length < 25) return;

                const candles: ScannerCandle[] = raw.map((d: any) => ({
                  time: Math.floor(d[0] / 1000),
                  open: parseFloat(d[1]),
                  high: parseFloat(d[2]),
                  low: parseFloat(d[3]),
                  close: parseFloat(d[4]),
                  volume: parseFloat(d[5]),
                }));

                const chochSignal = detectRecentChochSignal(
                  candles,
                  ticker.symbol,
                  ticker.volume,
                  ticker.change
                );

                if (chochSignal) {
                  await checkAndSendChochAlert(chochSignal);
                }
              } catch {
                // Non-critical network skip
              }
            })
          );

          if (!isCancelled) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      } catch {
        // Safe catch
      } finally {
        isChochScanningRef.current = false;
      }
    };

    // Scan 2: Price Momentum (Explosive Impulse >= 3.0%)
    const runMomentumScan = async () => {
      if (isMomRunningRef.current || isCancelled) return;
      isMomRunningRef.current = true;

      try {
        const marketList = Object.values(marketsRef.current)
          .filter((t) => isPureCryptoTicker(t.symbol) && t.volume / 1_000_000 >= 30.0 && t.price > 0 && Math.abs(t.change) >= 2.0)
          .sort((a, b) => {
            // Prioritize coins with explosive 24h momentum
            const scoreA = Math.abs(a.change) * 2.5 + Math.log10(Math.max(1, a.volume / 1_000_000));
            const scoreB = Math.abs(b.change) * 2.5 + Math.log10(Math.max(1, b.volume / 1_000_000));
            return scoreB - scoreA;
          })
          .slice(0, 10); // Top 10 explosive candidates

        if (marketList.length === 0) return;

        const chunkSize = 2;
        for (let i = 0; i < marketList.length; i += chunkSize) {
          if (isCancelled) break;

          const batch = marketList.slice(i, i + chunkSize);
          await Promise.allSettled(
            batch.map(async (ticker) => {
              if (isCancelled) return;
              const cleanSymbol = ticker.symbol.replace(/[\/_]/g, "").toUpperCase();

              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);

                const res = await fetch(
                  `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=1m&limit=40`,
                  { signal: controller.signal }
                );
                clearTimeout(timeoutId);

                if (!res.ok) return;
                const raw = await res.json();
                if (!Array.isArray(raw) || raw.length < 20) return;

                const candles: ScannerCandle[] = raw.map((d: any) => ({
                  time: Math.floor(d[0] / 1000),
                  open: parseFloat(d[1]),
                  high: parseFloat(d[2]),
                  low: parseFloat(d[3]),
                  close: parseFloat(d[4]),
                  volume: parseFloat(d[5]),
                }));

                const momentumSignal = detectPriceMomentum(
                  candles,
                  ticker.symbol,
                  ticker.volume,
                  ticker.change
                );

                // STRICT: Telegram alerts only for impulses of 3.0% and above
                if (momentumSignal && Math.abs(momentumSignal.changePercent) >= 3.0) {
                  await checkAndSendMomentumAlert(momentumSignal);
                }
              } catch {
                // Non-critical network skip
              }
            })
          );

          if (!isCancelled) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      } catch {
        // Global error boundary
      } finally {
        isMomRunningRef.current = false;
      }
    };

    // Polite initial delay (10-15s) so page and chart load instantly first
    const initialTimerChoch = setTimeout(runChochScan, 10000);
    const initialTimerMom = setTimeout(runMomentumScan, 16000);

    // Continuous spaced intervals
    const intervalChoch = setInterval(runChochScan, 35000);
    const intervalMom = setInterval(runMomentumScan, 25000);

    return () => {
      isCancelled = true;
      clearTimeout(initialTimerChoch);
      clearTimeout(initialTimerMom);
      clearInterval(intervalChoch);
      clearInterval(intervalMom);
    };
  }, [enabled]);
}
