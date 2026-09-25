/**
 * Telegram Bot API Alert Service for Binance Futures Liquidity Screener
 */

import { MomentumSignal } from "../utils/momentumEngine";
import { HotScalpSignal } from "../utils/liquidityScanner";
import { ChochSignal } from "../utils/marketStructure";

export const TELEGRAM_CONFIG = {
  BOT_TOKEN: "",
  CHAT_ID: "",
  COOLDOWN_MS: 5 * 60 * 1000,   // 5 minutes anti-spam per coin
  MIN_VOLUME_24H_M: 25.0,       // $25M min 24h volume
  MIN_MOMENTUM_PERCENT: 3.0,    // Strictly >= 3.0% for Telegram momentum alerts
};

// Anti-spam cooldown store: ticker -> timestamp
const lastAlertTimestamps: Record<string, number> = {};

// Alert history store for UI logs/toasts
export interface TelegramAlertLog {
  id: string;
  ticker: string;
  type: "MOMENTUM_LONG" | "MOMENTUM_SHORT" | "CHOCH_BULL" | "CHOCH_BEAR" | "HOT_SCALP" | "TEST";
  text: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

const alertLogs: TelegramAlertLog[] = [];

/**
 * Format price cleanly according to magnitude
 */
export function formatTelegramPrice(price: number): string {
  if (typeof price !== "number" || isNaN(price)) return "0.00";
  if (price >= 1000) {
    return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (price >= 1) {
    return price.toFixed(4);
  }
  if (price >= 0.0001) {
    return price.toFixed(6);
  }
  return price.toFixed(8);
}

/**
 * Send raw HTML message to Telegram via Bot API sendMessage
 */
export async function sendTelegramMessage(htmlText: string): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'Telegram disabled for local review' };
  try {
    const token = TELEGRAM_CONFIG.BOT_TOKEN;
    const chatId = TELEGRAM_CONFIG.CHAT_ID;

    if (!token || !chatId) {
      return { success: false, error: "BOT_TOKEN или CHAT_ID не настроены" };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    clearTimeout(timeoutId);

    const data = await response.json();

    if (!response.ok || !data.ok) {
      const err = data?.description || `HTTP Error ${response.status}`;
      console.warn("Telegram API Error:", err);
      return { success: false, error: err };
    }

    return { success: true };
  } catch (err: any) {
    console.error("Failed to send Telegram message:", err);
    return { success: false, error: err.message || "Ошибка соединения с Telegram API" };
  }
}

/**
 * Send Test message to Telegram
 */
export async function sendTelegramTestAlert(): Promise<{ success: boolean; error?: string }> {
  const text = "✅ <b>Связь скринера с Telegram успешно настроена!</b>";
  const res = await sendTelegramMessage(text);
  
  alertLogs.unshift({
    id: `test-${Date.now()}`,
    ticker: "TEST",
    type: "TEST",
    text,
    timestamp: Date.now(),
    success: res.success,
    error: res.error,
  });

  return res;
}

/**
 * Check cooldown and send Price Action Momentum (1m Squeeze) alert to Telegram
 */
export async function checkAndSendMomentumAlert(
  signal: MomentumSignal,
  force = false
): Promise<{ sent: boolean; reason?: string; error?: string }> {
  const cleanTicker = signal.ticker.replace("/USDT", "").replace("USDT", "").toUpperCase();
  const now = Date.now();

  // 1. Anti-spam Cooldown: 1 alert per 5 minutes per coin
  const lastTime = lastAlertTimestamps[cleanTicker] || 0;
  if (!force && now - lastTime < TELEGRAM_CONFIG.COOLDOWN_MS) {
    const remainingSec = Math.ceil((TELEGRAM_CONFIG.COOLDOWN_MS - (now - lastTime)) / 1000);
    const remainingMin = Math.ceil(remainingSec / 60);
    return { sent: false, reason: `Кулдаун #${cleanTicker}: осталось ${remainingMin} мин.` };
  }

  // 1.1 Strict User Filter: Momentum must be >= 3.0%
  if (!force && Math.abs(signal.changePercent) < TELEGRAM_CONFIG.MIN_MOMENTUM_PERCENT) {
    return {
      sent: false,
      reason: `Импульс #${cleanTicker} (${Math.abs(signal.changePercent).toFixed(2)}%) меньше порога ${TELEGRAM_CONFIG.MIN_MOMENTUM_PERCENT}%`,
    };
  }

  // 2. Format values
  const formattedPrice = formatTelegramPrice(signal.price);
  const formattedChange = `${signal.changePercent >= 0 ? "+" : ""}${signal.changePercent.toFixed(2)}`;
  const formattedChange24h = `${signal.change24h >= 0 ? "+" : ""}${signal.change24h.toFixed(2)}`;
  const formattedVol24h = signal.volume24hM >= 1000 
    ? (signal.volume24hM / 1000).toFixed(2) + "B" 
    : signal.volume24hM.toFixed(1);

  // Liquidity target line
  let targetPoolLine: string;
  if (signal.targetPool) {
    targetPoolLine = `${signal.targetPool.type} $${formatTelegramPrice(signal.targetPool.price)} (дистанция ${signal.targetPool.distancePercent.toFixed(2)}%)`;
  } else {
    targetPoolLine = "Вне пулов (дистанция >0.4%)";
  }

  // Format current local time (e.g. 15:42:05)
  const timeStr = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Strict User Template:
  // ⚡️ <b>ИМПУЛЬС ЦЕНЫ (1m Squeeze)</b>
  // ━━━━━━━━━━━━━━━━━
  // 🪙 <b>Монета:</b> <code>{TICKER}</code> <i>(нажми для копирования)</i>
  // 🚀 <b>Направление:</b> {🟢 ЛОНГ / 🔴 ШОРТ}
  // 📈 <b>Скорость:</b> {CHANGE_1M}% (в моменте)
  // 💵 <b>Цена:</b> ${PRICE}
  // 🎯 <b>Ближайший пул:</b> {POOL_INFO}
  // 📊 <b>24h Объем:</b> ${VOLUME_24H}M | <b>24h Изм:</b> {CHANGE_24H}%
  // ━━━━━━━━━━━━━━━━━
  // ⏰ {TIME}

  const messageHtml = `⚡️ <b>ИМПУЛЬС ЦЕНЫ (1m Squeeze)</b>
━━━━━━━━━━━━━━━━━
🪙 <b>Монета:</b> <code>${cleanTicker}</code> <i>(нажми для копирования)</i>
🚀 <b>Направление:</b> ${signal.directionLabel}
📈 <b>Скорость:</b> ${formattedChange}% (в моменте)
💵 <b>Цена:</b> $${formattedPrice}
🎯 <b>Ближайший пул:</b> ${targetPoolLine}
📊 <b>24h Объем:</b> $${formattedVol24h}M | <b>24h Изм:</b> ${formattedChange24h}%
━━━━━━━━━━━━━━━━━
⏰ ${timeStr}`;

  const sendResult = await sendTelegramMessage(messageHtml);

  if (sendResult.success) {
    lastAlertTimestamps[cleanTicker] = now;
    alertLogs.unshift({
      id: `mom-${cleanTicker}-${now}`,
      ticker: cleanTicker,
      type: signal.direction === "LONG" ? "MOMENTUM_LONG" : "MOMENTUM_SHORT",
      text: messageHtml,
      timestamp: now,
      success: true,
    });
    return { sent: true };
  } else {
    alertLogs.unshift({
      id: `mom-err-${cleanTicker}-${now}`,
      ticker: cleanTicker,
      type: signal.direction === "LONG" ? "MOMENTUM_LONG" : "MOMENTUM_SHORT",
      text: messageHtml,
      timestamp: now,
      success: false,
      error: sendResult.error,
    });
    return { sent: false, error: sendResult.error };
  }
}

/**
 * Check cooldown and send Hot Scalp Squeeze to Level (5m Compression) alert to Telegram
 */
export async function checkAndSendHotScalpAlert(
  signal: HotScalpSignal,
  force = false
): Promise<{ sent: boolean; reason?: string; error?: string }> {
  const cleanTicker = signal.ticker.replace("/USDT", "").replace("USDT", "").toUpperCase();
  const now = Date.now();

  // 1. Anti-spam Cooldown: 5 minutes per coin
  const cooldownKey = `hot_${cleanTicker}`;
  const lastTime = lastAlertTimestamps[cooldownKey] || lastAlertTimestamps[cleanTicker] || 0;
  if (!force && now - lastTime < TELEGRAM_CONFIG.COOLDOWN_MS) {
    const remainingSec = Math.ceil((TELEGRAM_CONFIG.COOLDOWN_MS - (now - lastTime)) / 1000);
    const remainingMin = Math.ceil(remainingSec / 60);
    return { sent: false, reason: `Кулдаун #${cleanTicker}: осталось ${remainingMin} мин.` };
  }

  // 2. Format values
  const typeLabel = signal.type === "BSL" ? "🔴 BSL (Шорт-стопы)" : "🟢 SSL (Лонг-стопы)";
  const formattedPrice = formatTelegramPrice(signal.levelPrice);
  const touchesStr = signal.touchesLabel || (signal.touches >= 3 ? "3+" : "2");
  const formattedDistance = signal.distancePercent.toFixed(2);
  const formattedChange24h = `${signal.change24h >= 0 ? "+" : ""}${signal.change24h.toFixed(2)}`;
  const formattedVol24h = signal.volume24hM >= 1000
    ? (signal.volume24hM / 1000).toFixed(2) + "B"
    : signal.volume24hM.toFixed(1);
  const formattedAtr = signal.atrPercent.toFixed(2);

  const timeStr = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Strict User Template:
  // 🔥 <b>HOT СКАЛЬП: ПОДЖАТИЕ К УРОВНЮ</b>
  // ━━━━━━━━━━━━━━━━━
  // 🪙 <b>Монета:</b> <code>{TICKER}</code> <i>(тапни для копирования)</i>
  // 📊 <b>Уровень:</b> {TYPE} <b>${LEVEL_PRICE}</b> [{TOUCHES}K]
  // 📍 <b>Дистанция:</b> {DISTANCE}%
  // 🔥 <b>24h Изм:</b> {CHANGE_24H}% | <b>Объем 24h:</b> ${VOLUME_24H}M
  // 📈 <b>ATR(14):</b> {ATR}%
  // ━━━━━━━━━━━━━━━━━
  // ⏰ {TIME}
  const messageHtml = `🔥 <b>HOT СКАЛЬП: ПОДЖАТИЕ К УРОВНЮ</b>
━━━━━━━━━━━━━━━━━
🪙 <b>Монета:</b> <code>${cleanTicker}</code> <i>(тапни для копирования)</i>
📊 <b>Уровень:</b> ${typeLabel} <b>$${formattedPrice}</b> [${touchesStr}K]
📍 <b>Дистанция:</b> ${formattedDistance}%
🔥 <b>24h Изм:</b> ${formattedChange24h}% | <b>Объем 24h:</b> $${formattedVol24h}M
📈 <b>ATR(14):</b> ${formattedAtr}%
━━━━━━━━━━━━━━━━━
⏰ ${timeStr}`;

  const sendResult = await sendTelegramMessage(messageHtml);

  if (sendResult.success) {
    lastAlertTimestamps[cooldownKey] = now;
    lastAlertTimestamps[cleanTicker] = now;
    alertLogs.unshift({
      id: `hot-${cleanTicker}-${now}`,
      ticker: cleanTicker,
      type: "HOT_SCALP",
      text: messageHtml,
      timestamp: now,
      success: true,
    });
    return { sent: true };
  } else {
    alertLogs.unshift({
      id: `hot-err-${cleanTicker}-${now}`,
      ticker: cleanTicker,
      type: "HOT_SCALP",
      text: messageHtml,
      timestamp: now,
      success: false,
      error: sendResult.error,
    });
    return { sent: false, error: sendResult.error };
  }
}

/**
 * Check cooldown and send Confirmed Market Structure Shift (CHoCH 5m) alert to Telegram
 */
export async function checkAndSendChochAlert(
  signal: ChochSignal,
  force = false
): Promise<{ sent: boolean; reason?: string; error?: string }> {
  const cleanTicker = signal.ticker.replace("/USDT", "").replace("USDT", "").toUpperCase();
  const now = Date.now();

  // 1. Anti-spam Cooldown: 5 minutes per coin for CHoCH
  const cooldownKey = `choch_${cleanTicker}`;
  const lastTime = lastAlertTimestamps[cooldownKey] || lastAlertTimestamps[cleanTicker] || 0;
  if (!force && now - lastTime < TELEGRAM_CONFIG.COOLDOWN_MS) {
    const remainingSec = Math.ceil((TELEGRAM_CONFIG.COOLDOWN_MS - (now - lastTime)) / 1000);
    const remainingMin = Math.ceil(remainingSec / 60);
    return { sent: false, reason: `Кулдаун CHoCH #${cleanTicker}: осталось ${remainingMin} мин.` };
  }

  // 2. Format values
  const isLong = signal.direction === "LONG";
  const directionEmoji = isLong ? "🟢" : "🔴";
  const directionText = isLong ? "БЫЧИЙ СЛОМ (В ЛОНГ)" : "МЕДВЕЖИЙ СЛОМ (В ШОРТ)";
  const formattedPivotPrice = formatTelegramPrice(signal.pivotPrice);
  const formattedBreakPrice = formatTelegramPrice(signal.breakPrice);
  const formattedChange24h = `${signal.change24h >= 0 ? "+" : ""}${signal.change24h.toFixed(2)}`;
  const formattedVol24h = signal.volume24hM >= 1000
    ? (signal.volume24hM / 1000).toFixed(2) + "B"
    : signal.volume24hM.toFixed(1);

  const timeStr = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Strict CHoCH Template:
  // 🔄 <b>СЛОМ СТРУКТУРЫ (CHoCH 5m)</b>
  // ━━━━━━━━━━━━━━━━━
  // 🪙 <b>Монета:</b> <code>{TICKER}</code> <i>(тапни для копирования)</i>
  // 🎯 <b>Слом:</b> {🟢 БЫЧИЙ СЛОМ (В ЛОНГ) / 🔴 МЕДВЕЖИЙ СЛОМ (В ШОРТ)}
  // 🛡 <b>Опорный уровень:</b> ${PIVOT_PRICE} [{PIVOT_TYPE}]
  // ✅ <b>Закрытие телом:</b> ${BREAK_PRICE} (Подтверждено)
  // 💥 <b>Плотность свечи:</b> {DISPLACEMENT}%
  // 📊 <b>24h Объем:</b> ${VOLUME_24H}M | <b>24h Изм:</b> {CHANGE_24H}%
  // ━━━━━━━━━━━━━━━━━
  // ⏰ {TIME}
  const messageHtml = `🔄 <b>СЛОМ СТРУКТУРЫ (CHoCH 5m)</b>
━━━━━━━━━━━━━━━━━
🪙 <b>Монета:</b> <code>${cleanTicker}</code> <i>(тапни для копирования)</i>
🎯 <b>Слом:</b> ${directionEmoji} <b>${directionText}</b>
🛡 <b>Опорный уровень:</b> $${formattedPivotPrice} [${signal.pivotType}]
✅ <b>Закрытие телом:</b> $${formattedBreakPrice} (Подтверждено)
💥 <b>Плотность свечи:</b> ${signal.displacementPercent}%
📊 <b>24h Объем:</b> $${formattedVol24h}M | <b>24h Изм:</b> ${formattedChange24h}%
━━━━━━━━━━━━━━━━━
⏰ ${timeStr}`;

  const sendResult = await sendTelegramMessage(messageHtml);

  if (sendResult.success) {
    lastAlertTimestamps[cooldownKey] = now;
    lastAlertTimestamps[cleanTicker] = now;
    alertLogs.unshift({
      id: `choch-${cleanTicker}-${now}`,
      ticker: cleanTicker,
      type: isLong ? "CHOCH_BULL" : "CHOCH_BEAR",
      text: messageHtml,
      timestamp: now,
      success: true,
    });
    return { sent: true };
  } else {
    alertLogs.unshift({
      id: `choch-err-${cleanTicker}-${now}`,
      ticker: cleanTicker,
      type: isLong ? "CHOCH_BULL" : "CHOCH_BEAR",
      text: messageHtml,
      timestamp: now,
      success: false,
      error: sendResult.error,
    });
    return { sent: false, error: sendResult.error };
  }
}

/**
 * Send sample CHoCH test message to Telegram
 */
export async function sendTelegramChochTestAlert(): Promise<{ success: boolean; error?: string }> {
  const sampleSignal: ChochSignal = {
    ticker: "SOL",
    direction: "LONG",
    directionLabel: "🟢 БЫЧИЙ (В ЛОНГ)",
    breakType: "BULLISH_CHOCH",
    pivotPrice: 142.80,
    pivotType: "LH",
    breakPrice: 143.65,
    displacementPercent: 76,
    volume24hM: 520.4,
    change24h: 4.85,
    breakTime: Math.floor(Date.now() / 1000),
    timestamp: Date.now(),
  };

  const res = await checkAndSendChochAlert(sampleSignal, true);
  return { success: res.sent, error: res.error || res.reason };
}

/**
 * Send sample Hot Scalp test message to Telegram
 */
export async function sendTelegramHotScalpTestAlert(): Promise<{ success: boolean; error?: string }> {
  const sampleSignal: HotScalpSignal = {
    ticker: "SOL",
    type: "BSL",
    typeLabel: "🔴 BSL (Шорт-стопы)",
    levelPrice: 142.50,
    touches: 2,
    touchesLabel: "2",
    distancePercent: 0.24,
    change24h: 6.85,
    volume24hM: 345.2,
    atrPercent: 0.42,
    timestamp: Date.now(),
  };

  const res = await checkAndSendHotScalpAlert(sampleSignal, true);
  return { success: res.sent, error: res.error || res.reason };
}

/**
 * Send sample Price Momentum test message to Telegram (>= 3.0%)
 */
export async function sendTelegramMomentumTestAlert(): Promise<{ success: boolean; error?: string }> {
  const sampleSignal: MomentumSignal = {
    ticker: "SOL",
    direction: "LONG",
    directionLabel: "🟢 ЛОНГ",
    price: 188.45,
    changePercent: 3.42,
    durationMinutes: 1,
    ratioToAtr: 4.1,
    atr14: 0.55,
    volume24hM: 780.2,
    change24h: 5.62,
    targetPool: {
      type: "🔴 BSL",
      price: 189.20,
      distancePercent: 0.40,
    },
    timestamp: Date.now(),
  };

  const res = await checkAndSendMomentumAlert(sampleSignal, true);
  return { success: res.sent, error: res.error || res.reason };
}

/**
 * Get recent alert logs
 */
export function getTelegramAlertLogs(): TelegramAlertLog[] {
  return alertLogs.slice(0, 50);
}
