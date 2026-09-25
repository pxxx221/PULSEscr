import React, { useState, useRef, useEffect } from "react";
import { Send, CheckCircle2, AlertCircle, Loader2, ChevronDown, Zap, GitBranch, Bell } from "lucide-react";
import {
  sendTelegramTestAlert,
  sendTelegramMomentumTestAlert,
  sendTelegramChochTestAlert,
} from "../services/telegramService";

interface TelegramTestButtonProps {
  className?: string;
  variant?: "header" | "compact" | "badge";
}

type TestType = "ping" | "momentum" | "choch";

export default function TelegramTestButton({
  className = "",
  variant = "header",
}: TelegramTestButtonProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [lastSentType, setLastSentType] = useState<TestType>("choch");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const triggerTest = async (type: TestType, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (status === "loading") return;

    setMenuOpen(false);
    setStatus("loading");
    setLastSentType(type);
    setErrorMessage("");

    try {
      let result: { success: boolean; error?: string };
      if (type === "momentum") {
        result = await sendTelegramMomentumTestAlert();
      } else if (type === "choch") {
        result = await sendTelegramChochTestAlert();
      } else {
        result = await sendTelegramTestAlert();
      }

      if (result.success) {
        setStatus("success");
        setTimeout(() => setStatus("idle"), 4000);
      } else {
        setStatus("error");
        setErrorMessage(result.error || "Ошибка Telegram API");
        setTimeout(() => setStatus("idle"), 5000);
      }
    } catch (err: any) {
      setStatus("error");
      setErrorMessage(err.message || "Не удалось отправить");
      setTimeout(() => setStatus("idle"), 5000);
    }
  };

  if (variant === "compact") {
    return (
      <div className="relative inline-flex items-center" ref={menuRef}>
        <button
          onClick={(e) => triggerTest(lastSentType, e)}
          disabled={status === "loading"}
          title={errorMessage || `Отправить тестовый алерт (${lastSentType}) в Telegram`}
          className={`px-2 py-0.5 rounded-l text-[10px] font-mono font-bold flex items-center gap-1 transition-all cursor-pointer select-none border border-r-0 ${
            status === "loading"
              ? "bg-slate-800 text-slate-400 border-slate-700 cursor-wait"
              : status === "success"
              ? "bg-emerald-950/80 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
              : status === "error"
              ? "bg-rose-950/80 border-rose-500 text-rose-300"
              : "bg-blue-950/60 hover:bg-blue-900/80 text-blue-300 border-blue-500/40 hover:border-blue-400"
          } ${className}`}
        >
          {status === "loading" ? (
            <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
          ) : status === "success" ? (
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          ) : status === "error" ? (
            <AlertCircle className="h-3 w-3 text-rose-400" />
          ) : lastSentType === "choch" ? (
            <GitBranch className="h-3 w-3 text-emerald-400" />
          ) : lastSentType === "momentum" ? (
            <Zap className="h-3 w-3 text-amber-400" />
          ) : (
            <Send className="h-3 w-3 text-blue-400" />
          )}
          <span>
            {status === "loading"
              ? "TG..."
              : status === "success"
              ? "TG OK"
              : status === "error"
              ? "ERR"
              : lastSentType === "choch"
              ? "🔄 Тест CHoCH"
              : lastSentType === "momentum"
              ? "⚡️ Тест Импульс"
              : "🔔 Тест TG"}
          </span>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          className="px-1 py-0.5 rounded-r border border-l-slate-800 bg-blue-950/70 hover:bg-blue-900 text-blue-300 border-blue-500/40 text-[10px] cursor-pointer"
          title="Выбрать тип теста для Telegram"
        >
          <ChevronDown className="h-3 w-3" />
        </button>

        {menuOpen && (
          <div className="absolute top-full right-0 mt-1 z-50 w-52 bg-slate-900 border border-slate-800 rounded shadow-xl py-1 text-[11px] font-sans">
            <button
              onClick={(e) => triggerTest("choch", e)}
              className="w-full px-2.5 py-1.5 text-left flex items-center gap-2 hover:bg-slate-800 text-emerald-300 cursor-pointer"
            >
              <GitBranch className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span>🔄 Алерт: Слом структуры (CHoCH)</span>
            </button>
            <button
              onClick={(e) => triggerTest("momentum", e)}
              className="w-full px-2.5 py-1.5 text-left flex items-center gap-2 hover:bg-slate-800 text-amber-300 cursor-pointer"
            >
              <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span>⚡️ Алерт: Импульс (от 3%)</span>
            </button>
            <button
              onClick={(e) => triggerTest("ping", e)}
              className="w-full px-2.5 py-1.5 text-left flex items-center gap-2 hover:bg-slate-800 text-slate-300 cursor-pointer border-t border-slate-800"
            >
              <Bell className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span>🔔 Проверка связи</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative inline-flex items-center" ref={menuRef}>
      <button
        id="telegram-test-button"
        onClick={(e) => triggerTest(lastSentType, e)}
        disabled={status === "loading"}
        title={errorMessage || `Отправить проверочный алерт в Telegram (Chat ID: 395934082)`}
        className={`px-2.5 py-1 rounded-l text-xs font-mono font-bold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer select-none border border-r-0 ${
          status === "loading"
            ? "bg-slate-800 text-slate-400 border-slate-700 cursor-wait"
            : status === "success"
            ? "bg-emerald-950 border-emerald-400 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.5)]"
            : status === "error"
            ? "bg-rose-950 border-rose-500 text-rose-200 shadow-[0_0_10px_rgba(244,63,94,0.4)]"
            : "bg-blue-950/70 hover:bg-blue-900/80 text-blue-300 border-blue-500/40 hover:border-blue-400 hover:shadow-[0_0_8px_rgba(59,130,246,0.3)]"
        } ${className}`}
      >
        {status === "loading" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
            <span>Отправка...</span>
          </>
        ) : status === "success" ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 animate-bounce" />
            <span>✅ Алерт Отправлен!</span>
          </>
        ) : status === "error" ? (
          <>
            <AlertCircle className="h-3.5 w-3.5 text-rose-400" />
            <span>❌ Сбой TG</span>
          </>
        ) : lastSentType === "choch" ? (
          <>
            <GitBranch className="h-3.5 w-3.5 text-emerald-400" />
            <span>🔄 Тест: Слом структуры</span>
          </>
        ) : lastSentType === "momentum" ? (
          <>
            <Zap className="h-3.5 w-3.5 text-amber-400" />
            <span>⚡️ Тест: Импульс (≥3%)</span>
          </>
        ) : (
          <>
            <Send className="h-3.5 w-3.5 text-blue-400" />
            <span>🔔 Тест TG</span>
          </>
        )}
      </button>

      <button
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
        className="px-1.5 py-1 rounded-r border border-l-slate-800 bg-blue-950/70 hover:bg-blue-900 text-blue-300 border-blue-500/40 text-xs cursor-pointer flex items-center justify-center"
        title="Выбрать тип тестового алерта"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {menuOpen && (
        <div className="absolute top-full right-0 mt-1 z-50 w-60 bg-slate-900 border border-slate-800 rounded shadow-xl py-1 text-xs font-sans">
          <button
            onClick={(e) => triggerTest("choch", e)}
            className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-slate-800 text-emerald-300 cursor-pointer"
          >
            <GitBranch className="h-4 w-4 text-emerald-400 shrink-0" />
            <div>
              <div className="font-bold">🔄 Слом структуры (CHoCH 5m)</div>
              <div className="text-[10px] text-slate-400 font-mono">Подтвержденный слом телом свечи</div>
            </div>
          </button>
          <button
            onClick={(e) => triggerTest("momentum", e)}
            className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-slate-800 text-amber-300 cursor-pointer"
          >
            <Zap className="h-4 w-4 text-amber-400 shrink-0" />
            <div>
              <div className="font-bold">⚡️ Импульс цены (от 3.0%)</div>
              <div className="text-[10px] text-slate-400 font-mono">Резкое ускорение свечи ≥ 3%</div>
            </div>
          </button>
          <button
            onClick={(e) => triggerTest("ping", e)}
            className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-slate-800 text-slate-300 cursor-pointer border-t border-slate-800"
          >
            <Bell className="h-4 w-4 text-blue-400 shrink-0" />
            <div>
              <div className="font-bold">🔔 Проверка связи</div>
              <div className="text-[10px] text-slate-400 font-mono">Базовый пинг бота</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
