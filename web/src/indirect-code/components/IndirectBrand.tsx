/** Keep the original large mark and tightly aligned wordmark together. */
export function IndirectBrand() {
  return (
    <div class="rc-brand flex flex-col items-center justify-center min-w-0" aria-label="Indirect Code">
      <img src="/indirect-big-icon.svg" alt="" class="rc-brand-image w-auto shrink-0 object-contain" />
      <h1 class="rc-brand-name font-mono font-semibold tracking-wider text-ink-100 uppercase">INDIRECT</h1>
    </div>
  );
}
