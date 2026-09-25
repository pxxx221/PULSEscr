import React, { useEffect, useState, useRef } from "react";
import { X, Volume2, VolumeX, Sparkles, TrendingUp, TrendingDown } from "lucide-react";
import { TickerData, HudAlert } from "../types";
import { LiveImpulseDetector, ImpulseStage } from "../utils/liveImpulse";
import { startImpulseStream, startFlowTradeStream } from "../services/impulseStream";
import { DEFAULT_FLOW_CONFIG, FlowConfig, FlowMonitor, FlowSnapshot, loadFlowConfig } from "../utils/flowMonitor";
import TelegramTestButton from "./TelegramTestButton";

interface ScannerRadarProps {
  markets: Record<string, TickerData>;
  selectCoin: (coin: string) => void;
  radarOn: boolean;
  alertThreshold: number;
  currentCoin?: string;
  onFlowSnapshot?: (snapshot: FlowSnapshot) => void;
}
function FlowNumber({ label, value, min, max, step = 1, change }: {
  label: string; value: number; min: number; max: number; step?: number; change: (value: number) => void;
}) {
  return <label className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
    <span>{label}</span><input type="number" min={min} max={max} step={step} value={value}
      onChange={event => { const next = Number(event.target.value); if (Number.isFinite(next)) change(Math.min(max, Math.max(min, next))); }}
      className="w-20 rounded bg-slate-900 px-1.5 py-1 text-right font-mono text-slate-200 border border-slate-700" />
  </label>;
}

export default function ScannerRadar({
  markets,
  selectCoin,
  radarOn,
  alertThreshold,
  currentCoin,
  onFlowSnapshot,
}: ScannerRadarProps) {
  const [alerts, setAlerts] = useState<(HudAlert & { stage: ImpulseStage; durationMs: number })[]>([]);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const toggle = () => setSettingsOpen(value => !value);
    window.addEventListener('pulse-alerts', toggle);
    return () => window.removeEventListener('pulse-alerts', toggle);
  }, []);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const [streamStatus, setStreamStatus] = useState('Радар: ожидание рынка');
  const [earlyEnabled, setEarlyEnabled] = useState(true);
  const detectorRef = useRef(new LiveImpulseDetector());
  const [flowConfig, setFlowConfig] = useState<FlowConfig>(loadFlowConfig);
  const flowConfigRef = useRef(flowConfig);
  flowConfigRef.current = flowConfig;
  const flowRef = useRef(new FlowMonitor(flowConfig));
  const flowCallbackRef = useRef(onFlowSnapshot);
  flowCallbackRef.current = onFlowSnapshot;
  const [flowAlerts, setFlowAlerts] = useState<FlowSnapshot[]>([]);
  useEffect(() => {
    flowRef.current.configure(flowConfig);
    try { localStorage.setItem('pulse_flow_config', JSON.stringify(flowConfig)); } catch {}
  }, [flowConfig]);
  useEffect(() => {
    const timer = window.setInterval(() => flowRef.current.prune(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const updateFlowConfig = (patch: Partial<FlowConfig>) => setFlowConfig(previous => ({ ...previous, ...patch }));
  // Stable membership prevents reconnecting on every price update.
  const symbolsKey = Object.keys(markets).filter(s => s.endsWith('/USDT')).sort().join(',');

  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  const alertThresholdRef = useRef(alertThreshold);
  alertThresholdRef.current = alertThreshold;

  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  // Иннициализация звука по первому клику пользователя
  useEffect(() => {
    const handleGesture = () => {
      try {
        if (!audioContextRef.current) {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          if (AudioContextClass) {
            audioContextRef.current = new AudioContextClass();
          }
        }
      } catch (e) {
        // AudioContext initialization prevented
      }
    };
    window.addEventListener("click", handleGesture);
    return () => window.removeEventListener("click", handleGesture);
  }, []);

  // Звуковой синтезатор алертов
  const playBeep = (isUp: boolean) => {
    if (!soundEnabledRef.current) return;
    try {
      let ctx = audioContextRef.current;
      if (!ctx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          ctx = new AudioContextClass();
          audioContextRef.current = ctx;
        }
      }
      if (!ctx) return;
      
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(isUp ? 880 : 380, ctx.currentTime);

      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch (e) {
      // Аудио заблокировано браузером
    }
  };

  useEffect(() => {
    detectorRef.current.clear();
    flowRef.current.clear();
    setAlerts([]);
    setFlowAlerts([]);
    if (!radarOn) return;
    const symbols = symbolsKey.split(',').filter(Boolean).map(s => s.replace('/', ''));
    if (!symbols.length) { setStreamStatus('Радар: ожидание списка монет'); return; }
    const flowStops = new Map<string, { stop: () => void; timer: ReturnType<typeof setTimeout> }>();
    const stopFlow = (symbol: string) => {
      const active = flowStops.get(symbol);
      if (active) { clearTimeout(active.timer); active.stop(); flowStops.delete(symbol); }
    };
    const handleFlowTrade = (trade: Parameters<typeof flowRef.current.push>[0]) => {
      const flow = flowRef.current.push(trade);
      if (flow) {
        flowCallbackRef.current?.(flow);
        if (flow.alertReady) setFlowAlerts(previous => [flow, ...previous.filter(item => item.symbol !== flow.symbol)].slice(0, 5));
      }
    };
    const stopImpulse = startImpulseStream(symbols, trade => {
      const symbol = trade.symbol.slice(0, -4) + '/USDT';
      const market = marketsRef.current[symbol];
      if (!market || !Number.isFinite(market.volume) || market.volume < 5_000_000) {
        detectorRef.current.clear(trade.symbol); return;
      }
      const signal = detectorRef.current.push(trade.symbol, trade.price, trade.time,
        trade.id, trade.serverNow, alertThresholdRef.current, earlyEnabled);
      if (!signal) return;
      const alert = { id: trade.symbol + '-' + trade.id, symbol,
        change: signal.change, timestamp: Date.now(), isUp: signal.change > 0,
        stage: signal.stage, durationMs: signal.durationMs };
      playBeep(alert.isUp);
      setAlerts(prev => [alert, ...prev.filter(a => a.symbol !== symbol || a.stage !== signal.stage)].slice(0, 30));
      if (signal.stage === 'confirmed' && flowRef.current.start(trade.symbol, signal.change, signal.durationMs, trade.time, trade.price)) {
        stopFlow(trade.symbol);
        if (flowStops.size >= 5) stopFlow(flowStops.keys().next().value!);
        const stop = startFlowTradeStream(trade.symbol, handleFlowTrade);
        const timer = setTimeout(() => stopFlow(trade.symbol), flowConfigRef.current.durationSec * 1000);
        flowStops.set(trade.symbol, { stop, timer });
      }
    }, symbols => symbols.forEach(symbol => { detectorRef.current.clear(symbol); flowRef.current.clear(symbol); stopFlow(symbol); }), setStreamStatus);
    return () => { stopImpulse(); for (const symbol of flowStops.keys()) stopFlow(symbol); };
  }, [radarOn, symbolsKey, earlyEnabled]);

  useEffect(() => { detectorRef.current.clear(); }, [alertThreshold]);

  const dismissAlert = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  const handleAlertClick = (symbol: string, id: string) => {
    selectCoin(symbol);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  if (!radarOn) return null;

  return (
    <div className="fixed bottom-11 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none select-none">
      {settingsOpen && <div className="pointer-events-auto rounded border border-slate-700 bg-slate-950/95 p-2 text-[10px] text-slate-300">
        <div role="status">{streamStatus}</div>
        <label className="flex items-center gap-2 mt-1 cursor-pointer">
          <input type="checkbox" checked={earlyEnabled} onChange={e => setEarlyEnabled(e.target.checked)} />
          Ранние сигналы: {(alertThreshold / 2).toFixed(2)}% за ≤10 с
        </label>
        <div>Основной сигнал: {alertThreshold.toFixed(2)}% за ≤45 с • объем 24ч ≥$5M</div>
        <details className="mt-2 border-t border-slate-800 pt-2">
          <summary className="cursor-pointer text-cyan-300">PULSE FLOW · экспериментальный</summary>
          <div className="mt-2 grid gap-1.5 max-h-64 overflow-y-auto pr-1">
            <label><input type="checkbox" checked={flowConfig.enabled} onChange={e => updateFlowConfig({ enabled: e.target.checked })} /> Монитор включён</label>
            <label><input type="checkbox" checked={flowConfig.secondAlert} onChange={e => updateFlowConfig({ secondAlert: e.target.checked })} /> Второй FLOW ALERT</label>
            <label><input type="checkbox" checked={flowConfig.debug} onChange={e => updateFlowConfig({ debug: e.target.checked })} /> Debug на графике</label>
            <FlowNumber label="Длительность, с" value={flowConfig.durationSec} min={10} max={300} change={v => updateFlowConfig({ durationSec: v })} />
            <FlowNumber label="Мин. импульс, %" value={flowConfig.minimumImpulsePercent} min={0.5} max={20} step={0.1} change={v => updateFlowConfig({ minimumImpulsePercent: v })} />
            <FlowNumber label="Падение скорости, %" value={flowConfig.slowing.velocityDropPercent} min={10} max={99} change={v => updateFlowConfig({ slowing: { velocityDropPercent: v } })} />
            <FlowNumber label="Окно остановки, мс" value={flowConfig.stall.windowMs} min={500} max={10000} step={100} change={v => updateFlowConfig({ stall: { ...flowConfig.stall, windowMs: v } })} />
            <FlowNumber label="Диапазон остановки, %" value={flowConfig.stall.maxRangePercent} min={0.01} max={2} step={0.01} change={v => updateFlowConfig({ stall: { ...flowConfig.stall, maxRangePercent: v } })} />
            <FlowNumber label="Окно потока, мс" value={flowConfig.counterFlow.windowMs} min={500} max={10000} step={100} change={v => updateFlowConfig({ counterFlow: { ...flowConfig.counterFlow, windowMs: v } })} />
            <FlowNumber label="Поток против, x" value={flowConfig.counterFlow.minimumRatio} min={1} max={20} step={0.1} change={v => updateFlowConfig({ counterFlow: { ...flowConfig.counterFlow, minimumRatio: v } })} />
            <FlowNumber label="Мин. поток, USDT" value={flowConfig.counterFlow.minimumNotional} min={100} max={10000000} step={1000} change={v => updateFlowConfig({ counterFlow: { ...flowConfig.counterFlow, minimumNotional: v } })} />
            <FlowNumber label="Поглощение: ответ, %" value={flowConfig.absorption.maxPriceResponsePercent} min={0.01} max={2} step={0.01} change={v => updateFlowConfig({ absorption: { maxPriceResponsePercent: v } })} />
            <FlowNumber label="Разворот: ответ, %" value={flowConfig.reversal.minPriceResponsePercent} min={0.01} max={3} step={0.01} change={v => updateFlowConfig({ reversal: { minPriceResponsePercent: v } })} />
            <button onClick={() => setFlowConfig(DEFAULT_FLOW_CONFIG)} className="text-left text-slate-500 hover:text-slate-200">Сбросить пороги FLOW</button>
          </div>
        </details>
      </div>}
      {flowAlerts.length > 0 && <div className="pointer-events-auto rounded border border-amber-500/30 bg-[#171B20] px-3 py-2 text-[11px] text-slate-200">
        <button onClick={() => { selectCoin(flowAlerts[0].symbol.slice(0, -4) + '/USDT'); setFlowAlerts([]); }} className="text-left w-full">
          <b className="text-amber-300">FLOW ALERT</b> · {flowAlerts[0].symbol} · {flowAlerts[0].direction} {flowAlerts[0].impulsePercent > 0 ? '+' : ''}{flowAlerts[0].impulsePercent.toFixed(1)}%
          <span className="block text-slate-400">Скорость ↓{flowAlerts[0].velocityDropPercent.toFixed(0)}% · поток против {flowAlerts[0].counterFlowRatio.toFixed(1)}x · {flowAlerts[0].state}</span>
        </button>
        <button onClick={() => setFlowAlerts([])} aria-label="Закрыть FLOW ALERT" className="absolute right-3 text-slate-500"><X size={12}/></button>
      </div>}
      {(alerts.length > 0 || settingsOpen) && <div className="flex justify-between items-center mb-1 pointer-events-auto px-1 gap-2">
        <div className="text-xs font-bold text-slate-400 bg-slate-900/50 px-2 py-1 rounded border border-slate-800 flex items-center gap-2">
          <span>АЛЕРТЫ: <span className="text-teal-400">{alerts.length}</span></span>
          {alerts.length > 0 && (
            <button onClick={() => setAlerts([])} className="hover:text-slate-200 text-[10px] uppercase cursor-pointer">
              Очистить
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <TelegramTestButton variant="compact" />
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-full border shadow-lg transition-all cursor-pointer ${
              soundEnabled
                ? "bg-teal-950/90 border-teal-500/30 text-teal-300"
                : "bg-slate-900/90 border-slate-700 text-slate-400"
            }`}
          >
            {soundEnabled ? (
              <>
                <Volume2 className="h-3.5 w-3.5" />
                <span>ЗВУК</span>
              </>
            ) : (
              <>
                <VolumeX className="h-3.5 w-3.5" />
                <span>MUTE</span>
              </>
            )}
          </button>
        </div>
      </div>}

      {/* 2. ЕДИНЫЙ ИНТЕРАКТИВНЫЙ СТЭК АЛЕРТОВ РАДАРА */}
      <div className="relative w-full pointer-events-auto pr-2 pb-2">
          {alerts.length > 0 && (() => {
            const alert = alerts[0]; // Всегда берем первый элемент из очереди
            const hiddenCount = alerts.length - 1;

            return (
              <div className="relative">
                {/* 3D-слои стопки сзади для визуализации объема очереди */}
                {alerts.length > 2 && (
                  <div className="absolute top-2 left-2 right-2 bottom-[-8px] bg-slate-800/40 rounded-lg -z-20 border border-slate-700/30" />
                )}
                {alerts.length > 1 && (
                  <div className="absolute top-1 left-1 right-1 bottom-[-4px] bg-slate-800/60 rounded-lg -z-10 border border-slate-700/50" />
                )}
                
                {/* Основной интерактивный алерт */}
                <div
                  key={alert.id}
                  onClick={() => handleAlertClick(alert.symbol, alert.id)}
                  className={`flex items-center justify-between p-3.5 rounded-lg shadow-2xl border backdrop-blur-md transition-all duration-300 hover:scale-[1.02] cursor-pointer relative overflow-hidden animate-slide-in shrink-0 z-10 ${
                    alert.isUp
                      ? "bg-teal-950/95 border-teal-500/40 text-teal-100 shadow-teal-950/25"
                      : "bg-rose-950/95 border-rose-500/40 text-rose-100 shadow-rose-950/25"
                  }`}
                >
                  <div
                    className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                      alert.isUp ? "bg-teal-400" : "bg-rose-400"
                    }`}
                  />

                  <div className="flex items-center gap-3 pl-2.5">
                    <div
                      className={`p-1.5 rounded ${
                        alert.isUp ? "bg-teal-900/50" : "bg-rose-900/50"
                      }`}
                    >
                      {alert.isUp ? (
                        <TrendingUp className="h-4 w-4 text-teal-400" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-rose-400" />
                      )}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold tracking-wide font-mono flex items-center gap-2">
                        {alert.symbol.split("/")[0]}
                        {/* Компактный счетчик оставшихся монет в стопке */}
                        {hiddenCount > 0 && (
                          <span className="text-[10px] bg-blue-600 text-white font-bold px-1.5 py-0.5 rounded font-sans border border-blue-500 animate-pulse">
                            +{hiddenCount}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] text-slate-400 flex items-center gap-1 font-sans">
                        <Sparkles className="h-2.5 w-2.5 text-amber-400 animate-spin" /> {alert.stage === "early" ? "Раннее предупреждение" : "Порог импульса достигнут"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 pr-1">
                    <span
                      className={`text-sm font-black font-mono tracking-tight ${
                        alert.isUp ? "text-teal-300" : "text-rose-300"
                      }`}
                    >
                      {alert.isUp ? "+" : ""}
                      {alert.change.toFixed(2)}%
                      <span className="block text-[10px] font-normal">за {(alert.durationMs / 1000).toFixed(1)} с • {new Date(alert.timestamp).toLocaleTimeString()}</span>
                    </span>
                    <button
                      onClick={(e) => dismissAlert(alert.id, e)}
                      className="p-1 rounded text-slate-400 hover:text-white transition duration-150 cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
    </div>
  );
}
