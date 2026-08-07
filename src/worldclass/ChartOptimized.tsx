import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { MarketChart as BaseMarketChart } from "../worldclass/Chart";
import { buildFootprints } from "./footprint";
import type { FootprintCandle, MarketState, Trade } from "./types";

const MOBILE_QUERY = "(max-width: 820px), (pointer: coarse)";
const MOBILE_FRAME_INTERVAL_MS = 100;
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const RECENT_TRADE_CACHE_MS = 15_000;

type Props = ComponentProps<typeof BaseMarketChart>;

interface HyperliquidRecentTrade {
  coin?: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  tid?: number;
  hash?: string;
}

interface CachedTrades {
  loadedAt: number;
  trades: Trade[];
}

const recentTradeCache = new Map<string, CachedTrades>();
const recentTradeRequests = new Map<string, Promise<Trade[]>>();

function useMobileRuntime(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}

function mapRecentTrade(raw: HyperliquidRecentTrade, marketKey: string, providerSymbol: string, index: number): Trade | undefined {
  const price = Number(raw.px);
  const size = Number(raw.sz);
  const time = Number(raw.time);
  if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(time) || price <= 0 || size <= 0) return undefined;
  const coin = raw.coin ?? providerSymbol;
  const identity = raw.tid ?? raw.hash ?? index;
  return {
    id: `${time}-${coin}-${identity}`,
    sequence: typeof raw.tid === "number" ? raw.tid : undefined,
    exchangeTime: time,
    receiveTime: Date.now(),
    price,
    size,
    side: raw.side === "B" ? "buy" : "sell",
    notional: price * size,
    source: "backfill",
  };
}

async function fetchHyperliquidRecentTrades(state: MarketState): Promise<Trade[]> {
  const key = state.market.providerSymbol;
  const cached = recentTradeCache.get(key);
  if (cached && Date.now() - cached.loadedAt < RECENT_TRADE_CACHE_MS) return cached.trades;

  const pending = recentTradeRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(HYPERLIQUID_INFO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "recentTrades", coin: state.market.providerSymbol }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Hyperliquid recentTrades ${response.status}`);
      const rows = await response.json() as HyperliquidRecentTrade[];
      const trades = rows
        .map((row, index) => mapRecentTrade(row, state.market.key, state.market.providerSymbol, index))
        .filter((trade): trade is Trade => Boolean(trade))
        .sort((left, right) => left.exchangeTime - right.exchangeTime || (left.sequence ?? 0) - (right.sequence ?? 0));
      recentTradeCache.set(key, { loadedAt: Date.now(), trades });
      return trades;
    } finally {
      window.clearTimeout(timer);
      recentTradeRequests.delete(key);
    }
  })();

  recentTradeRequests.set(key, request);
  return request;
}

function useHyperliquidSeed(state: MarketState): { footprints: FootprintCandle[]; detail?: string } {
  const [trades, setTrades] = useState<Trade[]>([]);
  const marketKey = state.market.key;
  const provider = state.market.provider;
  const providerSymbol = state.market.providerSymbol;

  useEffect(() => {
    let disposed = false;
    if (provider !== "Hyperliquid") {
      setTrades([]);
      return () => { disposed = true; };
    }

    const cached = recentTradeCache.get(providerSymbol);
    if (cached) setTrades(cached.trades);

    void fetchHyperliquidRecentTrades(state)
      .then((rows) => { if (!disposed) setTrades(rows); })
      .catch(() => { if (!disposed && !cached) setTrades([]); });

    return () => { disposed = true; };
  }, [marketKey, provider, providerSymbol]);

  const firstCandle = state.candles[0];
  const lastCandle = state.candles.at(-1);
  const candleSignature = `${state.candles.length}:${firstCandle?.time ?? 0}:${lastCandle?.time ?? 0}:${lastCandle?.endTime ?? 0}:${lastCandle?.volume ?? 0}:${lastCandle?.close ?? 0}`;

  return useMemo(() => {
    if (provider !== "Hyperliquid" || !trades.length || !state.candles.length) return { footprints: [] };
    const firstTrade = trades[0];
    const lastTrade = trades.at(-1)!;
    const rebuilt = buildFootprints(
      state.market,
      state.timeframe,
      state.candles,
      trades,
      {
        source: "hyperliquid-live",
        startTime: firstTrade.exchangeTime,
        endTime: lastTrade.exchangeTime,
        contiguous: true,
        eventCount: trades.length,
        detail: `Seeded from ${trades.length.toLocaleString()} Hyperliquid recent public trades; closed candles become FULL only when execution volume reconciles to candle volume`,
      },
      lastTrade.exchangeTime,
      false,
    );
    return { footprints: rebuilt.footprints, detail: rebuilt.coverage.detail };
    // candleSignature deliberately replaces the frequently-copied candle array as the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, marketKey, state.market, state.timeframe, trades, candleSignature]);
}

function mergeSeededFootprints(state: MarketState, seeded: FootprintCandle[], seedDetail?: string): MarketState {
  if (!seeded.length) return state;
  const byTime = new Map<number, FootprintCandle>();
  for (const footprint of seeded) if (footprint.rows.length) byTime.set(footprint.time, footprint);

  for (const live of state.footprints) {
    const seed = byTime.get(live.time);
    if (!seed) {
      byTime.set(live.time, live);
      continue;
    }
    if (live.quality === "gapped") {
      byTime.set(live.time, live);
      continue;
    }
    if (live.rows.length && live.time >= (state.footprintCoverage.startTime ?? Number.POSITIVE_INFINITY)) {
      byTime.set(live.time, live);
      continue;
    }
    if (!seed.rows.length) byTime.set(live.time, live);
  }

  const footprints = state.candles.map((candle) => byTime.get(candle.time) ?? state.footprints.find((item) => item.time === candle.time)).filter((item): item is FootprintCandle => Boolean(item));
  const seededWithRows = seeded.filter((item) => item.rows.length);
  const earliest = seededWithRows[0]?.time;
  const latest = seededWithRows.at(-1)?.endTime;
  return {
    ...state,
    footprints,
    footprintCoverage: {
      ...state.footprintCoverage,
      startTime: earliest === undefined ? state.footprintCoverage.startTime : Math.min(state.footprintCoverage.startTime ?? earliest, earliest),
      endTime: latest === undefined ? state.footprintCoverage.endTime : Math.max(state.footprintCoverage.endTime ?? latest, latest),
      eventCount: Math.max(state.footprintCoverage.eventCount, seededWithRows.reduce((sum, item) => sum + item.tradeCount, 0)),
      detail: seedDetail ?? state.footprintCoverage.detail,
    },
  };
}

export function MarketChart(props: Props) {
  const mobile = useMobileRuntime();
  const latestState = useRef(props.state);
  latestState.current = props.state;

  const [sampledState, setSampledState] = useState(props.state);
  const [interactive, setInteractive] = useState(true);
  const seed = useHyperliquidSeed(props.state);

  useLayoutEffect(() => {
    if (!mobile) return;

    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    const targetRatio = Math.min(1.25, window.devicePixelRatio || 1);
    let patched = false;

    try {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        get: () => targetRatio,
      });
      patched = true;
      document.documentElement.classList.add("vf-mobile-low-dpr");
    } catch {
      // Some browsers expose a non-configurable devicePixelRatio. Throttling still protects performance.
    }

    return () => {
      document.documentElement.classList.remove("vf-mobile-low-dpr");
      if (!patched) return;
      try {
        if (originalDescriptor) Object.defineProperty(window, "devicePixelRatio", originalDescriptor);
        else Reflect.deleteProperty(window, "devicePixelRatio");
      } catch {
        // The page is unloading or the browser disallows restoring the descriptor.
      }
    };
  }, [mobile]);

  useEffect(() => {
    setInteractive(!mobile);
  }, [mobile, props.state.market.key]);

  useEffect(() => {
    if (!mobile) return;

    setSampledState(latestState.current);
    const timer = window.setInterval(() => {
      setSampledState((current) => current === latestState.current ? current : latestState.current);
    }, MOBILE_FRAME_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [mobile, props.state.market.key, props.state.timeframe]);

  const optimizedSettings = useMemo(() => {
    if (!mobile) return props.settings;
    return {
      ...props.settings,
      showVolume: false,
      showDepth: false,
      showLargeTrades: props.settings.showLargeTrades,
      footprintTicksPerRow: Math.max(25, props.settings.footprintTicksPerRow),
    };
  }, [mobile, props.settings]);

  const sampled = mobile ? sampledState : props.state;
  const chartState = useMemo(
    () => mergeSeededFootprints(sampled, seed.footprints, seed.detail),
    [sampled, seed.footprints, seed.detail],
  );

  return (
    <div className={`vf-chart-performance-shell ${mobile ? "vf-chart-performance-mobile" : ""}`}>
      <div className={`vf-chart-runtime ${mobile && !interactive ? "vf-chart-passive" : ""}`}>
        <BaseMarketChart
          {...props}
          state={chartState}
          settings={optimizedSettings}
        />
      </div>
      {mobile && (
        <button
          type="button"
          className={`vf-chart-gesture-toggle ${interactive ? "vf-active" : ""}`}
          onClick={() => setInteractive((current) => !current)}
          aria-pressed={interactive}
        >
          {interactive ? "Lock chart gestures" : "Enable chart gestures"}
        </button>
      )}
    </div>
  );
}
