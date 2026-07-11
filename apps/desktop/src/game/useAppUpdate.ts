// Surfaces the packaged app's version + auto-update state to the UI so
// updates are visible and actionable instead of silent — a small "vX.Y.Z"
// footer always shows, and a "restart to update" button appears once a
// downloaded update is ready. Installing only ever happens via that
// explicit button click (main process's autoInstallOnAppQuit is off) — see
// electron/main.ts's setupAutoUpdate comment for why: a silent
// install-on-quit raced badly with a quick manual relaunch and corrupted an
// install once (`ffmpeg.dll not found`).
import { useEffect, useState } from "react";

export interface AppUpdateState {
  /** Empty until the main process responds — render nothing until then. */
  version: string;
  updateState: "idle" | "checking" | "downloading" | "ready" | "error";
  updateVersion: string | null;
  /** 0-100 while downloading; null otherwise. */
  updatePercent: number | null;
  /** Set only when updateState === "error". */
  updateError: string | null;
  installUpdate: () => void;
}

export function useAppUpdate(): AppUpdateState {
  const [version, setVersion] = useState("");
  const [updateState, setUpdateState] = useState<AppUpdateState["updateState"]>("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.overlay.getAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    const off = window.overlay.onUpdateStatus(({ state, version: v, percent, message }) => {
      setUpdateState(state);
      setUpdateVersion(v ?? null);
      setUpdatePercent(state === "downloading" ? percent ?? null : null);
      setUpdateError(state === "error" ? message ?? "Update check failed" : null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return {
    version,
    updateState,
    updateVersion,
    updatePercent,
    updateError,
    installUpdate: () => window.overlay.installUpdate(),
  };
}
