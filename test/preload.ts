// Bun test preload: warm the btdby4-wasm token estimator before any test
// file runs. Counters are synchronous after init; without this, the first
// countTextTokens() call would throw "not initialized".
import { initTokenEstimator } from "../server/tokens";

await initTokenEstimator();
