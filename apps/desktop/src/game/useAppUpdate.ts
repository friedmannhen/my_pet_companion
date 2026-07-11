// Surfaces the packaged app's version + auto-update state to the UI so
// updates are visible and actionable instead of silent — a small "vX.Y.Z"
// footer always shows, and a "restart to update" button appears once a
// downloaded update is ready (electron-updater's autoInstallOnAppQuit stays
// on underneath as a fallback if the user ignores the button and just quits
// normally).
import { useEffect, useState } from "react";

export interface AppUpdateState {
  /** Empty until the main process responds — render nothing until then. */
  version: string;
  updateState: "idle" | "downloading" | "ready";
  updateVersion: string | null;
  installUpdate: () => void;
}

export function useAppUpdate(): AppUpdateState {
  const [version, setVersion] = useState("");
  const [updateState, setUpdateState] = useState<"idle" | "downloading" | "ready">("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.overlay.getAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    const off = window.overlay.onUpdateStatus(({ state, version: v }) => {
      setUpdateState(state);
      setUpdateVersion(v);
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
    installUpdate: () => window.overlay.installUpdate(),
  };
}
