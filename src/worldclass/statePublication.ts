import type { FootprintCoverage, FootprintCandle, MarketState, Candle, Trade } from "./types";

export interface PublicationDirty {
  candles: boolean;
  trades: boolean;
  footprints: boolean;
}

export interface PublishedCollections {
  candles: Candle[];
  trades: Trade[];
  footprints: FootprintCandle[];
  footprintCoverage: FootprintCoverage;
}

export function createPublicationDirty(value = false): PublicationDirty {
  return { candles: value, trades: value, footprints: value };
}

export function markPublicationDirty(dirty: PublicationDirty, changes: Partial<PublicationDirty>): void {
  if (changes.candles) dirty.candles = true;
  if (changes.trades) dirty.trades = true;
  if (changes.footprints) dirty.footprints = true;
}

export function publishedCollectionsFromState(state: MarketState): PublishedCollections {
  return {
    candles: state.candles,
    trades: state.trades,
    footprints: state.footprints,
    footprintCoverage: state.footprintCoverage,
  };
}

export function preparePublishedCollections(
  previous: PublishedCollections,
  model: MarketState,
  dirty: PublicationDirty,
): PublishedCollections {
  return {
    candles: dirty.candles ? model.candles.slice() : previous.candles,
    trades: dirty.trades ? model.trades.slice() : previous.trades,
    footprints: dirty.footprints ? model.footprints.slice() : previous.footprints,
    footprintCoverage: dirty.footprints ? { ...model.footprintCoverage } : previous.footprintCoverage,
  };
}
