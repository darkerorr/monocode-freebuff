import {
  Check,
  ChevronDown,
  ChevronRight,
  Gauge,
  Search,
  Star,
  RotateCcw,
  Zap,
} from "../../../shared/ui/icons";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  coerceModelPickerTab,
  getModelSnapshot,
  getPickerVisibilitySnapshot,
  isEffortSettingId,
  loadFavoriteModels,
  loadRecentModelChoices,
  saveFavoriteModels,
  showProviderInModelPicker,
  subscribeModels,
  subscribePickerVisibility,
  type AgentModel,
  type ModelPickerTab,
  type ModelSetting,
} from "../model/models";
import {
  isProviderHidden,
  projectProvidersRevision,
  subscribeProjectProviders,
} from "../model/projectProviders";
import {
  harnessUnavailableHint,
  subscribeHarnessAvailability,
  getHarnessAvailabilitySnapshot,
} from "../../../integrations/harness/core/availability";
import { useModelSource, type ModelSource } from "./modelSource";
import {
  getFreebuffAccountSnapshot,
  subscribeFreebuffAccount,
  type FreebuffAccountSnapshot,
} from "../../providers/model/freebuffAccount";
import { FREEBUFF_SESSION_MODEL } from "../model/models";
import {
  getActiveFreebuffSessionId,
  listFreebuffModels,
  selectFreebuffModel,
} from "../../../integrations/harness/providers/freebuff/freebuff";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../model/session";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { LAYER } from "../../../shared/lib/layers";
import { HarnessIcon } from "./HarnessIcon";
import { Popover } from "../../../shared/ui/Popover";
import { MOD } from "../../../platform/tauri/platform";
import { keybindingPressed } from "../../settings/model/settings";
import "./ModelPicker.css";

type Props = {
  harness: HarnessId;
  model: string;
  values: Record<string, string>;
  /** Project whose disabled providers are hidden from the picker. */
  project?: string;
  /** Running session whose Freebuff PTY controls the interactive model list. */
  sessionId?: string;
  /** Hide option rows from the menu when they render as pills beside the picker. */
  hideSettings?: boolean;
  /** Limit provider tabs for surfaces that only support one harness. */
  allowedHarnesses?: readonly HarnessId[];
  hotkeys?: boolean;
  /** Which way the menus open; the composer sits low, so they open up. */
  side?: "top" | "bottom";
  /**
   * `plain` drops the pill for rows like a details panel's property list;
   * `text` is just the provider and name, for a quiet row beneath a chat
   * input.
   */
  variant?: Variant;
  /** Action label for recovery surfaces that open the same model chooser. */
  triggerLabel?: string;
  /**
   * Classes for the trigger's text, so a narrow surface can hide it and keep
   * just the icon; the button's label still names the choice.
   */
  labelClassName?: string;
  onChange: (harness: HarnessId, model: string) => void;
  onSettingsChange: (settings: Record<string, string>) => void;
  onClose?: () => void;
};

type Variant = "pill" | "plain" | "text";

type MenuEntry = { kind: "setting"; setting: ModelSetting } | { kind: "model" };

type Submenu = { kind: "setting"; setting: ModelSetting } | { kind: "models" };

type RecentMenu = { models: AgentModel[] };

type ModelGroup = {
  id: string;
  name?: string;
  models: Array<{ item: AgentModel; index: number }>;
};

const MENU_WIDTH = 250;
const MODEL_MENU_WIDTH = 310;
const SETTING_MENU_WIDTH = 210;
const SUBMENU_OVERLAP = -4;
const SELF = "[data-model-picker]";

const PROVIDER_TAB_SIZE = 32;
const PROVIDER_TAB_GAP = 4;
const PROVIDER_RAIL_PADDING = 12;
const MODEL_MENU_HEIGHT =
  (HARNESSES.length + 1) * PROVIDER_TAB_SIZE +
  HARNESSES.length * PROVIDER_TAB_GAP +
  PROVIDER_RAIL_PADDING;
const MODEL_MENU_FRAME_HEIGHT = MODEL_MENU_HEIGHT + 2;

const SETTING_ORDER = [
  "fast",
  "lead",
  "effort",
  "sidekick",
  "reasoning",
  "reasoningEffort",
  "serviceTier",
  "thinking",
  "variant",
  "agent",
  "context",
];

/** Toolbar pill order: reasoning level first, then the remaining controls. */
const PILL_ORDER = [
  "effort",
  "reasoning",
  "reasoningEffort",
  "variant",
  "lead",
  "sidekick",
  "fast",
  "thinking",
  "serviceTier",
  "context",
];

function isEffortSetting(setting: ModelSetting): boolean {
  return isEffortSettingId(setting.id);
}

function effortTileTone(
  setting: ModelSetting,
  value: string,
): "ultra" | "max" | undefined {
  if (!isEffortSetting(setting)) return undefined;
  const normalized = value.toLowerCase();
  return normalized === "ultra"
    ? "ultra"
    : normalized === "max"
      ? "max"
      : undefined;
}

const EFFORT_TILE_COLUMNS = 32;
const EFFORT_TILE_ROWS = 5;

function EffortTileShimmer() {
  return (
    <span className="codex-effort-tiles" aria-hidden="true">
      {Array.from(
        { length: EFFORT_TILE_COLUMNS * EFFORT_TILE_ROWS },
        (_, index) => {
          const column = index % EFFORT_TILE_COLUMNS;
          const row = Math.floor(index / EFFORT_TILE_COLUMNS);
          const centerColumn = (EFFORT_TILE_COLUMNS - 1) / 2;
          const centerRow = (EFFORT_TILE_ROWS - 1) / 2;
          const distance = Math.hypot(
            (column - centerColumn) / centerColumn,
            (row - centerRow) / centerRow,
          );
          const filled = (index * 73 + index * index * 19 + 23) % 101 < 65;
          return (
            <span
              key={index}
              className={`codex-effort-tile${filled ? " codex-effort-tile--filled" : ""}`}
              style={{ "--tile-distance": distance } as React.CSSProperties}
            />
          );
        },
      )}
    </span>
  );
}

function effortSetting(model: AgentModel): ModelSetting | undefined {
  return model.settings?.find(
    (setting) => setting.kind === "select" && isEffortSetting(setting),
  );
}

function pickerSettings(model: AgentModel): ModelSetting[] {
  return [...menuVisibleSettings(model)].sort((a, b) => {
    const ai = SETTING_ORDER.indexOf(a.id);
    const bi = SETTING_ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

/** Settings without the OpenCode agent row, which never shows in the menu. */
function menuVisibleSettings(model: AgentModel): ModelSetting[] {
  return (model.settings ?? []).filter(
    (setting) => !(model.harness === "opencode" && setting.id === "agent"),
  );
}

/** Standalone toolbar pills, reasoning level first. */
function pillSettings(model: AgentModel): ModelSetting[] {
  return [...menuVisibleSettings(model)].sort((a, b) => {
    const ai = PILL_ORDER.indexOf(a.id);
    const bi = PILL_ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function settingLabel(setting: ModelSetting): string {
  return setting.id === "effort" || setting.id === "reasoning"
    ? "Effort"
    : setting.label;
}

function settingValue(
  setting: ModelSetting,
  values: Record<string, string>,
): string {
  return values[setting.id] ?? setting.value;
}

function settingValueLabel(
  setting: ModelSetting,
  values: Record<string, string>,
): string {
  const value = settingValue(setting, values);
  return (
    setting.options.find((option) => option.value === value)?.label ?? value
  );
}

function recentMenuModels(
  current: AgentModel,
  source: ModelSource,
): AgentModel[] {
  const models = loadRecentModelChoices().flatMap((choice) => {
    const item = source.find(choice.model);
    return item?.harness === choice.harness ? [item] : [];
  });
  if (!models.some((item) => item.id === current.id)) models.push(current);
  return models.slice(0, 6);
}

/** Harness tabs whose catalog names upstream providers list models under them. */
function groupsByProvider(tab: ModelPickerTab, models: AgentModel[]): boolean {
  return tab !== "favorites" && models.some((item) => item.provider);
}

/** Use the upstream provider when present, otherwise the model's harness. */
function modelProvider(item: AgentModel): { id: string; name: string } {
  return (
    item.provider ?? { id: item.harness, name: HARNESS_TITLE[item.harness] }
  );
}

/**
 * Keeps each provider's models contiguous (in first-seen provider order) so
 * keyboard navigation, which walks this list, matches the grouped headings.
 */
function inProviderOrder(
  tab: ModelPickerTab,
  models: AgentModel[],
): AgentModel[] {
  if (!groupsByProvider(tab, models)) return models;
  const groups = new Map<string, AgentModel[]>();
  for (const item of models) {
    const id = modelProvider(item).id;
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return [...groups.values()].flat();
}

/** Build provider headings while retaining each model's keyboard navigation index. */
function modelGroups(tab: ModelPickerTab, models: AgentModel[]): ModelGroup[] {
  if (!groupsByProvider(tab, models)) {
    return [
      {
        id: "models",
        models: models.map((item, index) => ({ item, index })),
      },
    ];
  }

  const groups = new Map<string, ModelGroup>();
  models.forEach((item, index) => {
    const provider = modelProvider(item);
    let group = groups.get(provider.id);
    if (!group) {
      group = { id: provider.id, name: provider.name, models: [] };
      groups.set(provider.id, group);
    }
    group.models.push({ item, index });
  });
  return [...groups.values()];
}

/** The Freebuff model is selected inside its terminal, not by MonoCode. */
function useFreebuffAccount(): FreebuffAccountSnapshot {
  return useSyncExternalStore(
    subscribeFreebuffAccount,
    getFreebuffAccountSnapshot,
    getFreebuffAccountSnapshot,
  );
}

function FreebuffSessionContent({
  currentId,
  preferredSessionId,
  available,
  onPick,
}: {
  currentId: string;
  preferredSessionId?: string;
  available: boolean;
  onPick: (model: AgentModel) => void;
}) {
  const account = useFreebuffAccount();
  const [changingModel, setChangingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelListError, setModelListError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [controlSessionId, setControlSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<FreebuffAccountSnapshot["models"]["value"]>(null);

  const refreshModels = useCallback(() => {
    const targetSessionId = getActiveFreebuffSessionId(preferredSessionId);
    setModelError(null);
    setModelListError(null);
    setModels(null);
    if (!targetSessionId) {
      setControlSessionId(null);
      setModelListError("No active Freebuff session. Start one in MonoCode to read its /model choices.");
      return;
    }
    setControlSessionId(targetSessionId);
    setLoadingModels(true);
    void listFreebuffModels(targetSessionId)
      .then((nextModels) => setModels(nextModels))
      .catch((error: unknown) => {
        setModelListError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoadingModels(false));
  }, [preferredSessionId]);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  return (
    <div className="p-2">
      <FreebuffModelDisplay account={account} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-content/45">
          Models are read live from Freebuff&apos;s own <code>/model</code> picker.
        </p>        <button
          type="button"
          aria-label="Refresh Freebuff models"
          title="Refresh Freebuff models"
          disabled={!available || loadingModels || changingModel}
          onMouseDown={(event) => event.preventDefault()}


          onClick={refreshModels}
          className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/5 disabled:opacity-40"
        >
          <RotateCcw
            className={`size-3.5 ${loadingModels ? "animate-spin" : ""}`}
          />
        </button>
      </div>
      {loadingModels ? (
        <p role="status" className="mt-1 text-[11px] text-content/50">
          Reading models from the active Freebuff terminal…
        </p>
      ) : null}
      {models?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Available Freebuff models">
          {models.map((item) => (
            <button
              key={item.name}
              type="button"
              disabled={!available || !controlSessionId || changingModel || loadingModels}
              aria-pressed={item.selected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setChangingModel(true);
                setModelError(null);
                if (!controlSessionId) {
                  setModelError("No active Freebuff session is available to apply this model.");
                  return;
                }
                void selectFreebuffModel(controlSessionId, item.name)
                  .then(() => {
                    setModels((current) => current?.map((choice) => ({
                      ...choice,
                      selected: choice.name === item.name,
                    })) ?? null);
                    if (currentId !== FREEBUFF_SESSION_MODEL.id) {
                      onPick(FREEBUFF_SESSION_MODEL);
                    }
                  })
                  .catch((error: unknown) => {
                    setModelError(error instanceof Error ? error.message : String(error));
                  })
                  .finally(() => setChangingModel(false));
              }}
              className="rounded-md border border-content/10 px-2 py-1 text-[11px] text-content/70 hover:bg-content/5 disabled:opacity-40"
              title={item.descriptors.join(" · ") || undefined}
            >
              {item.name}{item.effort ? ` · ${item.effort}` : ""}{item.selected ? " (current)" : ""}
            </button>
          ))}
        </div>
      ) : !loadingModels && !modelListError ? (
        <p className="mt-1 text-[11px] text-content/45">
          No model choices have been read from an active Freebuff terminal yet.
        </p>
      ) : null}
      {modelListError ? (
        <p role="alert" className="mt-1 text-[11px] text-red-400">
          {modelListError}
        </p>
      ) : null}
      {changingModel ? (
        <p role="status" className="mt-1 text-[11px] text-content/50">
          Waiting for Freebuff to confirm the model change…
        </p>
      ) : null}
      {modelError ? (
        <p role="alert" className="mt-1 text-[11px] text-red-400">
          {modelError}
        </p>
      ) : null}
      {account.context.value ||
      account.dailyHours.value ||
      account.sessionLeftMinutes.value != null ? (
        <div className="mt-2 space-y-1 border-t border-stroke pt-2 text-[11px] text-content/55">
          {account.context.value ? (
            <div>
              Context used: {account.context.value.label} (
              {account.context.value.percent}%) · max capacity not reported
            </div>
          ) : null}
          {account.dailyHours.value ? (
            <div>
              Balance: {account.dailyHours.value.remaining} /{" "}
              {account.dailyHours.value.limit} hours remaining
            </div>
          ) : null}
          {account.sessionLeftMinutes.value != null ? (
            <div>Session time: {account.sessionLeftMinutes.value} min left</div>
          ) : null}
        </div>
      ) : null}
      {currentId !== FREEBUFF_SESSION_MODEL.id ? (
        <button
          type="button"
          disabled={!available}
          title={!available ? harnessUnavailableHint("freebuff") : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(FREEBUFF_SESSION_MODEL)}
          className="mt-2 flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-[12px] text-content/75 hover:bg-content/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Use Freebuff for this session
          <Check className="size-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/** Freebuff's model selector belongs to the CLI, not MonoCode's catalog. */
function FreebuffModelDisplay({
  labelClassName = "",
  account,
}: {
  labelClassName?: string;
  account: FreebuffAccountSnapshot;
}) {
  const model = account.model.value;

  return (
    <span
      className={`flex min-w-0 shrink-0 items-center gap-1.5 text-content/75 ${labelClassName}`}
      title="Model reported by the active Freebuff terminal."
      aria-live="polite"
      aria-label={
        model
          ? `Freebuff model: ${model.name}`
          : "Freebuff model not yet reported"
      }
    >
      <HarnessIcon harness="freebuff" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {model?.name ?? FREEBUFF_SESSION_MODEL.name}
      </span>
      {model?.effort ? (
        <span className="shrink-0 text-content/50">{model.effort}</span>
      ) : null}
    </span>
  );
}

type CatalogProps = Props & { freebuffAccount?: FreebuffAccountSnapshot };

/** Preserve the regular chooser for Freebuff sessions while observing its CLI-owned model. */
export function ModelPicker(props: Props) {
  return props.harness === "freebuff" ? (
    <FreebuffAwareModelPicker {...props} />
  ) : (
    <CatalogModelPicker {...props} />
  );
}

function FreebuffAwareModelPicker(props: Props) {
  const account = useFreebuffAccount();
  return <CatalogModelPicker {...props} freebuffAccount={account} />;
}

/** Model selection and settings control shared by the composer and session toolbar. */
function CatalogModelPicker({
  harness,
  model,
  values,
  project,
  hideSettings = false,
  allowedHarnesses,
  hotkeys = false,
  side = "top",
  variant = "pill",
  triggerLabel,
  labelClassName = "",
  onChange,
  onSettingsChange,
  onClose,
  freebuffAccount,
  sessionId,
}: CatalogProps) {
  const source = useModelSource();
  const catalogVersion = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  );
  const availabilityVersion = useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const visibilityVersion = useSyncExternalStore(
    subscribePickerVisibility,
    getPickerVisibilitySnapshot,
    getPickerVisibilitySnapshot,
  );
  const projectVersion = useSyncExternalStore(
    subscribeProjectProviders,
    projectProvidersRevision,
    projectProvidersRevision,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ModelPickerTab>(harness);
  const [active, setActive] = useState(0);
  const [activeModel, setActiveModel] = useState(0);
  const [activeSetting, setActiveSetting] = useState(0);
  const [recentMenu, setRecentMenu] = useState<RecentMenu | null>(null);
  const [recentActive, setRecentActive] = useState(0);
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const [activeRow, setActiveRow] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const recentMenuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const recentOpenRef = useRef(recentMenu != null);
  const currentRef = useRef<AgentModel | null>(null);
  const lastHotkey = useRef(0);
  onCloseRef.current = onClose;
  openRef.current = open;
  recentOpenRef.current = recentMenu != null;

  const resolvedCurrent = source.resolve(harness, model);
  const freebuffActiveModel = freebuffAccount?.model.value ?? null;
  const current =
    harness === "freebuff"
      ? {
          ...FREEBUFF_SESSION_MODEL,
          name: freebuffActiveModel?.name ?? FREEBUFF_SESSION_MODEL.name,
        }
      : resolvedCurrent;
  currentRef.current = current;
  const settings = useMemo(() => {
    void catalogVersion;
    // In beside-picker mode every option row renders as a toolbar pill, so the
    // menu lists models only. Freebuff settings stay in its own terminal.
    return hideSettings || harness === "freebuff"
      ? []
      : pickerSettings(current);
  }, [catalogVersion, current, harness, hideSettings]);
  const entries = useMemo<MenuEntry[]>(
    () => [
      ...settings.map((setting) => ({
        kind: "setting" as const,
        setting,
      })),
      { kind: "model" as const },
    ],
    [settings],
  );

  const triggerEffortSetting =
    hideSettings || harness === "freebuff" ? undefined : effortSetting(current);
  const triggerEffortLabel = triggerEffortSetting
    ? settingValueLabel(triggerEffortSetting, values)
    : undefined;
  const triggerModelName =
    harness === "freebuff"
      ? (freebuffActiveModel?.name ?? current.name)
      : current.harness === "claude"
        ? current.name.replace(/^Claude /, "")
        : current.name;
  const triggerTitle = [
    HARNESS_TITLE[current.harness],
    current.provider?.name,
    harness === "freebuff"
      ? (freebuffActiveModel?.name ?? current.name)
      : current.name,
    harness === "freebuff" ? freebuffActiveModel?.effort : triggerEffortLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const pickerHarnesses = useMemo(() => {
    void availabilityVersion;
    void visibilityVersion;
    void projectVersion;
    return HARNESSES.filter(
      (id) =>
        (!allowedHarnesses || allowedHarnesses.includes(id)) &&
        !isProviderHidden(project, id) &&
        showProviderInModelPicker(id, source.available(id), source.probed()),
    );
  }, [
    source,
    allowedHarnesses,
    availabilityVersion,
    visibilityVersion,
    projectVersion,
    project,
  ]);
  const providerKey = pickerHarnesses.join(",");
  const visibleTab = coerceModelPickerTab(tab, (id) =>
    pickerHarnesses.includes(id),
  );

  const visibleModels = useMemo(() => {
    void catalogVersion;
    const needle = query.trim().toLowerCase();
    const pool =
      visibleTab === "favorites"
        ? favorites
            .map((id) => source.find(id))
            .filter(
              (item): item is AgentModel =>
                item != null && pickerHarnesses.includes(item.harness),
            )
        : source.modelsFor(visibleTab);
    const matches = needle
      ? pool.filter((item) =>
          `${item.name} ${HARNESS_TITLE[item.harness]} ${item.provider?.name ?? ""} ${item.provider?.id ?? ""}`
            .toLowerCase()
            .includes(needle),
        )
      : pool;
    return inProviderOrder(visibleTab, matches);
  }, [source, catalogVersion, favorites, providerKey, query, visibleTab]);

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setRecentMenu(null);
    setSubmenu(null);
    if (restore) onCloseRef.current?.();
  };

  const togglePicker = () => {
    if (openRef.current) dismiss(true);
    else {
      setRecentMenu(null);
      setOpen(true);
    }
  };

  const openRecentMenu = () => {
    const selected = currentRef.current;
    if (!selected) return;
    const models = recentMenuModels(selected, source);
    const selectedIndex = models.findIndex((item) => item.id === selected.id);
    setOpen(false);
    setSubmenu(null);
    setRecentActive(selectedIndex >= 0 ? selectedIndex : 0);
    setRecentMenu({ models });
  };

  const toggleRecentMenu = () => {
    if (recentOpenRef.current) {
      setRecentMenu(null);
      onCloseRef.current?.();
    } else {
      openRecentMenu();
    }
  };

  const toggleFromHotkey = () => {
    const now = performance.now();
    if (now - lastHotkey.current < 80) return;
    lastHotkey.current = now;
    toggleRecentMenu();
  };

  useEffect(() => {
    if (!open) return;
    source.refresh([current.harness]);
    setTab(
      coerceModelPickerTab(current.harness, (id) =>
        pickerHarnesses.includes(id),
      ),
    );
    setActive(0);
    // Beside-picker mode leaves only the Model row; open its list directly
    // instead of making it one more hover step.
    setSubmenu(hideSettings ? { kind: "models" } : null);
    setQuery("");
    setFavorites(loadFavoriteModels());
  }, [open, current.harness, hideSettings]);

  useEffect(() => {
    if (visibleTab === tab) return;
    setTab(visibleTab);
  }, [tab, visibleTab]);

  useEffect(() => {
    if (!open || submenu?.kind !== "models" || visibleTab === "favorites") {
      return;
    }
    source.refresh([visibleTab]);
  }, [open, submenu?.kind, visibleTab]);

  useEffect(() => {
    if (!open) return;
    setActive((index) => Math.min(index, Math.max(0, entries.length - 1)));
  }, [entries.length, open]);

  useEffect(() => {
    if (!open || submenu?.kind !== "models") return;
    const index = visibleModels.findIndex((item) => item.id === current.id);
    setActiveModel(index >= 0 ? index : 0);
  }, [open, submenu?.kind, query, visibleModels, current.id]);

  useEffect(() => {
    if (submenu?.kind !== "setting") return;
    const value = settingValue(submenu.setting, values);
    const index = submenu.setting.options.findIndex(
      (option) => option.value === value,
    );
    setActiveSetting(index >= 0 ? index : 0);
  }, [submenu, values]);

  useEffect(() => {
    const inBlockingUi = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".monocode-terminal")) return true;
      return Boolean(
        target.closest(
          "[data-file-picker], [data-branch-picker], [data-skill-picker], [data-mention-picker], [data-access-picker], [data-model-control]",
        ),
      );
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const mod = event.metaKey || event.ctrlKey;
      const defaultSwitch =
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "." || event.code === "Period");
      if (
        hotkeys &&
        keybindingPressed("App: Switch Model", event, defaultSwitch)
      ) {
        if (!openRef.current && inBlockingUi(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleFromHotkey();
        return;
      }
      if (!openRef.current || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };

    const onMenu = () => {
      if (!hotkeys) return;
      if (inBlockingUi(document.activeElement)) return;
      toggleFromHotkey();
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("open_model_picker", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("open_model_picker", onMenu);
    };
  }, [hotkeys, source]);

  const setSetting = (setting: ModelSetting, value: string) => {
    onSettingsChange({ ...values, [setting.id]: value });
  };

  const pickModel = (item: AgentModel) => {
    if (!source.available(item.harness)) return;
    onChange(item.harness, item.id);
    dismiss(true);
  };

  useEffect(() => {
    if (!recentMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setRecentActive(
          (index) =>
            (index + direction + recentMenu.models.length) %
            recentMenu.models.length,
        );
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      const item = recentMenu.models[recentActive];
      if (item) pickModel(item);
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recentActive, recentMenu]);

  const pickSetting = (setting: ModelSetting, value: string) => {
    setSetting(setting, value);
    dismiss(true);
  };

  const toggleFavorite = (id: string) => {
    setFavorites((previous) => {
      const next = previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id];
      saveFavoriteModels(next);
      return next;
    });
  };

  const selectTab = (next: ModelPickerTab) => {
    setTab(next);
    setQuery("");
    setActiveModel(0);
  };

  const showEntrySubmenu = (entry: MenuEntry) => {
    if (entry.kind === "model") {
      setSubmenu({ kind: "models" });
      return;
    }
    if (entry.setting.kind === "select") {
      setSubmenu({ kind: "setting", setting: entry.setting });
      return;
    }
    setSubmenu(null);
  };

  const moveEntry = (direction: 1 | -1) => {
    setSubmenu(null);
    setActive((index) => (index + direction + entries.length) % entries.length);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (submenu?.kind === "models") {
        setActiveModel((index) =>
          Math.min(visibleModels.length - 1, index + 1),
        );
      } else if (submenu?.kind === "setting") {
        setActiveSetting((index) =>
          Math.min(submenu.setting.options.length - 1, index + 1),
        );
      } else {
        moveEntry(1);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (submenu?.kind === "models") {
        setActiveModel((index) => Math.max(0, index - 1));
      } else if (submenu?.kind === "setting") {
        setActiveSetting((index) => Math.max(0, index - 1));
      } else {
        moveEntry(-1);
      }
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const entry = entries[active];
      if (entry) showEntrySubmenu(entry);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSubmenu(null);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (submenu?.kind === "models") {
      const item = visibleModels[activeModel];
      if (item) pickModel(item);
      return;
    }
    if (submenu?.kind === "setting") {
      const option = submenu.setting.options[activeSetting];
      if (option) pickSetting(submenu.setting, option.value);
      return;
    }
    const entry = entries[active];
    if (!entry) return;
    if (entry.kind === "model" || entry.setting.kind === "select") {
      showEntrySubmenu(entry);
      return;
    }
    const value = settingValue(entry.setting, values);
    setSetting(entry.setting, value === "true" ? "false" : "true");
  };

  const showSubmenu =
    open &&
    submenu != null &&
    activeRow != null &&
    activeRow.dataset.modelControlIndex === String(active);

  return (
    <>
      <button
        ref={button}
        type="button"
        title={
          triggerLabel
            ? `${triggerLabel} · ${triggerTitle}`
            : `${triggerTitle} · Recent models: right-click or ${MOD}.`
        }
        aria-label={
          triggerLabel ??
          `${HARNESS_TITLE[current.harness]}${
            current.provider ? `, ${current.provider.name},` : ""
          } ${current.name}${
            triggerEffortLabel ? `, effort ${triggerEffortLabel}` : ""
          }`
        }
        aria-keyshortcuts={`${MOD}.`}
        aria-expanded={open || recentMenu != null}
        aria-haspopup={
          hideSettings || harness === "freebuff" ? "dialog" : "menu"
        }
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openRecentMenu();
        }}
        onClick={() => togglePicker()}
        className={
          variant === "text"
            ? textControlClass(open, "shrink-0 gap-1.5")
            : variant === "plain"
              ? `-mx-1.5 flex h-7 shrink-0 items-center gap-2 rounded-md px-1.5 text-[12px] text-content/85 ${
                  open ? "bg-content/8" : "hover:bg-content/6"
                }`
              : `flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 ${
                  open
                    ? "bg-selection text-content"
                    : "bg-selection text-content hover:bg-selection-hover"
                }`
        }
      >
        <HarnessIcon
          harness={current.harness}
          className={`${variant === "pill" ? "size-4" : "size-3.5"} shrink-0`}
        />
        <span
          className={`whitespace-nowrap ${variant === "pill" ? "text-[11px]" : ""} ${labelClassName}`}
        >
          {harness === "freebuff"
            ? triggerModelName
            : (triggerLabel ?? triggerModelName)}
        </span>
        {!triggerLabel &&
        (harness === "freebuff"
          ? freebuffActiveModel?.effort
          : triggerEffortLabel) ? (
          <span
            className={`shrink-0 text-content/50 ${variant === "pill" ? "text-[11px]" : ""} ${labelClassName}`}
          >
            {harness === "freebuff"
              ? freebuffActiveModel?.effort
              : triggerEffortLabel}
          </span>
        ) : null}
        {variant === "text" ? null : (
          <ChevronDown
            className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
            strokeWidth={1.75}
          />
        )}
      </button>

      {open && (hideSettings || harness === "freebuff") ? (
        <ModelFlyout
          anchor={button}
          preferredFreebuffSessionId={sessionId}
          side={side}
          autoFocusSearch
          onDismiss={(reason) => dismiss(reason === "escape")}
          harnesses={pickerHarnesses}
          tab={visibleTab}
          models={visibleModels}
          currentId={current.id}
          active={activeModel}
          query={query}
          favorites={favorites}
          searchRef={search}
          onQuery={setQuery}
          onSelectTab={selectTab}
          onActive={setActiveModel}
          onPick={pickModel}
          onToggleFavorite={toggleFavorite}
        />
      ) : null}

      {open && !hideSettings && harness !== "freebuff" ? (
        <>
          <Popover
            anchor={button}
            side={side}
            width={MENU_WIDTH}
            autoFocus
            dismissOnEscape={false}
            ignore={SELF}
            onDismiss={() => dismiss(false)}
            role="menu"
            aria-label="Model and settings"
            tabIndex={-1}
            onKeyDown={onMenuKey}
            data-model-picker
            className="p-1 font-sans"
          >
            {entries.map((entry, index) => {
              const highlighted = index === active;
              if (entry.kind === "model") {
                return (
                  <button
                    key="model"
                    ref={highlighted ? setActiveRow : undefined}
                    data-model-control-index={index}
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={highlighted && showSubmenu}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => {
                      setActive(index);
                      showEntrySubmenu(entry);
                    }}
                    onClick={() => showEntrySubmenu(entry)}
                    className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] ${
                      highlighted
                        ? "bg-selection text-content"
                        : "text-content hover:bg-content/5"
                    }`}
                  >
                    <span className="min-w-0 flex-1">Model</span>
                    <span className="flex min-w-0 max-w-36 items-center gap-1 text-content/55">
                      <HarnessIcon
                        harness={current.harness}
                        className="size-3.5 shrink-0"
                      />
                      <span className="min-w-0 truncate">{current.name}</span>
                    </span>
                    <ChevronRight
                      className="size-3.5 shrink-0 text-content/45"
                      strokeWidth={1.75}
                    />
                  </button>
                );
              }

              const setting = entry.setting;
              const value = settingValue(setting, values);
              const isToggle = setting.kind === "toggle";
              return (
                <button
                  key={setting.id}
                  ref={highlighted ? setActiveRow : undefined}
                  data-model-control-index={index}
                  type="button"
                  role={isToggle ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={isToggle ? value === "true" : undefined}
                  aria-haspopup={isToggle ? undefined : "menu"}
                  aria-expanded={
                    !isToggle && highlighted ? showSubmenu : undefined
                  }
                  title={setting.description}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    setActive(index);
                    showEntrySubmenu(entry);
                  }}
                  onClick={() => {
                    if (isToggle) {
                      setSetting(setting, value === "true" ? "false" : "true");
                    } else {
                      showEntrySubmenu(entry);
                    }
                  }}
                  className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] ${
                    highlighted
                      ? "bg-selection text-content"
                      : "text-content hover:bg-content/5"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    {settingLabel(setting)}
                  </span>
                  {isToggle ? (
                    <span
                      aria-hidden="true"
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                        value === "true" ? "bg-content/35" : "bg-content/15"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 size-4 rounded-full bg-content shadow-sm transition-transform ${
                          value === "true"
                            ? "translate-x-4.5"
                            : "translate-x-0.5"
                        }`}
                      />
                    </span>
                  ) : (
                    <>
                      <span className="min-w-0 max-w-28 truncate text-content/55">
                        {settingValueLabel(setting, values)}
                      </span>
                      <ChevronRight
                        className="size-3.5 shrink-0 text-content/45"
                        strokeWidth={1.75}
                      />
                    </>
                  )}
                </button>
              );
            })}
          </Popover>

          {showSubmenu && submenu.kind === "setting" ? (
            <Popover
              key={submenu.setting.id}
              anchor={activeRow}
              side="right"
              gap={SUBMENU_OVERLAP}
              width={SETTING_MENU_WIDTH}
              layer={LAYER.submenu}
              role="menu"
              aria-label={settingLabel(submenu.setting)}
              onMouseEnter={() => setSubmenu(submenu)}
              data-model-picker
              className="p-1 font-sans"
            >
              {submenu.setting.options.map((option, index) => {
                const selected =
                  option.value === settingValue(submenu.setting, values);
                const highlighted = index === activeSetting;
                const tileTone = effortTileTone(submenu.setting, option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveSetting(index)}
                    onClick={() => pickSetting(submenu.setting, option.value)}
                    className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] ${
                      highlighted
                        ? "bg-selection text-content"
                        : "text-content hover:bg-content/5"
                    } ${tileTone ? "codex-effort-option" : ""}`}
                    data-effort-tone={tileTone}
                  >
                    {tileTone ? <EffortTileShimmer /> : null}
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    {selected ? (
                      <Check
                        className="size-3.5 shrink-0 text-content/50"
                        strokeWidth={2}
                      />
                    ) : null}
                  </button>
                );
              })}
            </Popover>
          ) : null}

          {showSubmenu && submenu.kind === "models" ? (
            <ModelFlyout
              anchor={activeRow}
              preferredFreebuffSessionId={sessionId}
              autoFocusSearch
              harnesses={pickerHarnesses}
              tab={visibleTab}
              models={visibleModels}
              currentId={current.id}
              active={activeModel}
              query={query}
              favorites={favorites}
              searchRef={search}
              onQuery={setQuery}
              onSelectTab={selectTab}
              onActive={setActiveModel}
              onPick={pickModel}
              onToggleFavorite={toggleFavorite}
            />
          ) : null}
        </>
      ) : null}

      {recentMenu ? (
        <Popover
          anchor={button}
          side={side}
          width={MENU_WIDTH}
          autoFocus
          onDismiss={() => setRecentMenu(null)}
          role="menu"
          aria-label="Recently used models"
          aria-activedescendant={`${recentMenuId}-${recentActive}`}
          tabIndex={-1}
          onContextMenu={(event) => event.preventDefault()}
          data-model-picker
          className="p-1 font-sans"
        >
          {recentMenu.models.map((item, index) => {
            const selected = item.id === current.id;
            const highlighted = index === recentActive;
            const disabled = !source.available(item.harness);
            return (
              <button
                key={item.id}
                id={`${recentMenuId}-${index}`}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={disabled}
                title={
                  disabled ? harnessUnavailableHint(item.harness) : undefined
                }
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setRecentActive(index)}
                onClick={() => pickModel(item)}
                className={`flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left disabled:cursor-not-allowed ${
                  disabled
                    ? "text-content/30"
                    : highlighted
                      ? "bg-selection text-content"
                      : "text-content hover:bg-content/5"
                }`}
              >
                <HarnessIcon
                  harness={item.harness}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-4">
                    {item.name}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-content/45">
                    {HARNESS_TITLE[item.harness]}
                    {item.provider ? ` · ${item.provider.name}` : ""}
                  </span>
                </span>
                {selected ? (
                  <Check
                    className="size-3.5 shrink-0 text-content/55"
                    strokeWidth={2}
                  />
                ) : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
    </>
  );
}

export function ModelControlPills({
  harness,
  model,
  values,
  variant = "pill",
  labelClassName,
  onSettingsChange,
  onClose,
}: Pick<
  Props,
  | "harness"
  | "model"
  | "values"
  | "variant"
  | "labelClassName"
  | "onSettingsChange"
  | "onClose"
>) {
  const catalogVersion = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  );
  void catalogVersion;
  const current = useModelSource().resolve(harness, model);
  const pills = pillSettings(current);
  const effort = pills.find(
    (setting) => setting.kind === "select" && isEffortSetting(setting),
  );
  const groupedSettings = effort
    ? pills.filter(
        (setting) => setting.id === "fast" || setting.id === "serviceTier",
      )
    : [];
  if (pills.length === 0) return null;
  return (
    <>
      {pills.map((setting) => {
        if (groupedSettings.some((grouped) => grouped.id === setting.id)) {
          return null;
        }
        return setting.kind === "toggle" ? (
          <TogglePill
            key={setting.id}
            setting={setting}
            values={values}
            variant={variant}
            onSettingsChange={onSettingsChange}
          />
        ) : (
          <SelectPill
            key={setting.id}
            setting={setting}
            values={values}
            variant={variant}
            labelClassName={labelClassName}
            onSettingsChange={onSettingsChange}
            onClose={onClose}
            additionalSettings={
              setting.id === effort?.id ? groupedSettings : undefined
            }
          />
        );
      })}
    </>
  );
}

/** Trigger classes for a text-only control: a label that brightens on hover. */
function textControlClass(open: boolean, extra = ""): string {
  return `flex h-6.5 min-w-0 items-center rounded-md px-1.5 text-[12px] transition-colors ${extra} ${
    open
      ? "bg-content/8 text-content"
      : "text-content/55 hover:bg-content/8 hover:text-content"
  }`;
}

/** Trigger classes for a setting control in each look. */
function controlClass(variant: Variant, open = false): string {
  if (variant === "text") return textControlClass(open, "max-w-28 gap-1.5");
  return variant === "plain"
    ? `-mx-1.5 flex h-7 min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 text-[12px] text-content/85 ${
        open ? "bg-content/8" : "hover:bg-content/6"
      }`
    : `flex h-6.5 max-w-28 items-center gap-1 rounded-md px-1.5 ${
        open
          ? "bg-selection text-content"
          : "bg-selection text-content hover:bg-selection-hover"
      }`;
}

/**
 * Each model setting as its own labelled row, for property lists like a
 * details panel. `row` lays out one label and its control.
 */
export function ModelSettingRows({
  harness,
  model,
  values,
  side = "top",
  onSettingsChange,
  row,
}: Pick<Props, "harness" | "model" | "values" | "side" | "onSettingsChange"> & {
  row: (setting: {
    id: string;
    label: string;
    control: ReactNode;
  }) => ReactNode;
}) {
  const catalogVersion = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  );
  void catalogVersion;
  const current = useModelSource().resolve(harness, model);
  return (
    <>
      {pillSettings(current).map((setting) => (
        <Fragment key={setting.id}>
          {row({
            id: setting.id,
            label: settingLabel(setting),
            control:
              setting.kind === "toggle" ? (
                <TogglePill
                  setting={setting}
                  values={values}
                  variant="plain"
                  onSettingsChange={onSettingsChange}
                />
              ) : (
                <SelectPill
                  setting={setting}
                  values={values}
                  variant="plain"
                  side={side}
                  onSettingsChange={onSettingsChange}
                />
              ),
          })}
        </Fragment>
      ))}
    </>
  );
}

function TogglePill({
  setting,
  values,
  variant = "pill",
  onSettingsChange,
}: {
  setting: ModelSetting;
  values: Record<string, string>;
  variant?: Variant;
  onSettingsChange: (settings: Record<string, string>) => void;
}) {
  const on = settingValue(setting, values) === "true";
  const toggle = () =>
    onSettingsChange({ ...values, [setting.id]: on ? "false" : "true" });
  if (variant === "plain") {
    // A compact switch, short enough to keep its row the height of the rest.
    return (
      <button
        type="button"
        role="switch"
        aria-label={setting.label}
        aria-checked={on}
        title={`${setting.label}: ${on ? "On" : "Off"}`}
        data-model-control
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          on ? "bg-accent" : "bg-content/20"
        }`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-white transition-[left] ${
            on ? "left-3.5" : "left-0.5"
          }`}
        />
      </button>
    );
  }
  return (
    <button
      type="button"
      title={`${setting.label}: ${on ? "On" : "Off"}`}
      aria-label={`${setting.label}: ${on ? "On" : "Off"}`}
      aria-pressed={on}
      data-model-control
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
      className={controlClass(variant)}
    >
      <span
        className={`min-w-0 truncate ${variant === "pill" ? "text-[11px]" : ""} ${
          on ? "" : variant === "text" ? "opacity-50" : "text-content/50"
        }`}
      >
        {setting.label}
      </span>
    </button>
  );
}

function SelectPill({
  setting,
  values,
  variant = "pill",
  side = "top",
  labelClassName = "",
  onSettingsChange,
  onClose,
  additionalSettings,
}: {
  setting: ModelSetting;
  values: Record<string, string>;
  variant?: Variant;
  side?: "top" | "bottom";
  /** Applies only beside an icon, so a hidden label never leaves a blank. */
  labelClassName?: string;
  onSettingsChange: (settings: Record<string, string>) => void;
  onClose?: () => void;
  additionalSettings?: ModelSetting[];
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const value = settingValue(setting, values);
  const valueLabel = settingValueLabel(setting, values);
  const label = settingLabel(setting);
  const iconic = isEffortSetting(setting) || setting.id === "serviceTier";
  const menuSettings = [setting, ...(additionalSettings ?? [])];
  const grouped = menuSettings.length > 1;
  const menuOptions = menuSettings.flatMap((menuSetting) =>
    menuSetting.options.map((option) => ({ setting: menuSetting, option })),
  );
  const menuLabels = menuSettings.map(settingLabel);
  const menuLabel =
    menuLabels.length < 3
      ? menuLabels.join(" and ")
      : `${menuLabels.slice(0, -1).join(", ")}, and ${menuLabels[menuLabels.length - 1]}`;
  const dismiss = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) onClose?.();
  };
  const openPicker = () => {
    const selectedIndex = menuOptions.findIndex(
      (item) => item.setting.id === setting.id && item.option.value === value,
    );
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };
  const pick = (pickedSetting: ModelSetting, optionValue: string) => {
    onSettingsChange({ ...values, [pickedSetting.id]: optionValue });
    dismiss(true);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        title={`${label}: ${valueLabel}`}
        aria-label={`${label}: ${valueLabel}`}
        aria-expanded={open}
        aria-haspopup="menu"
        data-model-control
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? dismiss(true) : openPicker())}
        className={controlClass(variant, open)}
      >
        {isEffortSetting(setting) ? (
          <Gauge className="size-3.5 shrink-0" strokeWidth={1.75} />
        ) : setting.id === "serviceTier" ? (
          <Zap className="size-3.5 shrink-0" strokeWidth={1.75} />
        ) : null}
        <span
          className={`min-w-0 truncate ${variant === "pill" ? "text-[11px]" : ""} ${iconic ? labelClassName : ""}`}
        >
          {valueLabel}
        </span>
        {variant === "text" ? null : (
          <ChevronDown
            className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
            strokeWidth={1.75}
          />
        )}
      </button>

      {open ? (
        <Popover
          anchor={button}
          side={side}
          width={SETTING_MENU_WIDTH}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="menu"
          aria-label={menuLabel}
          aria-activedescendant={`${menuId}-${active}`}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (index) =>
                  (index + direction + menuOptions.length) % menuOptions.length,
              );
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            const item = menuOptions[active];
            if (item) pick(item.setting, item.option.value);
          }}
          data-model-control
          className="p-1 font-sans"
        >
          {menuSettings.map((menuSetting, groupIndex) => (
            <Fragment key={menuSetting.id}>
              {groupIndex > 0 ? (
                <div role="separator" className="my-1 h-px bg-content/10" />
              ) : null}
              <div
                role={grouped ? "group" : undefined}
                aria-label={grouped ? settingLabel(menuSetting) : undefined}
              >
                {grouped ? (
                  <div className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-content/40">
                    {settingLabel(menuSetting)}
                  </div>
                ) : null}
                {menuSetting.options.map((option) => {
                  const index = menuOptions.findIndex(
                    (item) =>
                      item.setting.id === menuSetting.id &&
                      item.option.value === option.value,
                  );
                  const selected =
                    option.value === settingValue(menuSetting, values);
                  const highlighted = index === active;
                  const tileTone = effortTileTone(menuSetting, option.value);
                  return (
                    <button
                      key={option.value}
                      id={`${menuId}-${index}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(menuSetting, option.value)}
                      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-content ${
                        highlighted ? "bg-selection" : "hover:bg-content/5"
                      } ${tileTone ? "codex-effort-option" : ""}`}
                      data-effort-tone={tileTone}
                    >
                      {tileTone ? <EffortTileShimmer /> : null}
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                      </span>
                      {selected ? (
                        <Check
                          className="size-3.5 shrink-0 text-content/50"
                          strokeWidth={2}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </Fragment>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

function ModelFlyout({
  anchor,
  preferredFreebuffSessionId,
  side = "right",
  autoFocusSearch = false,
  onDismiss,
  harnesses,
  tab,
  models,
  currentId,
  active,
  query,
  favorites,
  searchRef,
  onQuery,
  onSelectTab,
  onActive,
  onPick,
  onToggleFavorite,
}: {
  anchor: HTMLButtonElement | { current: HTMLButtonElement | null };
  preferredFreebuffSessionId?: string;
  side?: "right" | "top" | "bottom";
  autoFocusSearch?: boolean;
  onDismiss?: (reason: "outside" | "escape") => void;
  harnesses: HarnessId[];
  tab: ModelPickerTab;
  models: AgentModel[];
  currentId: string;
  active: number;
  query: string;
  favorites: string[];
  searchRef: React.RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onSelectTab: (tab: ModelPickerTab) => void;
  onActive: (index: number) => void;
  onPick: (model: AgentModel) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const source = useModelSource();
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);
  const groups = modelGroups(tab, models);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The popover frame starts hidden until its layout effect measures the
  // anchor, and browsers silently drop focus() on a hidden element. React's
  // autoFocus fires during that first commit, so defer one frame to focus
  // once the flyout is on screen.
  useEffect(() => {
    if (!autoFocusSearch) return;
    const frame = requestAnimationFrame(() => {
      searchRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocusSearch, searchRef]);

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      onActive(Math.min(models.length - 1, active + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      onActive(Math.max(0, active - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = models[active];
      if (item) onPick(item);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.stopPropagation();
    }
  };

  return (
    <Popover
      anchor={anchor}
      side={side}
      gap={side === "right" ? SUBMENU_OVERLAP : undefined}
      width={MODEL_MENU_WIDTH}
      minHeight={MODEL_MENU_FRAME_HEIGHT}
      maxHeight={MODEL_MENU_FRAME_HEIGHT}
      layer={LAYER.submenu}
      role="dialog"
      aria-label="Models"
      onDismiss={onDismiss}
      onKeyDown={(event) => {
        // Keyboard nav once focus leaves the search field (which stops its
        // own keys). Scoped to the list so provider tabs keep their buttons.
        if (
          !(event.target instanceof Element) ||
          !event.target.closest('[role="listbox"]')
        ) {
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          onActive(
            Math.min(models.length - 1, Math.max(0, active + direction)),
          );
          return;
        }
        if (event.key !== "Enter") return;
        // Favorite toggles keep native activation; model rows activate the
        // highlighted option so Enter never fires on a stale focused row.
        if (
          event.target instanceof HTMLButtonElement &&
          event.target.getAttribute("role") !== "option"
        ) {
          return;
        }
        event.preventDefault();
        const item = models[active];
        if (item) onPick(item);
      }}
      data-model-picker
      // Popover caps the height to the viewport; a fixed max here would
      // clip the bottom rows (and tabs) out of reach on short or zoomed windows.
      style={{ height: MODEL_MENU_HEIGHT }}
      className="flex min-h-0 overflow-hidden font-sans"
    >
      <nav
        role="tablist"
        aria-label="Providers"
        aria-orientation="vertical"
        className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-none border-r border-stroke p-1.5"
      >
        <ProviderTabButton
          title="Favorites"
          selected={tab === "favorites"}
          onSelect={() => onSelectTab("favorites")}
        >
          <Star
            className="size-4"
            strokeWidth={1.75}
            fill={tab === "favorites" ? "currentColor" : "none"}
          />
        </ProviderTabButton>
        {harnesses.map((harness) => (
          <ProviderTabButton
            key={harness}
            title={HARNESS_TITLE[harness]}
            selected={tab === harness}
            onSelect={() => onSelectTab(harness)}
          >
            <HarnessIcon harness={harness} className="size-4" />
          </ProviderTabButton>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <label className="flex shrink-0 items-center gap-2 border-b border-stroke px-3 py-2.5 text-content/50">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={onSearchKey}
          />
        </label>

        <div
          ref={lockOverscroll}
          role="listbox"
          aria-label="Models"
          className="min-h-0 flex-1 overflow-y-auto overscroll-none p-1"
        >
          {tab === "freebuff" ? (
            <FreebuffSessionContent
              currentId={currentId}
              preferredSessionId={preferredFreebuffSessionId}
              available={source.available("freebuff")}
              onPick={onPick}
            />
          ) : tab === "favorites" && !query.trim() && models.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-content/50">
              No favorite models
            </div>
          ) : models.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-content/50">
              {tab === "favorites" && !query.trim()
                ? "No favorite models"
                : tab !== "favorites" && !source.available(tab)
                  ? harnessUnavailableHint(tab)
                  : tab === "codex" && !query.trim()
                    ? "Loading Codex models…"
                    : "No matching models"}
            </div>
          ) : (
            groups.map((group) => (
              <div
                key={group.id}
                role={group.name ? "group" : undefined}
                aria-label={group.name}
              >
                {group.name ? (
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">
                    {group.name}
                  </div>
                ) : null}
                {group.models.map(({ item, index }) => {
                  const selected = item.id === currentId;
                  const highlighted = index === active;
                  const favorited = favorites.includes(item.id);
                  const disabled = !source.available(item.harness);
                  // Favorites mix harnesses, so every row names its source.
                  // Provider first (OpenCode Go vs OpenCode), else harness.
                  const provenance =
                    item.provider?.name ?? HARNESS_TITLE[item.harness];
                  return (
                    <div
                      key={item.id}
                      className={`group flex h-8 items-center rounded-lg px-1 ${
                        disabled
                          ? "text-content/30"
                          : highlighted
                            ? "bg-selection text-content"
                            : "text-content hover:bg-content/5"
                      }`}
                      onMouseEnter={() => onActive(index)}
                    >
                      <button
                        ref={highlighted ? activeRef : undefined}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={`${item.name}, ${provenance}`}
                        disabled={disabled}
                        title={
                          disabled
                            ? harnessUnavailableHint(item.harness)
                            : undefined
                        }
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onPick(item)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-left text-[13px] disabled:cursor-not-allowed"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {item.name}
                        </span>
                      </button>
                      {tab === "favorites" ? (
                        <span className="max-w-24 shrink-0 truncate text-[10px] text-content/40">
                          {provenance}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        title={
                          favorited
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        aria-label={
                          favorited
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleFavorite(item.id);
                        }}
                        className={`grid size-6 shrink-0 place-items-center rounded-md transition-opacity ${
                          favorited
                            ? "text-content/60"
                            : "text-content/35 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                      >
                        <Star
                          className="size-3.5"
                          strokeWidth={1.75}
                          fill={favorited ? "currentColor" : "none"}
                        />
                      </button>
                      {selected ? (
                        <span
                          aria-hidden="true"
                          className="grid size-6 shrink-0 place-items-center"
                        >
                          <Check
                            className="size-3.5 text-content/55"
                            strokeWidth={2}
                          />
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </Popover>
  );
}

function ProviderTabButton({
  title,
  selected,
  onSelect,
  children,
}: {
  title: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      title={title}
      aria-label={title}
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={selected ? undefined : onSelect}
      onClick={onSelect}
      className={`grid size-8 shrink-0 place-items-center rounded-md ${
        selected
          ? "bg-selection-strong text-content"
          : "text-content/45 hover:bg-content/8 hover:text-content"
      }`}
    >
      <span className="shrink-0">{children}</span>
    </button>
  );
}
