// Web Audio API synthesised sounds — no audio files required. Ported
// verbatim from ERP_QA_HUB src/utils/petSounds.ts. Every caller gates on the
// sound setting itself (see useGamePrefs) — these functions always play.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => null);
  }
  return ctx;
}

function tone(freq: number, type: OscillatorType, duration: number, vol = 0.25, delay = 0) {
  const ac = getCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + delay);
  gain.gain.setValueAtTime(0, ac.currentTime + delay);
  gain.gain.linearRampToValueAtTime(vol, ac.currentTime + delay + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + delay + duration);
  osc.start(ac.currentTime + delay);
  osc.stop(ac.currentTime + delay + duration + 0.05);
}

export function playNom() {
  tone(523, "square", 0.07, 0.2);
  tone(659, "square", 0.07, 0.2, 0.1);
  tone(523, "square", 0.07, 0.15, 0.2);
}

export function playSplash() {
  tone(900, "sine", 0.08, 0.15);
  tone(650, "sine", 0.12, 0.15, 0.07);
  tone(400, "sine", 0.18, 0.12, 0.15);
}

export function playSqueak() {
  tone(880, "sine", 0.12, 0.2);
  tone(1100, "sine", 0.1, 0.15, 0.1);
}

export function playHungry() {
  tone(220, "triangle", 0.3, 0.2);
  tone(196, "triangle", 0.4, 0.18, 0.35);
}

export function playEvolution() {
  [262, 330, 392, 523, 659, 784, 1046].forEach((f, i) => {
    tone(f, "square", 0.14, 0.25, i * 0.1);
  });
}

export function playDeath() {
  [440, 370, 330, 262, 196].forEach((f, i) => {
    tone(f, "sawtooth", 0.25, 0.2, i * 0.18);
  });
}

/** Soft boing — used when clicking/tapping the pet.
 *  A smooth sine glide: low → high → settle, no noise, gentle volume. */
export function playSwish() {
  const ac = getCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = "sine";
  // Frequency arc: 280 → 740 → 520 Hz — spring-like boing
  osc.frequency.setValueAtTime(280, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(740, ac.currentTime + 0.07);
  osc.frequency.exponentialRampToValueAtTime(520, ac.currentTime + 0.2);
  // Soft attack + gentle decay
  gain.gain.setValueAtTime(0, ac.currentTime);
  gain.gain.linearRampToValueAtTime(0.16, ac.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.24);
  osc.start(ac.currentTime);
  osc.stop(ac.currentTime + 0.26);
}
