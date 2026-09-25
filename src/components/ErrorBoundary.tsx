import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught error:", error, errorInfo);
  }

  handleReload = () => {
    try {
      localStorage.clear();
    } catch (e) {}
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-[#0B0E14] text-slate-200 flex flex-col items-center justify-center p-6 select-none font-sans">
          <div className="max-w-lg w-full bg-[#11141B] border border-rose-500/30 rounded-xl p-6 flex flex-col items-center text-center shadow-2xl">
            <div className="w-12 h-12 bg-rose-500/10 border border-rose-500/30 rounded-full flex items-center justify-center text-rose-400 mb-4">
              <AlertTriangle className="h-6 w-6" />
            </div>
            
            <h2 className="text-lg font-bold text-slate-100 mb-1">
              Произошла ошибка при загрузке терминала
            </h2>
            
            <p className="text-xs text-slate-400 mb-4 font-mono">
              {this.state.error?.message || "Неизвестная ошибка инициализации"}
            </p>

            <button
              onClick={this.handleReload}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-2 cursor-pointer shadow-lg shadow-cyan-950/40"
            >
              <RefreshCw className="h-4 w-4" />
              <span>Перезапустить терминал</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

