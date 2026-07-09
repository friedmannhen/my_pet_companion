import { useCallback, useEffect, useRef, useState } from "react";
import catIdle from "./assets/pets/black_cat/black_cat_adult.png";
import catBlink from "./assets/pets/black_cat/black_cat_adult_blink.png";

const PET_SIZE = 128;
const MARGIN = 16;
const WANDER_SPEED = 70; // px/sec

type Vec = { x: number; y: number };

function randomTarget(): Vec {
  return {
    x: MARGIN + Math.random() * (window.innerWidth - PET_SIZE - MARGIN * 2),
    y: MARGIN + Math.random() * (window.innerHeight - PET_SIZE - MARGIN * 2),
  };
}

/**
 * Overlay spike: one wandering, blinking, clickable cat over the desktop.
 * Proves the three risk items — transparency, always-on-top, and per-sprite
 * click-through toggling — before any real game code is written.
 */
export function App() {
  const petRef = useRef<HTMLDivElement>(null);
  const pos = useRef<Vec>({ x: 200, y: 200 });
  const target = useRef<Vec>(randomTarget());
  const pauseUntil = useRef(0);
  const [blinking, setBlinking] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [clickable, setClickable] = useState(false);
  const [hearts, setHearts] = useState<{ id: number; x: number; y: number }[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);

  // Wander loop — plain rAF lerp toward a random target with idle pauses.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (now >= pauseUntil.current) {
        const dx = target.current.x - pos.current.x;
        const dy = target.current.y - pos.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 4) {
          // Arrived: idle 4–12s, then pick a new destination.
          pauseUntil.current = now + 4000 + Math.random() * 8000;
          target.current = randomTarget();
        } else {
          const step = Math.min(WANDER_SPEED * dt, dist);
          pos.current.x += (dx / dist) * step;
          pos.current.y += (dy / dist) * step;
          if (Math.abs(dx) > 2) setFacingLeft(dx < 0);
        }
      }
      if (petRef.current) {
        petRef.current.style.transform = `translate(${pos.current.x}px, ${pos.current.y}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Blink loop — 3–7s randomized, occasional double-blink (matches hub widget feel).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setBlinking(true);
        setTimeout(() => {
          if (!alive) return;
          setBlinking(false);
          if (Math.random() < 0.2) {
            setTimeout(() => alive && setBlinking(true), 120);
            setTimeout(() => alive && setBlinking(false), 270);
          }
          schedule();
        }, 150);
      }, 3000 + Math.random() * 4000);
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // Hit-testing: the window is click-through everywhere except while the
  // cursor is over an element marked data-interactive (pet sprite, panel).
  // The main process streams the OS cursor position (window coords) at ~12Hz
  // because neither mouseenter nor raw mousemove reach an ignored window on
  // Win10 + Electron 33 despite { forward: true } (verified in this spike).
  const clickableRef = useRef(false);
  useEffect(() => {
    const off = window.overlay.onCursor(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const interactive = !!el?.closest("[data-interactive]");
      if (interactive !== clickableRef.current) {
        clickableRef.current = interactive;
        window.overlay.setClickable(interactive);
        setClickable(interactive);
      }
    });
    return off;
  }, []);

  const onPetClick = useCallback(() => {
    setPanelOpen((open) => !open);
    const id = Date.now();
    setHearts((hs) => [
      ...hs,
      { id, x: pos.current.x + PET_SIZE / 2, y: pos.current.y - 10 },
    ]);
    setTimeout(() => setHearts((hs) => hs.filter((h) => h.id !== id)), 1200);
  }, []);

  return (
    <>
      {/* Debug badge — display only, never interactive. */}
      <div
        style={{
          position: "fixed",
          top: 8,
          right: 8,
          padding: "4px 10px",
          borderRadius: 8,
          fontSize: 12,
          color: "#fff",
          background: clickable ? "rgba(16,120,60,0.85)" : "rgba(30,30,30,0.6)",
          pointerEvents: "none",
        }}
      >
        {clickable ? "interactive (over pet)" : "click-through"}
      </div>

      {hearts.map((h) => (
        <div
          key={h.id}
          style={{
            position: "fixed",
            left: h.x,
            top: h.y,
            fontSize: 24,
            pointerEvents: "none",
            animation: "float-up 1.2s ease-out forwards",
          }}
        >
          ❤️
        </div>
      ))}
      <style>{`@keyframes float-up { to { transform: translateY(-48px); opacity: 0; } }`}</style>

      <div
        ref={petRef}
        data-interactive
        style={{ position: "fixed", left: 0, top: 0, width: PET_SIZE }}
      >
        <img
          src={blinking ? catBlink : catIdle}
          width={PET_SIZE}
          height={PET_SIZE}
          draggable={false}
          onClick={onPetClick}
          style={{
            cursor: "pointer",
            transform: facingLeft ? "scaleX(-1)" : undefined,
            imageRendering: "auto",
          }}
          alt="pet"
        />
        {panelOpen && (
          <div
            style={{
              position: "absolute",
              top: PET_SIZE + 4,
              left: 0,
              display: "flex",
              gap: 6,
              padding: 8,
              borderRadius: 10,
              background: "rgba(25,25,30,0.9)",
              color: "#fff",
              fontSize: 13,
            }}
          >
            <span style={{ alignSelf: "center" }}>Midnight</span>
            <button onClick={() => setPanelOpen(false)} style={{ cursor: "pointer" }}>
              Close
            </button>
            <button onClick={() => window.overlay.quit()} style={{ cursor: "pointer" }}>
              Quit
            </button>
          </div>
        )}
      </div>
    </>
  );
}
