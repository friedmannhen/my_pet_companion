// Online-only gate (MVP decision): nothing pet-related exists or renders
// until the player is signed in — no local-only play. GameView is only
// mounted once a session exists, so usePetGame (and its wander/tick loops)
// never runs for a signed-out user.
import { useAuth } from "./supabase/useAuth";
import { AuthPanel } from "./supabase/AuthPanel";
import { GameView } from "./game/GameView";
import { useHitTest } from "./overlay/useHitTest";

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-interactive
      style={{
        position: "fixed",
        top: 24,
        left: 24,
        width: 260,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        borderRadius: 14,
        background: "rgba(20,20,26,0.96)",
        color: "#fff",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontSize: 12,
        boxShadow: "0 6px 24px rgba(0,0,0,0.55)",
      }}
    >
      {children}
      <button
        onClick={() => window.overlay.quit()}
        style={{
          alignSelf: "flex-end",
          cursor: "pointer",
          border: "none",
          borderRadius: 8,
          padding: "4px 10px",
          fontSize: 11,
          background: "rgba(255,255,255,0.12)",
          color: "#fff",
          opacity: 0.7,
        }}
      >
        Quit
      </button>
    </div>
  );
}

export function App() {
  const auth = useAuth();
  // Must run unconditionally here (not inside GameView) — every screen
  // (auth card, loading, error) needs click-through toggling to work, not
  // just the signed-in pet overlay.
  const clickable = useHitTest();

  if (!auth.configured) {
    return (
      <CenteredCard>
        <strong>Backend not configured</strong>
        <p style={{ opacity: 0.75, marginTop: 6 }}>
          Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. This app is
          online-only — set apps/desktop/.env and restart.
        </p>
      </CenteredCard>
    );
  }

  if (auth.loading) {
    return <CenteredCard>Checking session…</CenteredCard>;
  }

  if (!auth.session) {
    return <AuthPanel auth={auth} />;
  }

  return <GameView auth={auth} clickable={clickable} />;
}
