import { type ReactNode, useEffect, useRef } from "react";

export function MobileKeyboardAware({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    const element = ref.current;
    if (!viewport || !element) return;

    const updateKeyboardHeight = () => {
      const keyboardHeight = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      element.style.setProperty("--mobile-keyboard-height", `${keyboardHeight}px`);
    };

    updateKeyboardHeight();
    viewport.addEventListener("resize", updateKeyboardHeight);
    viewport.addEventListener("scroll", updateKeyboardHeight);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardHeight);
      viewport.removeEventListener("scroll", updateKeyboardHeight);
    };
  }, []);

  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col" data-mobile-keyboard-aware>
      {children}
    </div>
  );
}
