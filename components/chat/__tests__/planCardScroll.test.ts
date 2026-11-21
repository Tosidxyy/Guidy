import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionScrollDelta, scheduleActionReveal } from '../planCardScroll';

class ScrollTarget extends EventTarget {
  scrollTop = 0;
  clientTop = 0;
  clientHeight = 160;
  getBoundingClientRect() { return { top: 100, bottom: 260 }; }
}

const asElement = (value: object) => value as HTMLElement;
let frames: Map<number, FrameRequestCallback>;
let nextId: number;
const flushFrame = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((fn) => fn(0));
};

beforeEach(() => {
  frames = new Map();
  nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++nextId, fn); return nextId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('plan card scoped action reveal', () => {
  it('reveals the whole action row including padding, not the section heading', () => {
    expect(actionScrollDelta({ top: 100, bottom: 260 }, { top: 230, bottom: 280 })).toBe(28);
    expect(actionScrollDelta({ top: 100, bottom: 260 }, { top: 90, bottom: 122 })).toBe(-18);
    expect(actionScrollDelta({ top: 100, bottom: 260 }, { top: 110, bottom: 150 })).toBe(0);
  });

  it('uses RAF without requiring a transition (including reduced-motion) and stays scoped', () => {
    const scroller = new ScrollTarget();
    const body = new EventTarget();
    const row = { getBoundingClientRect: () => ({ top: 500 - scroller.scrollTop, bottom: 532 - scroller.scrollTop }) };
    const cancel = scheduleActionReveal(asElement(scroller), asElement(body), asElement(row), vi.fn());
    expect(scroller.scrollTop).toBe(0);
    flushFrame();
    expect(scroller.scrollTop).toBe(280);
    cancel();
  });

  it('rechecks after expansion/notice geometry changes and ignores child transitions', () => {
    const scroller = new ScrollTarget();
    const body = new EventTarget();
    let rowTop = 200;
    const row = { getBoundingClientRect: () => ({ top: rowTop - scroller.scrollTop, bottom: rowTop + 32 - scroller.scrollTop }) };
    const cancel = scheduleActionReveal(asElement(scroller), asElement(body), asElement(row), vi.fn());
    flushFrame();
    expect(scroller.scrollTop).toBe(0);
    rowTop = 400;
    const unrelated = new Event('transitionend');
    Object.defineProperty(unrelated, 'propertyName', { value: 'color' });
    body.dispatchEvent(unrelated);
    expect(frames.size).toBe(0);
    const expansion = new Event('transitionend');
    Object.defineProperty(expansion, 'propertyName', { value: 'grid-template-rows' });
    body.dispatchEvent(expansion);
    flushFrame();
    expect(scroller.scrollTop).toBe(180);
    cancel();
  });

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('yields permanently to deliberate %s input', (event) => {
    const scroller = new ScrollTarget();
    const body = new EventTarget();
    const row = { getBoundingClientRect: () => ({ top: 500, bottom: 532 }) };
    const onUserScroll = vi.fn();
    scheduleActionReveal(asElement(scroller), asElement(body), asElement(row), onUserScroll);
    scroller.dispatchEvent(new Event(event));
    flushFrame();
    expect(scroller.scrollTop).toBe(0);
    expect(onUserScroll).toHaveBeenCalledOnce();
    scroller.dispatchEvent(new Event(event));
    expect(onUserScroll).toHaveBeenCalledOnce();
  });

  it('cancels RAF and observers on close/replacement', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = disconnect; });
    const scroller = new ScrollTarget();
    const cancel = scheduleActionReveal(asElement(scroller), asElement(new EventTarget()), asElement({}), vi.fn());
    expect(observe).toHaveBeenCalledTimes(2);
    cancel();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    flushFrame();
    expect(scroller.scrollTop).toBe(0);
  });
});
