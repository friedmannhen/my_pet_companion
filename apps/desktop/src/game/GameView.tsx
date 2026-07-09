// The actual pet overlay + care loop. Only ever mounted while signed in
// (see App.tsx) — this repo is online-only by design (plan MVP decision),
// so no pet exists to render or play with before authentication.
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PET_RULES } from "@pet/core";
import type { AuthState } from "../supabase/useAuth";
import { usePetGame } from "./usePetGame";
import { AdminPanel } from "./AdminPanel";
import catBaby from "../assets/pets/black_cat/black_cat_baby.png";
import catBabyBlink from "../assets/pets/black_cat/black_cat_baby_blink.png";
import catAdult from "../assets/pets/black_cat/black_cat_adult.png";
import catAdultBlink from "../assets/pets/black_cat/black_cat_adult_blink.png";
import catFinal from "../assets/pets/black_cat/black_cat_final.png";
import catFinalBlink from "../assets/pets/black_cat/black_cat_final_blink.png";
import catFinalSleep from "../assets/pets/black_cat/black_cat__final_sleep.png";

const SYNC_LABEL: Record<string, { text: string; color: string }> = {
  offline: { text: "● local only", color: "#9ca3af" },
  loading: { text: "● syncing…", color: "#fbbf24" },
  synced: { text: "● cloud synced", color: "#34d399" },
  error: { text: "● sync error", color: "#f87171" },
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

function StatBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span style={{ width: 62, textAlign: "right", opacity: 0.85 }}>{label}</span>
      <div
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          background: "rgba(255,255,255,0.15)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round(value)}%`,
            height: "100%",
            borderRadius: 4,
            background: color,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <span style={{ width: 26, opacity: 0.7 }}>{Math.round(value)}</span>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  cursor: "pointer",
  border: "none",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 13,
  background: "rgba(255,255,255,0.12)",
  color: "#fff",
};

export function GameView({ auth }: { auth: AuthState }) {
  const game = usePetGame(auth.userId);
  const { save } = game;
  const petRef = useRef<HTMLDivElement>(null);
  const pos = useRef<Vec>({ x: 200, y: 200 });
  const target = useRef<Vec>(randomTarget());
  const pauseUntil = useRef(0);
  const [blinking, setBlinking] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [clickable, setClickable] = useState(false);
  const [hearts, setHearts] = useState<{ id: number; emoji: string; x: number; y: number }[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);

  const stationary = save.isSleeping || !save.isAlive || game.isEgg;

  // Wander loop — plain rAF lerp toward a random target with idle pauses.
  // Paused while the pet is an egg, sleeping, dead, or its panel is open.
  const wanderHalted = stationary || panelOpen;
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

  // Hit-testing: the window is click-through everywhere except while the
  // cursor is over an element marked data-interactive. The main process
  // streams the OS cursor position (~12Hz) because neither mouseenter nor raw
  // mousemove reach an ignored window on Win10 + Electron 33 despite
  // { forward: true } (verified in the overlay spike).
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

  // Hold-to-warm (hub-style egg mini-game): holding the pointer on the egg
  // pulses warmth/points every 200ms; a short press just toggles the panel.
  const [warming, setWarming] = useState(false);
  const holdRef = useRef<{ interval?: ReturnType<typeof setInterval>; heldLong: boolean }>({
    heldLong: false,
  });
  const gameRef = useRef(game);
  gameRef.current = game;

  const stopWarmHold = useCallback((togglePanelOnTap: boolean) => {
    const hold = holdRef.current;
    if (hold.interval) clearInterval(hold.interval);
    hold.interval = undefined;
    setWarming(false);
    if (togglePanelOnTap && !hold.heldLong) setPanelOpen((o) => !o);
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
    (fn: () => void, emoji: string) => () => {
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

      <div
        ref={petRef}
        data-interactive
        style={{ position: "fixed", left: 0, top: 0, width: PET_SIZE }}
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
          // Egg: hold to warm (tap = panel). Hatched pet: click = panel.
          onClick={game.isEgg && save.isAlive ? undefined : () => setPanelOpen((o) => !o)}
          onPointerDown={game.isEgg && save.isAlive ? startWarmHold : undefined}
          onPointerUp={game.isEgg && save.isAlive ? () => stopWarmHold(true) : undefined}
          onPointerLeave={game.isEgg && save.isAlive ? () => stopWarmHold(false) : undefined}
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

        {panelOpen && (
          <div
            style={{
              position: "absolute",
              top: PET_SIZE + 6,
              left: -60,
              width: 250,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: 12,
              background: "rgba(22,22,28,0.94)",
              color: "#fff",
              fontFamily: "'Segoe UI', system-ui, sans-serif",
              boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong style={{ fontSize: 14 }}>{save.name}</strong>
              <span style={{ fontSize: 11, opacity: 0.7 }}>
                {["Egg", "Baby", "Adult", "Final"][save.evolutionStage]}
                {" · "}
                {Math.floor(save.carePoints)}
                {game.nextThreshold !== null && ` / ${game.nextThreshold}`} pts
              </span>
            </div>

            <div style={{ fontSize: 10, opacity: 0.6, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span>
                Age {Math.max(0, Math.floor((Date.now() - new Date(save.birthDate).getTime()) / 86_400_000))}d
              </span>
              <span>🍖 {save.feedCount}</span>
              <span>🧼 {save.washCount}</span>
              <span>🤗 {save.petCount}</span>
              <span>⚾ {save.throwBallCount}</span>
            </div>

            {save.isSleeping && save.sleepKind === "manual" && save.sleepStartedAt && (
              <div style={{ fontSize: 11, color: "#93c5fd" }}>
                🛡️ Protected sleep:{" "}
                {Math.max(
                  0,
                  Math.ceil(
                    (new Date(save.sleepStartedAt).getTime() +
                      DEFAULT_PET_RULES.sleep.protectedMaxMs -
                      Date.now()) /
                      3_600_000,
                  ),
                )}
                h left
              </div>
            )}

            {!save.isAlive ? (
              <>
                <div style={{ fontSize: 13, opacity: 0.9 }}>
                  {save.name} didn&apos;t make it… 💔
                </div>
                <button style={btnStyle} onClick={game.restart}>
                  🥚 Start over
                </button>
              </>
            ) : (
              <>
                {game.isEgg ? (
                  <StatBar label="Warmth" value={save.warmth} color="#f59e0b" />
                ) : (
                  <StatBar label="Hunger" value={save.hunger} color="#ef4444" />
                )}
                <StatBar label="Clean" value={save.cleanliness} color="#38bdf8" />
                <StatBar label="Happy" value={save.happiness} color="#a78bfa" />
                {/* Evolution progress */}
                <StatBar
                  label={save.evolutionStage >= 3 ? "Max" : "Next form"}
                  value={game.evolutionProgress * 100}
                  color="#34d399"
                />

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {game.isEgg ? (
                    <span style={{ fontSize: 11, opacity: 0.75, alignSelf: "center" }}>
                      🔥 Press and hold the egg to warm it
                    </span>
                  ) : (
                    <>
                      <button style={btnStyle} onClick={act(game.feed, "🍖")} disabled={save.isSleeping}>
                        🍖 Feed
                      </button>
                      <button style={btnStyle} onClick={act(game.wash, "🫧")} disabled={save.isSleeping}>
                        🧼 Wash
                      </button>
                      <button style={btnStyle} onClick={act(game.pet, "❤️")} disabled={save.isSleeping}>
                        🤗 Pet
                      </button>
                      <button style={btnStyle} onClick={act(game.throwBall, "⚾")} disabled={save.isSleeping}>
                        ⚾ Ball
                      </button>
                    </>
                  )}
                  {(game.canHatch || game.canEvolve) && (
                    <button
                      style={{ ...btnStyle, background: "rgba(52,211,153,0.35)" }}
                      onClick={act(game.hatchOrEvolve, "✨")}
                    >
                      ✨ {game.canHatch ? "Hatch!" : "Evolve!"}
                    </button>
                  )}
                  {!game.isEgg && (
                    <button style={btnStyle} onClick={game.toggleSleep}>
                      {save.isSleeping ? "☀️ Wake" : "🌙 Tuck in"}
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Account + sync status */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 10,
                opacity: 0.8,
                borderTop: "1px solid rgba(255,255,255,0.08)",
                paddingTop: 6,
              }}
            >
              <span
                style={{ color: SYNC_LABEL[game.syncStatus]?.color }}
                title={game.syncError ?? undefined}
              >
                {SYNC_LABEL[game.syncStatus]?.text}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ opacity: 0.6, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {auth.email}
                </span>
                <button style={{ ...btnStyle, fontSize: 10, padding: "2px 6px" }} onClick={auth.signOut}>
                  Sign out
                </button>
              </span>
            </div>
            {game.syncStatus === "error" && game.syncError && (
              <div style={{ fontSize: 10, color: "#fca5a5", wordBreak: "break-word" }}>
                {game.syncError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
              <button
                style={{ ...btnStyle, fontSize: 11, padding: "4px 8px" }}
                onClick={() => setPanelOpen(false)}
              >
                Close
              </button>
              <button
                style={{ ...btnStyle, fontSize: 11, padding: "4px 8px", opacity: 0.7 }}
                onClick={() => window.overlay.quit()}
              >
                Quit
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
