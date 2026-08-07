import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { MarketChart as BaseMarketChart } from "../worldclass/Chart";

const MOBILE_QUERY = "(max-width: 820px), (pointer: coarse)";
const MOBILE_FRAME_INTERVAL_MS = 100;

type Props = ComponentProps<typeof BaseMarketChart>;

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

export function MarketChart(props: Props) {
  const mobile = useMobileRuntime();
  const latestState = useRef(props.state);
  latestState.current = props.state;

  const [sampledState, setSampledState] = useState(props.state);
  const [interactive, setInteractive] = useState(true);

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
      showLargeTrades: false,
      footprintTicksPerRow: Math.max(25, props.settings.footprintTicksPerRow),
    };
  }, [mobile, props.settings]);

  const chartState = mobile ? sampledState : props.state;

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
