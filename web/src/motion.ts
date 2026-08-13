import USAL from "usal";

/**
 * USAL bootstrap — imported for side effects by the app entry.
 *
 * USAL v2 observes the DOM reactively (MutationObserver + IntersectionObserver),
 * so Solid-mounted nodes (route changes, resource resolutions) animate
 * automatically, no manual restarts.
 *
 *  - once:true + forwards:true  → entrances run a single time and the final
 *    state is retained (no replay/re-hide on scroll).
 *  - prefers-reduced-motion     → durations collapse to ~instant instead of
 *    animating (deterministic — USAL never leaves elements hidden).
 */

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

USAL.config({
  defaults: {
    animation: "fade",
    direction: "u",
    duration: reduceMotion ? 1 : 1000,
    delay: 100,
    threshold: 10,
    splitDelay: reduceMotion ? 0 : 30,
    forwards: true,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    blur: false,
  },
  observersDelay: 50,
  once: true,
});

/**
 * Spread helper for Solid JSX: <div {...usal("fade-u delay-100")} />.
 * Plain attribute passthrough — USAL parses the tokens itself.
 */
export function usal(value: string): { "data-usal": string } {
  return { "data-usal": value };
}

/** Staggered container: children cascade in. */
export function usalItems(
  value = "fade-u",
  stagger = 60,
): { "data-usal": string } {
  return usal(`split-item ${value} split-delay-${stagger} threshold-5`);
}

/** Count-up from 0 to `target` (raw integer, locale-formatted). */
export function usalCount(target: number): { "data-usal": string } {
  const formatted = Math.round(Math.max(0, target)).toLocaleString("en-US");
  return usal(`count-[${formatted}] duration-1000`);
}

export { USAL };
