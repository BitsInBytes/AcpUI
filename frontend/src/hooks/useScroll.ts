import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIStore } from '../store/useUIStore';

export function useScroll(activeSessionId: string | null, activeSessionMessages: unknown[] | undefined, visibleCount: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const isAutoScrollEnabledRef = useRef(true);
  const isAutoScrollDisabled = useUIStore(state => state.isAutoScrollDisabled);
  const toggleAutoScrollStore = useUIStore(state => state.toggleAutoScroll);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const lastScrollTop = useRef(0);

  const scrollToBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el) return;
    
    if (isAutoScrollDisabled && !force) return;

    if (force || isAutoScrollEnabledRef.current) {
      if (force) {
        isAutoScrollEnabledRef.current = true;
        setIsAutoScrollEnabled(true);
        setShowScrollButton(false);
      }
      setTimeout(() => {
        el.scrollTop = el.scrollHeight;
      }, 15);
    }
  }, [isAutoScrollDisabled]);

  const toggleAutoScroll = useCallback(() => {
    const wasDisabled = isAutoScrollDisabled;
    toggleAutoScrollStore();
    
    // If we are about to enable it (wasDisabled is true), scroll to bottom
    if (wasDisabled) {
      scrollToBottom(true);
    }
  }, [isAutoScrollDisabled, toggleAutoScrollStore, scrollToBottom]);

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
      if (isAutoScrollDisabled) setShowScrollButton(true);
    }

    lastScrollTop.current = el.scrollTop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0 && isAutoScrollEnabledRef.current) {
      isAutoScrollEnabledRef.current = false;
      setIsAutoScrollEnabled(false);
      if (isAutoScrollDisabled) setShowScrollButton(true);
    }
  };

   
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
