import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("VeilFlow application render failure", error, info.componentStack);
  }

  private resetWorkspace = () => {
    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith("vf-")) localStorage.removeItem(key);
      }
    } catch {
      // Reload still gives the application a chance to recover when storage is unavailable.
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#03060a", color: "#dbe8f5", fontFamily: "Inter, system-ui, sans-serif", padding: 24 }}>
        <section style={{ width: "min(620px, 100%)", border: "1px solid #26394c", borderRadius: 12, background: "#071019", padding: 24, boxShadow: "0 24px 80px rgba(0,0,0,.45)" }}>
          <small style={{ color: "#ff7895", letterSpacing: ".14em", fontWeight: 800 }}>VEILFLOW RECOVERY</small>
          <h1 style={{ margin: "8px 0 10px", fontSize: 22 }}>The terminal could not finish loading.</h1>
          <p style={{ margin: 0, color: "#91a4ba", lineHeight: 1.6 }}>A client-side state or rendering error was caught before it could leave you with a blank screen.</p>
          <pre style={{ margin: "16px 0", padding: 12, overflow: "auto", border: "1px solid #172433", borderRadius: 8, background: "#04080d", color: "#ff9eb2", fontSize: 12 }}>{this.state.error.message}</pre>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => window.location.reload()} style={{ padding: "10px 14px", border: "1px solid #2b455b", borderRadius: 7, background: "#0b1822", color: "#22d3e2", cursor: "pointer" }}>Reload</button>
            <button type="button" onClick={this.resetWorkspace} style={{ padding: "10px 14px", border: "1px solid rgba(255,91,127,.35)", borderRadius: 7, background: "#1a0b11", color: "#ff7895", cursor: "pointer" }}>Reset local workspace & reload</button>
          </div>
        </section>
      </main>
    );
  }
}
