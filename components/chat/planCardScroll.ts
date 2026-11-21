/** Minimal scoped scroll: reveal the whole row, without scrolling the chat/page. */
export function actionScrollDelta(view: { top: number; bottom: number }, row: { top: number; bottom: number }, padding = 8): number {
  if (row.bottom > view.bottom - padding) return row.bottom - view.bottom + padding;
  if (row.top < view.top + padding) return row.top - view.top - padding;
  return 0;
}

/** One expansion/content-change session. User input permanently yields control until reopened. */
export function scheduleActionReveal(
  scroller: HTMLElement,
  body: HTMLElement,
  row: HTMLElement,
  onUserScroll: () => void,
): () => void {
  let cancelled = false;
  let frame = 0;
  const reveal = () => {
    if (cancelled) return;
    const rect = scroller.getBoundingClientRect();
    if (scroller.clientHeight <= 0) return;
    const top = rect.top + scroller.clientTop;
    const delta = actionScrollDelta({ top, bottom: top + scroller.clientHeight }, row.getBoundingClientRect());
    // Instant scrolling respects reduced motion and stops competing with user input.
    if (delta) scroller.scrollTop += delta;
  };
  const queue = () => {
    if (cancelled) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reveal);
  };
  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.target === body && e.propertyName === 'grid-template-rows') queue();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue);
  const cancel = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    body.removeEventListener('transitionend', onTransitionEnd);
    scroller.removeEventListener('wheel', yieldControl);
    scroller.removeEventListener('touchstart', yieldControl);
    scroller.removeEventListener('pointerdown', yieldControl);
    scroller.removeEventListener('keydown', yieldControl);
  };
  const yieldControl = () => { onUserScroll(); cancel(); };
  body.addEventListener('transitionend', onTransitionEnd);
  scroller.addEventListener('wheel', yieldControl, { passive: true });
  scroller.addEventListener('touchstart', yieldControl, { passive: true });
  scroller.addEventListener('pointerdown', yieldControl, { passive: true });
  scroller.addEventListener('keydown', yieldControl);
  observer?.observe(scroller);
  observer?.observe(row);
  // RAF handles reduced-motion/no-transition; transitionend handles expanded geometry.
  queue();
  return cancel;
}
