// The actual pet overlay + care loop. Only ever mounted while signed in
// (see App.tsx) — this repo is online-only by design (plan MVP decision),
// so no pet exists to render or play with before authentication.
//
// UI architecture (per design intent): the overlay shows ONLY the pet and a
// compact radial interaction menu, QA-hub-style — never a stats/data
// readout. All progress/history data lives in the separate stats window
// (stats/StatsApp.tsx, opened via the control strip's 📊 button).
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { AuthState } from "../supabase/useAuth";
import { usePetGame } from "./usePetGame";
import { useSessionLease } from "../session/useSessionLease";
import { AdminPanel } from "./AdminPanel";
import { RadialMenu, type RadialAction } from "./RadialMenu";
import catBaby from "../assets/pets/black_cat/black_cat_baby.png";
import catBabyBlink from "../assets/pets/black_cat/black_cat_baby_blink.png";
import catAdult from "../assets/pets/black_cat/black_cat_adult.png";
import catAdultBlink from "../assets/pets/black_cat/black_cat_adult_blink.png";
import catFinal from "../assets/pets/black_cat/black_cat_final.png";
import catFinalBlink from "../assets/pets/black_cat/black_cat_final_blink.png";
import catFinalSleep from "../assets/pets/black_cat/black_cat__final_sleep.png";

const SYNC_COLOR: Record<string, string> = {
  offline: "#9ca3af",
  loading: "#fbbf24",
  synced: "#34d399",
  error: "#f87171",
};

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

const SPRITES: Record<number, { idle: string; blink: string; sleep?: string }> = {
  1: { idle: catBaby, blink: catBabyBlink },
  2: { idle: catAdult, blink: catAdultBlink },
  3: { idle: catFinal, blink: catFinalBlink, sleep: catFinalSleep },
};

const chipStyle: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 7,
  padding: "4px 8px",
  fontSize: 11,
  background: "rgba(255,255,255,0.12)",
  color: "#fff",
};

export function GameView({ auth, clickable }: { auth: AuthState; clickable: boolean }) {
  const game = usePetGame(auth.userId);
  const lease = useSessionLease(auth.userId);
  const { save } = game;
  const petRef = useRef<HTMLDivElement>(null);
  const pos = useRef<Vec>({ x: 200, y: 200 });
  const target = useRef<Vec>(randomTarget());
  const pauseUntil = useRef(0);
  const [blinking, setBlinking] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [hearts, setHearts] = useState<{ id: number; emoji: string; x: number; y: number }[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const stationary = save.isSleeping || !save.isAlive || game.isEgg;

  // Wander loop — plain rAF lerp toward a random target with idle pauses.
  // Paused while the pet is an egg, sleeping, dead, or the radial menu is open.
  const wanderHalted = stationary || menuOpen;
  const wanderHaltedRef = useRef(wanderHalted);
  wanderHaltedRef.current = wanderHalted;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!wanderHaltedRef.current && now >= pauseUntil.current) {
        const dx = target.current.x - pos.current.x;
        const dy = target.current.y - pos.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 4) {
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

  // Blink loop — 3–7s randomized, occasional double-blink.
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

  // Hold-to-warm (hub-style egg mini-game): holding the pointer on the egg
  // pulses warmth/points every 200ms; a short press just no-ops (egg has no
  // radial menu — Stats is reached via the always-visible control strip).
  const [warming, setWarming] = useState(false);
  const holdRef = useRef<{ interval?: ReturnType<typeof setInterval>; heldLong: boolean }>({
    heldLong: false,
  });
  const gameRef = useRef(game);
  gameRef.current = game;

  const stopWarmHold = useCallback(() => {
    const hold = holdRef.current;
    if (hold.interval) clearInterval(hold.interval);
    hold.interval = undefined;
    setWarming(false);
  }, []);

  const startWarmHold = useCallback(() => {
    const hold = holdRef.current;
    hold.heldLong = false;
    if (hold.interval) clearInterval(hold.interval);
    hold.interval = setInterval(() => {
      if (!hold.heldLong) {
        hold.heldLong = true;
        gameRef.current.beginWarmSession();
        setWarming(true);
      }
      gameRef.current.warmTick();
    }, 200);
  }, []);

  const burst = useCallback((emoji: string) => {
    const id = Date.now() + Math.random();
    setHearts((hs) => [
      ...hs,
      { id, emoji, x: pos.current.x + PET_SIZE / 2, y: pos.current.y - 10 },
    ]);
    setTimeout(() => setHearts((hs) => hs.filter((h) => h.id !== id)), 1200);
  }, []);

  const act = useCallback(
    (fn: () => void, emoji: string) => {
      fn();
      burst(emoji);
    },
    [burst],
  );

  // Sprite selection: egg + dead are emoji (no cat art for those states yet).
  const stageSprites = SPRITES[save.evolutionStage];
  let visual: React.ReactNode;
  if (!save.isAlive) {
    visual = <span style={{ fontSize: 84, filter: "grayscale(1)" }}>🪦</span>;
  } else if (game.isEgg) {
    visual = <span style={{ fontSize: 84 }}>🥚</span>;
  } else if (stageSprites) {
    const src =
      save.isSleeping && stageSprites.sleep
        ? stageSprites.sleep
        : blinking || save.isSleeping
          ? stageSprites.blink
          : stageSprites.idle;
    visual = (
      <img
        src={src}
        width={PET_SIZE}
        height={PET_SIZE}
        draggable={false}
        style={{
          transform: facingLeft ? "scaleX(-1)" : undefined,
          filter: save.isSleeping ? "brightness(0.8)" : undefined,
        }}
        alt={save.name}
      />
    );
  }

  const needsAttention =
    save.isAlive &&
    !save.isSleeping &&
    ((game.isEgg ? save.warmth : save.hunger) < 25 || save.cleanliness < 25 || save.happiness < 25);

  const radialActions: RadialAction[] = [
    { key: "feed", icon: "🍖", label: "Feed", onClick: () => act(game.feed, "🍖"), disabled: save.isSleeping },
    { key: "wash", icon: "🧼", label: "Wash", onClick: () => act(game.wash, "🫧"), disabled: save.isSleeping },
    { key: "pet", icon: "🤗", label: "Pet", onClick: () => act(game.pet, "❤️"), disabled: save.isSleeping },
    { key: "ball", icon: "⚾", label: "Ball", onClick: () => act(game.throwBall, "⚾"), disabled: save.isSleeping },
    {
      key: "sleep",
      icon: save.isSleeping ? "☀️" : "🌙",
      label: save.isSleeping ? "Wake" : "Tuck in",
      onClick: game.toggleSleep,
    },
  ];
  if (game.canEvolve) {
    radialActions.push({
      key: "evolve",
      icon: "✨",
      label: "Evolve!",
      onClick: () => act(game.hatchOrEvolve, "✨"),
      highlight: true,
    });
  }

  const showRadial = !game.isEgg && save.isAlive && menuOpen;

  return (
    <>
      {/* Dev-only state badge — display only, never interactive. */}
      {import.meta.env.DEV && (
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
      )}

      {import.meta.env.DEV && <AdminPanel game={game} />}

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
          {h.emoji}
        </div>
      ))}
      <style>{`@keyframes float-up { to { transform: translateY(-48px); opacity: 0; } }`}</style>

      {/* Compact always-visible control strip — app/account controls, not game data. */}
      <div
        data-interactive
        style={{
          position: "fixed",
          bottom: 12,
          right: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderRadius: 10,
          background: "rgba(20,20,26,0.85)",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        <span
          title={game.syncError ?? game.syncStatus}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: SYNC_COLOR[game.syncStatus],
            flexShrink: 0,
          }}
        />
        {lease.status === "conflict" && (
          <button
            style={{ ...chipStyle, background: "rgba(248,113,113,0.35)" }}
            onClick={lease.forceTakeover}
            title={
              lease.conflict
                ? `Active on ${lease.conflict.deviceType} — click to take over here`
                : "Active elsewhere"
            }
          >
            ⚠️ Take over
          </button>
        )}
        <button style={chipStyle} onClick={() => window.overlay.openStats()}>
          📊 Stats
        </button>
        <button style={chipStyle} onClick={auth.signOut}>
          Sign out
        </button>
        <button style={{ ...chipStyle, opacity: 0.7 }} onClick={() => window.overlay.quit()}>
          Quit
        </button>
      </div>

      <div
        ref={petRef}
        data-interactive
        style={{ position: "fixed", left: 0, top: 0, width: PET_SIZE, height: PET_SIZE }}
      >
        {/* Status blips above the pet */}
        {save.isSleeping && save.isAlive && (
          <div style={{ position: "absolute", top: -18, left: 8, fontSize: 18, pointerEvents: "none" }}>
            💤
          </div>
        )}
        {needsAttention && (
          <div style={{ position: "absolute", top: -18, right: 8, fontSize: 18, pointerEvents: "none" }}>
            ❗
          </div>
        )}
        {(game.canHatch || game.canEvolve) && (
          <div style={{ position: "absolute", top: -18, left: 46, fontSize: 18, pointerEvents: "none" }}>
            ✨
          </div>
        )}

        <div
          // Egg: hold to warm. Hatched + alive: click toggles the radial menu.
          // Dead: click toggles the small "start over" bubble.
          onClick={game.isEgg ? undefined : () => setMenuOpen((o) => !o)}
          onPointerDown={game.isEgg && save.isAlive ? startWarmHold : undefined}
          onPointerUp={game.isEgg && save.isAlive ? stopWarmHold : undefined}
          onPointerLeave={game.isEgg && save.isAlive ? stopWarmHold : undefined}
          style={{
            cursor: "pointer",
            width: PET_SIZE,
            height: PET_SIZE,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            userSelect: "none",
          }}
        >
          {visual}
          {warming && (
            <div
              style={{
                position: "absolute",
                bottom: -6,
                left: "50%",
                transform: "translateX(-50%)",
                fontSize: 26,
                pointerEvents: "none",
                animation: "flame-pulse 0.5s ease-in-out infinite alternate",
              }}
            >
              🔥
            </div>
          )}
          <style>{`@keyframes flame-pulse { from { transform: translateX(-50%) scale(0.9); } to { transform: translateX(-50%) scale(1.15); } }`}</style>
        </div>

        <AnimatePresence>
          {showRadial && <RadialMenu key="radial" actions={radialActions} />}
        </AnimatePresence>

        {!save.isAlive && menuOpen && (
          <div
            data-interactive
            style={{
              position: "absolute",
              top: PET_SIZE + 6,
              left: -40,
              width: 210,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: 12,
              background: "rgba(22,22,28,0.94)",
              color: "#fff",
              fontFamily: "'Segoe UI', system-ui, sans-serif",
              fontSize: 13,
              boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
            }}
          >
            <span>{save.name} didn&apos;t make it… 💔</span>
            <button style={chipStyle} onClick={game.restart}>
              🥚 Start over
            </button>
          </div>
        )}
      </div>
    </>
  );
}
