import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIStore } from '../store/useUIStore';

export function useScroll(activeSessionId: string | null, activeSessionMessages: unknown[] | undefined, visibleCount: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const isAutoScrollEnabledRef = useRef(true);
  const isAutoScrollDisabled = useUIStore(state => state.isAutoScrollDisabled);
  const isAutoScrollDisabledRef = useRef(isAutoScrollDisabled);
  const toggleAutoScrollStore = useUIStore(state => state.toggleAutoScroll);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const lastScrollTop = useRef(0);
  const pendingScrollFrame = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    isAutoScrollDisabledRef.current = isAutoScrollDisabled;
  }, [isAutoScrollDisabled]);

  const snapToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el) return;

    if (isAutoScrollDisabledRef.current && !force) return;

    if (force || isAutoScrollEnabledRef.current) {
      if (force) {
        isAutoScrollEnabledRef.current = true;
        setIsAutoScrollEnabled(true);
        setShowScrollButton(false);
      }
      // Schedule the scroll for the next frame: requestAnimationFrame fires
      // after layout but before paint, so the new content and the scroll
      // land in the same frame — no visible dip below the prompt.
      if (pendingScrollFrame.current !== null) {
        cancelAnimationFrame(pendingScrollFrame.current);
      }
      pendingScrollFrame.current = requestAnimationFrame(() => {
        pendingScrollFrame.current = null;
        snapToBottom();
      });
    }
  }, [snapToBottom]);

  const toggleAutoScroll = useCallback(() => {
    const wasDisabled = isAutoScrollDisabledRef.current;
    toggleAutoScrollStore();

    // If we are about to enable it (wasDisabled is true), scroll to bottom
    if (wasDisabled) {
      scrollToBottom(true);
    }
  }, [toggleAutoScrollStore, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    const isScrollingUp = el.scrollTop < lastScrollTop.current;

    if (isAutoScrollEnabledRef.current !== isAtBottom) {
      isAutoScrollEnabledRef.current = isAtBottom;
      setIsAutoScrollEnabled(isAtBottom);
    }

    if (isAtBottom) {
      setShowScrollButton(false);
    } else if (isScrollingUp) {
      if (isAutoScrollDisabledRef.current) setShowScrollButton(true);
    }

    lastScrollTop.current = el.scrollTop;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0 && isAutoScrollEnabledRef.current) {
      isAutoScrollEnabledRef.current = false;
      setIsAutoScrollEnabled(false);
      if (isAutoScrollDisabledRef.current) setShowScrollButton(true);
    }
  }, []);

  // Observe content growth and pin the scroll to the bottom while auto-scroll
  // is on. This catches rapid layout changes — large tool outputs, multiple
  // timeline steps committed in the same frame, code blocks finishing
  // syntax-highlighting — that can outpace the explicit scrollToBottom calls
  // driven by message/state updates. The ResizeObserver callback fires after
  // layout but before paint, so we snap in the same frame the content grew
  // and the user never sees the bubble dip below the prompt.
  //
  // The observer is created once (stable callback closure, no GC churn) and
  // its observed target is swapped on session change — avoids the brief
  // observation gap that would occur if we tore down and rebuilt the observer.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (isAutoScrollDisabledRef.current) return;
      if (!isAutoScrollEnabledRef.current) return;
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    });
    resizeObserverRef.current = ro;
    return () => {
      ro.disconnect();
      resizeObserverRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ro = resizeObserverRef.current;
    if (!ro) return;
    const el = scrollRef.current;
    if (!el) return;
    const content = el.firstElementChild;
    if (!content) return;
    ro.observe(content);
    return () => ro.disconnect();
  }, [activeSessionId]);

  useEffect(() => () => {
    if (pendingScrollFrame.current !== null) {
      cancelAnimationFrame(pendingScrollFrame.current);
    }
  }, []);

  useEffect(() => {
    if (activeSessionId) {
      scrollToBottom(true);
    }
  }, [activeSessionId, scrollToBottom]);

  useEffect(() => {
    if (activeSessionId) {
      scrollToBottom(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionMessages, visibleCount, scrollToBottom]);

  return {
    scrollRef,
    isAutoScrollEnabled,
    setIsAutoScrollEnabled,
    isAutoScrollEnabledRef,
    isManualScrollDisabled: isAutoScrollDisabled,
    toggleAutoScroll,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    handleWheel
  };
}
