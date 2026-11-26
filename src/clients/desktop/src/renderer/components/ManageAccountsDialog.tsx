import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { nanoid } from "nanoid";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import {
  User,
  accountDisplayName,
  currentUserAtom,
  pendingLoginAtom,
  usersAtom,
} from "../../common/state/auth";
import { ipc } from "../pages/ipc";
import Spinner from "./Spinner";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  dialogFieldClass,
  dialogInputClass,
} from "./ui";

type Selection = { kind: "account"; daemonId: string } | { kind: "add" };

interface ManageAccountsDialogProps {
  visible: boolean;
  onHide: () => void;
}

/**
 * Lists the daemon's accounts and lets the user add one (browser sign-in or
 * API token), change an account's label, server URL, or token, switch to it,
 * or remove it.
 */
export default function ManageAccountsDialog({
  visible,
  onHide,
}: ManageAccountsDialogProps): React.ReactElement {
  const users = useAtomValue(usersAtom) ?? [];
  const currentUser = useAtomValue(currentUserAtom);
  const [selection, setSelection] = useState<Selection>({ kind: "add" });

  // Each time the dialog opens, start on the active account.
  useEffect(() => {
    if (!visible) return;
    const first = currentUser ?? users[0];
    setSelection(
      first ? { kind: "account", daemonId: first.daemonId } : { kind: "add" },
    );
    // Only on open; later changes are handled below.
  }, [visible]);

  // If the selected account disappears (removed), fall back to another.
  const selectedUser =
    selection.kind === "account"
      ? users.find((u) => u.daemonId === selection.daemonId)
      : undefined;
  useEffect(() => {
    if (selection.kind === "account" && !selectedUser) {
      setSelection(
        users[0]
          ? { kind: "account", daemonId: users[0].daemonId }
          : { kind: "add" },
      );
    }
  }, [selection, selectedUser, users]);

  return (
    <Dialog
      header="Manage Accounts"
      visible={visible}
      onHide={onHide}
      style={{ width: "46rem" }}
      contentClassName="!p-0"
    >
      <div className="flex h-[26rem] min-h-0">
        <div className="box-border flex w-[15rem] shrink-0 flex-col border-r border-[var(--color-border-default)]">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {users.map((user) => {
              const isSelected =
                selection.kind === "account" &&
                selection.daemonId === user.daemonId;
              return (
                <button
                  key={user.daemonId}
                  type="button"
                  onClick={() =>
                    setSelection({ kind: "account", daemonId: user.daemonId })
                  }
                  className={`mb-1 box-border flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 px-2.5 py-2 text-left transition-colors ${
                    isSelected
                      ? "bg-[var(--color-accent-muted)]"
                      : "bg-transparent hover:bg-[var(--color-bg-overlay)]"
                  }`}
                >
                  <Avatar
                    src={user.details?.image ?? null}
                    name={user.details?.name ?? null}
                    email={user.details?.email ?? ""}
                    size="sm"
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                        {accountDisplayName(user)}
                      </span>
                      {user.reachable === false && (
                        <span
                          title="Server unreachable"
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning)]"
                        />
                      )}
                    </div>
                    <div
                      className="truncate text-xs text-[var(--color-text-muted)]"
                      title={user.endpoint}
                    >
                      {user.endpoint}
                    </div>
                  </div>
                  {currentUser?.daemonId === user.daemonId && (
                    <Badge variant="accent" className="shrink-0">
                      Active
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--color-border-default)] p-2">
            <button
              type="button"
              onClick={() => setSelection({ kind: "add" })}
              className={`box-border flex w-full cursor-pointer items-center gap-2 rounded-md border-0 px-2.5 py-2 text-left text-sm transition-colors ${
                selection.kind === "add"
                  ? "bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                  : "bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              <FontAwesomeIcon icon={faPlus} />
              Add account
            </button>
          </div>
        </div>
        <div className="box-border min-w-0 flex-1 overflow-y-auto p-5">
          {selection.kind === "add" ? (
            <AddAccountForm
              onAdded={(daemonId) =>
                setSelection({ kind: "account", daemonId })
              }
            />
          ) : selectedUser ? (
            <AccountEditor key={selectedUser.daemonId} user={selectedUser} />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs leading-relaxed text-[var(--color-danger)]">
      {children}
    </p>
  );
}

function FieldCaption({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <span className="font-medium text-[var(--color-text-primary)]">
      {children}
      {hint && (
        <span className="ml-1.5 font-normal text-[var(--color-text-muted)]">
          {hint}
        </span>
      )}
    </span>
  );
}

function AccountEditor({ user }: { user: User }): React.ReactElement {
  const [currentUser, setCurrentUser] = useAtom(currentUserAtom);
  const isActive = currentUser?.daemonId === user.daemonId;

  const [label, setLabel] = useState(user.label ?? "");
  const [endpoint, setEndpoint] = useState(user.endpoint);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const labelChanged = label.trim() !== (user.label ?? "");
  const endpointChanged = endpoint.trim().replace(/\/+$/, "") !== user.endpoint;
  const tokenChanged = token.trim() !== "";
  const connectionChanged = endpointChanged || tokenChanged;
  const dirty = labelChanged || connectionChanged;
  const invalid = endpoint.trim() === "";

  const save = async (skipValidation = false) => {
    setSaving(true);
    setError(null);
    const result = await ipc.invoke("accounts:update", {
      daemonId: user.daemonId,
      label: labelChanged ? label : undefined,
      endpoint: endpointChanged ? endpoint : undefined,
      token: tokenChanged ? token : undefined,
      skipValidation,
    });
    setSaving(false);
    if (result.ok) {
      setToken("");
      setSavedAt(Date.now());
    } else {
      setError(result.error);
    }
  };

  // Once the saved values come back from the daemon, show them (e.g. the URL
  // without its trailing slash).
  useEffect(() => {
    setLabel(user.label ?? "");
    setEndpoint(user.endpoint);
  }, [user.label, user.endpoint]);

  const revert = () => {
    setLabel(user.label ?? "");
    setEndpoint(user.endpoint);
    setToken("");
    setError(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar
          src={user.details?.image ?? null}
          name={user.details?.name ?? null}
          email={user.details?.email ?? ""}
          size="md"
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
            {user.details?.name || user.details?.username || "Unknown user"}
          </div>
          <div className="truncate text-xs text-[var(--color-text-muted)]">
            {user.details?.email}
          </div>
        </div>
        {user.reachable === false ? (
          <Badge variant="warning">Unreachable</Badge>
        ) : (
          <Badge variant="success">Connected</Badge>
        )}
      </div>

      <label className={dialogFieldClass}>
        <FieldCaption hint="optional">Label</FieldCaption>
        <input
          type="text"
          className={dialogInputClass}
          value={label}
          placeholder={user.details?.username || user.details?.email || ""}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      <label className={dialogFieldClass}>
        <FieldCaption>Server URL</FieldCaption>
        <input
          type="text"
          className={dialogInputClass}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>

      <label className={dialogFieldClass}>
        <FieldCaption hint="leave blank to keep the current one">
          API token
        </FieldCaption>
        <input
          type="password"
          autoComplete="off"
          className={dialogInputClass}
          value={token}
          placeholder="••••••••"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex items-center gap-2">
        {dirty ? (
          <>
            <Button
              type="button"
              onClick={() => save(false)}
              disabled={saving || invalid}
            >
              {saving && <Spinner size={14} thickness={2} />}
              Save
            </Button>
            {error && connectionChanged && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => save(true)}
                disabled={saving || invalid}
                title="Save without checking the server, for example when it's down right now"
              >
                Save anyway
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={revert}
              disabled={saving}
            >
              Revert
            </Button>
          </>
        ) : (
          savedAt !== null && (
            <span className="text-xs text-[var(--color-text-muted)]">
              Saved.
            </span>
          )
        )}
        <div className="flex-1" />
        {!isActive && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setCurrentUser(user)}
          >
            Switch to this account
          </Button>
        )}
      </div>

      <div className="mt-1 border-t border-[var(--color-border-default)] pt-4">
        {confirmRemove ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-xs leading-relaxed text-[var(--color-text-secondary)]">
              Remove{" "}
              <strong className="text-[var(--color-text-primary)]">
                {accountDisplayName(user)}
              </strong>
              ? This signs this device out of {user.endpoint} and forgets its
              token. Files in its workspaces stay on disk.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => {
                  ipc.sendMessage("auth:logout", { daemonId: user.daemonId });
                  setConfirmRemove(false);
                }}
              >
                Remove account
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="!px-0 text-[var(--color-danger)] hover:!bg-transparent hover:!text-[var(--color-danger)] hover:underline"
            onClick={() => setConfirmRemove(true)}
          >
            Remove this account…
          </Button>
        )}
      </div>
    </div>
  );
}

function AddAccountForm({
  onAdded,
}: {
  onAdded: (daemonId: string) => void;
}): React.ReactElement {
  const users = useAtomValue(usersAtom) ?? [];
  const pendingLoginValue = useAtomValue(pendingLoginAtom);

  const [method, setMethod] = useState<"browser" | "token">("browser");
  const [endpoint, setEndpoint] = useState("");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [daemonId, setDaemonId] = useState<string | null>(null);
  const [tokenSubmitting, setTokenSubmitting] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const pendingLogin =
    daemonId && pendingLoginValue?.daemonId === daemonId
      ? pendingLoginValue
      : null;
  const browserError = pendingLogin?.error ?? null;
  const awaitingAuthorization = Boolean(
    pendingLogin?.code && !pendingLogin.error,
  );
  const browserBusy =
    pendingLogin !== null && !awaitingAuthorization && !browserError;

  // Leaving the form (switching to an account, closing the dialog) abandons a
  // browser sign-in that hasn't finished. Main ignores this if it already has.
  const pendingIdRef = useRef<string | null>(null);
  pendingIdRef.current =
    pendingLogin && !pendingLogin.error ? pendingLogin.daemonId : null;
  useEffect(() => {
    return () => {
      if (pendingIdRef.current) {
        ipc.sendMessage("auth:login:cancel", {
          daemonId: pendingIdRef.current,
        });
      }
    };
  }, []);

  // A browser sign-in is done once the new account shows up.
  useEffect(() => {
    if (
      method === "browser" &&
      daemonId &&
      !pendingLogin &&
      users.some((u) => u.daemonId === daemonId)
    ) {
      onAdded(daemonId);
    }
  }, [method, daemonId, pendingLogin, users, onAdded]);

  const startBrowserSignIn = () => {
    const id = nanoid();
    setDaemonId(id);
    ipc.sendMessage("auth:login", {
      daemonId: id,
      endpoint: endpoint.trim(),
      label: label.trim() || null,
    });
  };

  const addWithToken = async () => {
    const id = nanoid();
    setTokenSubmitting(true);
    setTokenError(null);
    const result = await ipc.invoke("accounts:add-with-token", {
      daemonId: id,
      endpoint: endpoint.trim(),
      token: token.trim(),
      label: label.trim() || null,
    });
    setTokenSubmitting(false);
    if (result.ok) {
      onAdded(id);
    } else {
      setTokenError(result.error);
    }
  };

  if (awaitingAuthorization && pendingLogin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
        <Spinner size={36} />
        <div>
          <div className="text-base font-semibold text-[var(--color-text-primary)]">
            Authorize this device
          </div>
          <p className="mt-1.5 mb-0 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Open the authorization page on {pendingLogin.endpoint} and confirm
            the code below.
          </p>
        </div>
        <div className="box-border w-full max-w-[18rem] select-text rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3 font-mono text-2xl font-semibold tracking-[0.25em] text-[var(--color-text-primary)]">
          {pendingLogin.code}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => {
              if (pendingLogin.url) {
                ipc.sendMessage("app:open-external", { url: pendingLogin.url });
              }
            }}
          >
            Open authorization page
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              ipc.sendMessage("auth:login:cancel", {
                daemonId: pendingLogin.daemonId,
              })
            }
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const busy = browserBusy || tokenSubmitting;
  const error = method === "browser" ? browserError : tokenError;
  const invalid =
    endpoint.trim() === "" || (method === "token" && token.trim() === "");

  const submit = () => {
    if (busy || invalid) return;
    if (method === "browser") startBrowserSignIn();
    else void addWithToken();
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">
          Add an account
        </div>
        <p className="mt-1 mb-0 text-xs leading-relaxed text-[var(--color-text-muted)]">
          Sign in to another Checkpoint server, or to the same one as a
          different user.
        </p>
      </div>

      <div className="inline-flex self-start rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-0.5">
        {(
          [
            ["browser", "Sign in with browser"],
            ["token", "Use an API token"],
          ] as const
        ).map(([value, text]) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            onClick={() => setMethod(value)}
            className={`cursor-pointer rounded border-0 px-3 py-1 text-xs font-medium transition-colors ${
              method === value
                ? "bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]"
                : "bg-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      <label className={dialogFieldClass}>
        <FieldCaption>Server URL</FieldCaption>
        <input
          type="text"
          className={dialogInputClass}
          value={endpoint}
          disabled={busy}
          placeholder="http://your-server-ip:13000"
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>

      <label className={dialogFieldClass}>
        <FieldCaption hint="optional">Label</FieldCaption>
        <input
          type="text"
          className={dialogInputClass}
          value={label}
          disabled={busy}
          placeholder="Work, Personal, Staging…"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      {method === "token" && (
        <label className={dialogFieldClass}>
          <FieldCaption hint="minted under Settings → Devices on the server">
            API token
          </FieldCaption>
          <input
            type="password"
            autoComplete="off"
            className={dialogInputClass}
            value={token}
            disabled={busy}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      <div>
        <Button type="submit" disabled={busy || invalid}>
          {busy && <Spinner size={14} thickness={2} />}
          {busy
            ? "Connecting…"
            : method === "browser"
              ? "Sign in"
              : "Add account"}
        </Button>
      </div>
    </form>
  );
}
