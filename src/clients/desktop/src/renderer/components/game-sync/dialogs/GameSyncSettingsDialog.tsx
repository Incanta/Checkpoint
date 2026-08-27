import { useCallback, useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { useAtomValue } from "jotai";
import { currentWorkspaceAtom } from "../../../../common/state/workspace";
import {
  gameSyncConfigAtom,
  gameSyncFilterPreviewAtom,
  gameSyncSettingsAtom,
  getWsRecord,
  type GameSyncScheduledSync,
  type GameSyncSettings,
} from "../../../../common/state/game-sync";
import { ipc } from "../../../pages/ipc";
import { Button } from "../../ui";
import {
  CheckRow,
  FieldRow,
  Switch,
  gameSyncDialogPt,
  selectClass,
  textareaClass,
} from "./shared";

export interface GameSyncSettingsDialogProps {
  visible: boolean;
  onHide: () => void;
}

type TabId = "filters" | "build" | "after" | "scheduled";

const TABS: { id: TabId; label: string }[] = [
  { id: "filters", label: "Sync Filters" },
  { id: "build", label: "Build Steps" },
  { id: "after", label: "After Sync" },
  { id: "scheduled", label: "Scheduled Sync" },
];

const DEFAULT_EDITOR_CONFIGS = ["Development", "DebugGame"];
const DEFAULT_SCHEDULE: GameSyncScheduledSync = {
  enabled: false,
  timeOfDay: "03:00",
  target: "latest-good",
};
const SCHEDULE_TARGETS: {
  value: GameSyncScheduledSync["target"];
  label: string;
}[] = [
  { value: "latest", label: "Latest changelist" },
  { value: "latest-good", label: "Latest good changelist" },
  { value: "latest-starred", label: "Latest starred changelist" },
];

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function SectionTitle({ children }: { children: string }): React.ReactElement {
  return (
    <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

export default function GameSyncSettingsDialog({
  visible,
  onHide,
}: GameSyncSettingsDialogProps): React.ReactElement {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const configRecord = useAtomValue(gameSyncConfigAtom);
  const settingsRecord = useAtomValue(gameSyncSettingsAtom);
  const filterPreviewRecord = useAtomValue(gameSyncFilterPreviewAtom);

  const workspaceId = currentWorkspace?.id ?? null;
  const config = getWsRecord(configRecord, workspaceId) ?? null;
  const savedSettings = getWsRecord(settingsRecord, workspaceId) ?? null;
  const filterPreview = getWsRecord(filterPreviewRecord, workspaceId);

  const [tab, setTab] = useState<TabId>("filters");
  const [pending, setPending] = useState<GameSyncSettings>({});
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");

  // Load the current settings into local editable state each time we open.
  useEffect(() => {
    if (!visible) return;
    const base: GameSyncSettings = savedSettings ? { ...savedSettings } : {};
    setPending(base);
    setIncludeText((base.customIncludeRules ?? []).join("\n"));
    setExcludeText((base.customExcludeRules ?? []).join("\n"));
    setTab("filters");
  }, [visible, savedSettings]);

  const editorConfigs =
    config?.project?.editorConfigurations ?? DEFAULT_EDITOR_CONFIGS;
  const schedule = pending.scheduledSync ?? DEFAULT_SCHEDULE;
  const afterSync = pending.afterSync ?? {};

  // Assemble the full settings object the daemon should persist (shallow merge
  // over what is already saved).
  const buildSettings = useCallback(
    (): GameSyncSettings => ({
      ...pending,
      customIncludeRules: parseLines(includeText),
      customExcludeRules: parseLines(excludeText),
      preset: pending.preset ?? null,
    }),
    [pending, includeText, excludeText],
  );

  const setCategory = (id: string, enabled: boolean): void => {
    setPending((prev) => ({
      ...prev,
      categoryOverrides: { ...prev.categoryOverrides, [id]: enabled },
    }));
  };

  const setAfterSync = (
    key: keyof NonNullable<GameSyncSettings["afterSync"]>,
    value: boolean,
  ): void => {
    setPending((prev) => ({
      ...prev,
      afterSync: { ...prev.afterSync, [key]: value },
    }));
  };

  const setSchedule = (patch: Partial<GameSyncScheduledSync>): void => {
    setPending((prev) => ({
      ...prev,
      scheduledSync: { ...DEFAULT_SCHEDULE, ...prev.scheduledSync, ...patch },
    }));
  };

  const setBuildStep = (id: string, enabled: boolean): void => {
    setPending((prev) => ({
      ...prev,
      buildStepOverrides: {
        ...prev.buildStepOverrides,
        [id]: { enabled },
      },
    }));
  };

  const handlePreview = (): void => {
    ipc.sendMessage("game-sync:filter:preview", { settings: buildSettings() });
  };

  const handleSave = (): void => {
    ipc.sendMessage("game-sync:update-settings", {
      settings: buildSettings(),
    });
    onHide();
  };

  const categories = (config?.syncCategories ?? []).filter((c) => !c.hidden);
  const presets = config?.presets ?? [];
  const buildSteps = config?.buildSteps ?? [];

  return (
    <Dialog
      header="Game Sync Settings"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: "48rem" }}
      pt={gameSyncDialogPt}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onHide}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      }
    >
      <div className="flex min-h-[24rem]">
        {/* Left tab rail */}
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`cursor-pointer rounded-md border-0 px-3 py-2 text-left text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 overflow-auto p-5">
          {!config && (
            <div className="text-sm text-[var(--color-text-muted)]">
              No Game Sync config was found for this workspace.
            </div>
          )}

          {config && tab === "filters" && (
            <div className="flex flex-col gap-5">
              <div>
                <SectionTitle>Preset</SectionTitle>
                <select
                  value={pending.preset ?? ""}
                  onChange={(e) =>
                    setPending((prev) => ({
                      ...prev,
                      preset: e.target.value || null,
                    }))
                  }
                  className={selectClass}
                >
                  <option value="">Custom</option>
                  {presets.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.locked ? " (locked)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <SectionTitle>Categories</SectionTitle>
                <div className="flex flex-col gap-2">
                  {categories.length === 0 && (
                    <div className="text-sm text-[var(--color-text-muted)]">
                      This config defines no sync categories.
                    </div>
                  )}
                  {categories.map((cat) => (
                    <CheckRow
                      key={cat.id}
                      checked={
                        pending.categoryOverrides?.[cat.id] ??
                        cat.enabledByDefault
                      }
                      onChange={() =>
                        setCategory(
                          cat.id,
                          !(
                            pending.categoryOverrides?.[cat.id] ??
                            cat.enabledByDefault
                          ),
                        )
                      }
                      label={cat.name}
                      hint={cat.paths.join(", ")}
                    />
                  ))}
                </div>
              </div>

              <div>
                <SectionTitle>Custom include rules</SectionTitle>
                <textarea
                  value={includeText}
                  onChange={(e) => setIncludeText(e.target.value)}
                  rows={3}
                  placeholder={"One gitignore-style pattern per line"}
                  className={textareaClass}
                />
              </div>

              <div>
                <SectionTitle>Custom exclude rules</SectionTitle>
                <textarea
                  value={excludeText}
                  onChange={(e) => setExcludeText(e.target.value)}
                  rows={3}
                  placeholder={"One gitignore-style pattern per line"}
                  className={textareaClass}
                />
              </div>

              <div className="flex items-center gap-3">
                <Button variant="secondary" size="sm" onClick={handlePreview}>
                  Preview changes
                </Button>
                {filterPreview && (
                  <span className="text-xs text-[var(--color-warning-fg,#d97706)]">
                    {filterPreview.toDelete.length === 0
                      ? "No synced files would be removed."
                      : `${filterPreview.toDelete.length} synced file${
                          filterPreview.toDelete.length === 1 ? "" : "s"
                        } will be removed on the next sync.`}
                  </span>
                )}
              </div>
            </div>
          )}

          {config && tab === "build" && (
            <div className="flex flex-col gap-4">
              <SectionTitle>Build Steps</SectionTitle>
              {buildSteps.length === 0 && (
                <div className="text-sm text-[var(--color-text-muted)]">
                  This config defines no build steps.
                </div>
              )}
              {buildSteps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-border-muted)] pb-3"
                >
                  <CheckRow
                    checked={
                      pending.buildStepOverrides?.[step.id]?.enabled ?? true
                    }
                    onChange={() =>
                      setBuildStep(
                        step.id,
                        !(
                          pending.buildStepOverrides?.[step.id]?.enabled ?? true
                        ),
                      )
                    }
                    label={step.name}
                    hint={step.type}
                  />
                  <div className="flex shrink-0 gap-1.5">
                    {step.normalSync && (
                      <span className="rounded bg-[var(--color-bg-overlay)] px-1.5 py-0.5 text-[0.65rem] text-[var(--color-text-muted)]">
                        Normal
                      </span>
                    )}
                    {step.scheduledSync && (
                      <span className="rounded bg-[var(--color-bg-overlay)] px-1.5 py-0.5 text-[0.65rem] text-[var(--color-text-muted)]">
                        Scheduled
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {/* TODO(phase3): editor for adding/editing custom build steps. */}
              <div className="text-xs text-[var(--color-text-muted)]">
                Adding custom build steps is coming soon.
              </div>
            </div>
          )}

          {config && tab === "after" && (
            <div className="flex flex-col gap-4">
              <SectionTitle>After each sync</SectionTitle>
              <CheckRow
                checked={afterSync.build ?? false}
                onChange={() =>
                  setAfterSync("build", !(afterSync.build ?? false))
                }
                label="Build"
                hint="Run the configured build steps"
              />
              <CheckRow
                checked={afterSync.generateProjectFiles ?? false}
                onChange={() =>
                  setAfterSync(
                    "generateProjectFiles",
                    !(afterSync.generateProjectFiles ?? false),
                  )
                }
                label="Generate project files"
              />
              <CheckRow
                checked={afterSync.runEditor ?? false}
                onChange={() =>
                  setAfterSync("runEditor", !(afterSync.runEditor ?? false))
                }
                label="Run the editor"
              />
              <CheckRow
                checked={afterSync.openSolution ?? false}
                onChange={() =>
                  setAfterSync(
                    "openSolution",
                    !(afterSync.openSolution ?? false),
                  )
                }
                label="Open the solution"
              />

              <div className="mt-2 border-t border-[var(--color-border-muted)] pt-4">
                <SectionTitle>Build</SectionTitle>
                <div className="flex flex-col gap-3">
                  <FieldRow label="Editor configuration">
                    <select
                      value={pending.editorConfiguration ?? editorConfigs[0]}
                      onChange={(e) =>
                        setPending((prev) => ({
                          ...prev,
                          editorConfiguration: e.target.value,
                        }))
                      }
                      className={selectClass}
                    >
                      {editorConfigs.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </FieldRow>
                  <FieldRow
                    label="Use precompiled binaries"
                    hint="Download editor binaries instead of building locally"
                  >
                    <Switch
                      checked={pending.usePrecompiledBinaries ?? false}
                      onChange={() =>
                        setPending((prev) => ({
                          ...prev,
                          usePrecompiledBinaries: !(
                            prev.usePrecompiledBinaries ?? false
                          ),
                        }))
                      }
                    />
                  </FieldRow>
                  <FieldRow
                    label="Write version files"
                    hint="Write build version metadata into the workspace"
                  >
                    <Switch
                      checked={pending.writeVersionFiles ?? false}
                      onChange={() =>
                        setPending((prev) => ({
                          ...prev,
                          writeVersionFiles: !(prev.writeVersionFiles ?? false),
                        }))
                      }
                    />
                  </FieldRow>
                </div>
              </div>
            </div>
          )}

          {config && tab === "scheduled" && (
            <div className="flex flex-col gap-4">
              <SectionTitle>Scheduled Sync</SectionTitle>
              <FieldRow
                label="Enable scheduled sync"
                hint="The daemon runs this even when the app is closed"
              >
                <Switch
                  checked={schedule.enabled}
                  onChange={() => setSchedule({ enabled: !schedule.enabled })}
                />
              </FieldRow>

              <FieldRow label="Time of day" hint="Local time, 24-hour">
                <input
                  type="time"
                  value={schedule.timeOfDay}
                  disabled={!schedule.enabled}
                  onChange={(e) => setSchedule({ timeOfDay: e.target.value })}
                  className={`${selectClass} disabled:opacity-50`}
                />
              </FieldRow>

              <div>
                <SectionTitle>Sync target</SectionTitle>
                <div className="flex flex-col gap-2">
                  {SCHEDULE_TARGETS.map((t) => (
                    <label
                      key={t.value}
                      className={`flex items-center gap-2.5 ${
                        schedule.enabled
                          ? "cursor-pointer"
                          : "cursor-not-allowed opacity-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="schedule-target"
                        checked={schedule.target === t.value}
                        disabled={!schedule.enabled}
                        onChange={() => setSchedule({ target: t.value })}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span className="text-sm text-[var(--color-text-primary)]">
                        {t.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
