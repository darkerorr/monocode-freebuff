import React, { useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
// TEMPORARY: remove with src/debugMonoScroll.ts.
if (import.meta.env.DEV) void import("./debugMonoScroll");
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  activateWindowAppearance,
  initAppearance,
} from "./features/settings/model/appearance";
import { initSounds } from "./features/settings/model/sounds";
import {
  abortQuit,
  askQuitConfirmation,
  commitQuit,
  loadBootWorkspace,
  reportQuitPoll,
} from "./app/model/appLifecycle";
import { homeDir } from "./platform/tauri/fs";
import { setHomeDir } from "./shared/lib/paths";
import { installNativeContextMenuGuard } from "./shared/lib/nativeContextMenu";
import { consumeInstalledUpdate } from "./app/model/updateNotice";
import { initializeProviderBinaryPaths } from "./features/providers/model/providerBinaryPaths";
// Lets file commands reach a connected machine for `remote://` paths.
import "./features/connections/model/remoteCommands";
import "./styles/index.css";

performance.mark("monocode:bootstrap");
// Let local boot IPC overlap loading/evaluating the workspace UI.
const appLoaded = import("./app/App");

initAppearance();
initSounds();
installNativeContextMenuGuard();
// Prime the real home directory before the first render so every `~/` file
// reference resolves consistently. The IPC call is local and failures remain
// best-effort, falling back to inference from a session's cwd.
const homeDirPrimed = homeDir()
  .then(setHomeDir)
  .catch(() => {});
const providerBinaryPathsPrimed = initializeProviderBinaryPaths().catch(
  () => undefined,
);

function dismissBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash || splash.dataset.dismissed === "1") return;
  splash.dataset.dismissed = "1";
  const fade = () => {
    activateWindowAppearance();
    splash.classList.add("boot-splash-out");
    window.setTimeout(() => {
      splash.remove();
      performance.mark("monocode:ui-ready");
      performance.measure("monocode:navigation-to-ui", {
        start: 0,
        end: "monocode:ui-ready",
      });
    }, 180);
  };
  // useLayoutEffect runs before paint. Two frames later the app is on
  // screen, so the fade reveals UI instead of the desktop blur.
  requestAnimationFrame(() => {
    requestAnimationFrame(fade);
  });
}

function BootGate({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    dismissBootSplash();
  }, []);
  return children;
}

void listen<number>("quit_poll", (event) => {
  void reportQuitPoll(event.payload);
});
// Scoped to this window on purpose: a global `listen` is registered as `Any`,
// which Tauri matches for every event regardless of the emitter's target, so
// one dialog would become one per window.
void getCurrentWebviewWindow().listen<{ id: number; inFlight: number }>(
  "quit_confirm",
  (event) => {
    void askQuitConfirmation(event.payload.id, event.payload.inFlight);
  },
);
void listen<number>("quit_commit", (event) => {
  void commitQuit(event.payload);
});
void listen("quit_aborted", () => {
  abortQuit();
});

const root = document.getElementById("root");
if (!root) throw new Error("MonoCode could not find its application root.");
const reactRoot = ReactDOM.createRoot(root);

function renderWorkspace(
  boot: Awaited<ReturnType<typeof loadBootWorkspace>>,
  App: (typeof import("./app/App"))["default"],
) {
  performance.mark("monocode:workspace-ready");
  const installedUpdate = boot.windowTransfer ? null : consumeInstalledUpdate();
  reactRoot.render(
    <React.StrictMode>
      <BootGate>
        <App
          windowTransfer={boot.windowTransfer}
          resumed={boot.resumed}
          installedUpdate={installedUpdate}
          history={boot.history}
          historyCwd={boot.historyCwd}
        />
      </BootGate>
    </React.StrictMode>,
  );
}

// Show the workspace as soon as it is available; local home/provider lookups
// are best-effort startup enrichment and must not keep the whole app behind
// the splash screen.
const bootWorkspace = loadBootWorkspace().catch((error: unknown) => {
  console.error("MonoCode could not restore its workspace; opening a new workspace.", error);
  return {
    windowTransfer: null,
    resumed: null,
    history: [],
    historyCwd: null,
  };
});
void Promise.all([appLoaded, bootWorkspace]).then(
  ([{ default: App }, boot]) => renderWorkspace(boot, App),
  (error: unknown) => {
    console.error("MonoCode could not load its workspace UI.", error);
    const splash = document.getElementById("boot-splash");
    if (splash) {
      splash.replaceChildren();
      splash.style.pointerEvents = "auto";
      const message = document.createElement("p");
      message.textContent = "MonoCode failed to start. Restart the app and check its logs.";
      message.style.cssText = "max-width:32rem;padding:2rem;color:#fca5a5;font:14px/1.5 system-ui;text-align:center";
      splash.append(message);
    }
  },
);
void Promise.all([homeDirPrimed, providerBinaryPathsPrimed]).catch(
  (error: unknown) => {
    console.warn("MonoCode startup enrichment failed.", error);
  },
);
