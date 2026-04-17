import { useEffect, useRef, useState } from "react";

export function Splitter(props: {
  onDrag: (deltaX: number) => void;
  onEnd?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const { onDrag, onEnd } = props;

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - startX.current;
      if (dx !== 0) {
        startX.current = e.clientX;
        onDrag(dx);
      }
    }
    function onUp() {
      setDragging(false);
      onEnd?.();
    }
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, onDrag, onEnd]);

  return (
    <div
      className={"splitter" + (dragging ? " dragging" : "")}
      onMouseDown={(e) => {
        e.preventDefault();
        startX.current = e.clientX;
        setDragging(true);
      }}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
