import { useState } from "react";
import type { AuthState } from "./useAuth";

// Compact sign-in card. Email/password only for now (no OAuth redirect flow
// in Electron yet — Google/Microsoft loopback OAuth is a follow-up). Rendered
// as a data-interactive panel so the overlay accepts clicks over it.
export function AuthPanel({ auth }: { auth: AuthState }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState(auth.lastEmail);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const passwordsMismatch =
    mode === "up" && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit =
    !busy &&
    !!email &&
    password.length >= 6 &&
    (mode === "in" || (confirmPassword.length >= 6 && !passwordsMismatch));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    if (mode === "in") await auth.signIn(email.trim(), password);
    else await auth.signUp(email.trim(), password);
    setBusy(false);
  };

  const input: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontSize: 13,
  };

  const switchMode = () => {
    setMode((m) => (m === "in" ? "up" : "in"));
    setConfirmPassword("");
    auth.clearError();
  };

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
        gap: 8,
        padding: 16,
        borderRadius: 14,
        background: "rgba(20,20,26,0.96)",
        color: "#fff",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        boxShadow: "0 6px 24px rgba(0,0,0,0.55)",
      }}
    >
      <strong style={{ fontSize: 15 }}>
        {mode === "in" ? "Welcome back" : "Create your account"}
      </strong>
      <span style={{ fontSize: 11, opacity: 0.65 }}>
        Sign in to save your pet to the cloud.
      </span>

      <input
        style={input}
        type="email"
        placeholder="email"
        value={email}
        autoFocus
        onChange={(e) => {
          setEmail(e.target.value);
          auth.clearError();
        }}
      />
      <input
        style={input}
        type="password"
        placeholder="password (min 6 chars)"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          auth.clearError();
        }}
        onKeyDown={(e) => e.key === "Enter" && mode === "in" && submit()}
      />
      {mode === "up" && (
        <input
          style={input}
          type="password"
          placeholder="confirm password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            auth.clearError();
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      )}
      {passwordsMismatch && (
        <span style={{ fontSize: 11, color: "#fca5a5" }}>Passwords don&apos;t match.</span>
      )}

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          opacity: 0.85,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={auth.rememberMe}
          onChange={(e) => auth.setRememberMe(e.target.checked)}
        />
        Remember me on this device
      </label>

      {auth.error && <span style={{ fontSize: 11, color: "#fca5a5" }}>{auth.error}</span>}
      {auth.notice && <span style={{ fontSize: 11, color: "#93c5fd" }}>{auth.notice}</span>}

      <button
        disabled={!canSubmit}
        onClick={submit}
        style={{
          cursor: canSubmit ? "pointer" : "default",
          border: "none",
          borderRadius: 8,
          padding: "9px 10px",
          fontSize: 14,
          fontWeight: 600,
          opacity: canSubmit ? 1 : 0.5,
          background: busy ? "rgba(52,211,153,0.4)" : "rgba(52,211,153,0.85)",
          color: "#062a1a",
        }}
      >
        {busy ? "…" : mode === "in" ? "Sign in" : "Sign up"}
      </button>

      <button
        onClick={switchMode}
        style={{
          cursor: "pointer",
          border: "none",
          background: "transparent",
          color: "#93c5fd",
          fontSize: 11,
        }}
      >
        {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>

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
