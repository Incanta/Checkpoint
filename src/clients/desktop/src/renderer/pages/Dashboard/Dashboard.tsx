import { Avatar } from "primereact/avatar";
import { Splitter, SplitterPanel } from "primereact/splitter";
import Button from "../../components/Button";
import TitleBar from "../../components/TitleBar";
import { Button as UIButton, Card, EmptyState } from "../../components/ui";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { useEffect, useState, Fragment } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspacesAtom,
} from "../../../common/state/workspace";
import { faFolder } from "@fortawesome/free-solid-svg-icons/faFolder";
import { faFolderOpen } from "@fortawesome/free-solid-svg-icons/faFolderOpen";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare";
import { faNetworkWired } from "@fortawesome/free-solid-svg-icons/faNetworkWired";
import { faLinkSlash } from "@fortawesome/free-solid-svg-icons/faLinkSlash";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ipc } from "../ipc";
import { Dropdown } from "primereact/dropdown";
import { currentUserAtom, usersAtom } from "../../../common/state/auth";
import { useNavigate } from "react-router";
import {
  dashboardNewWorkspaceFolderAtom,
  dashboardOrgsAtom,
  dashboardReposAtom,
} from "../../../common/state/dashboard";

// Shared PrimeReact Dropdown passthrough so the Accounts/Orgs selectors read as
// tokenized inputs, matching the workspace header treatment.
const dropdownPt = {
  root: {
    className:
      "inline-flex items-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] pl-3 pr-2 py-1 transition-colors hover:border-[var(--color-text-muted)]",
  },
  input: {
    className:
      "text-sm text-[var(--color-text-primary)] outline-none bg-transparent",
  },
  trigger: { className: "ml-2 text-[var(--color-text-muted)]" },
};

// Shared PrimeReact Dialog passthrough. No PrimeReact base theme is imported,
// so header/content/footer have no padding of their own: we supply token
// surfaces, borders, rounding, spacing, and a styled close button here.
const dialogPt = {
  root: {
    className:
      "rounded-lg border border-[var(--color-border-default)] shadow-xl overflow-hidden",
  },
  header: {
    className:
      "flex items-center justify-between gap-4 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-5 py-3.5 text-base font-semibold text-[var(--color-text-primary)]",
  },
  content: {
    className:
      "bg-[var(--color-bg-secondary)] px-5 py-5 text-[var(--color-text-secondary)]",
  },
  footer: {
    className:
      "border-t border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-5 py-3.5",
  },
  closeButton: {
    className:
      "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]",
  },
};

// Token class for the create-dialog text inputs (also needs its own padding
// since PrimeReact's InputText theme is absent).
const inputClassName =
  "w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]";

export default function Dashboard(): React.ReactElement {
  const users = useAtomValue(usersAtom);
  const [currentUser, setCurrentUser] = useAtom(currentUserAtom);
  const navigate = useNavigate();
  const orgs = useAtomValue(dashboardOrgsAtom);
  const repos = useAtomValue(dashboardReposAtom);
  const workspaces = useAtomValue(workspacesAtom);
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const [dashboardNewWorkspaceFolder, setDashboardNewWorkspaceFolder] = useAtom(
    dashboardNewWorkspaceFolderAtom,
  );

  const [currentOrgId, setCurrentOrgId] = useState<string | null>(
    currentWorkspace?.orgId || null,
  );

  const [isCreateWorkspaceDialogVisible, setIsCreateWorkspaceDialogVisible] =
    useState(false);
  const [workspaceFormRepoId, setWorkspaceFormRepoId] = useState<string | null>(
    null,
  );
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [workspacePathInput, setWorkspacePathInput] = useState("");
  const selectedWorkspaceRepo = workspaceFormRepoId
    ? repos.find((repo) => repo.id === workspaceFormRepoId)
    : null;
  const isWorkspaceFormInvalid =
    workspaceNameInput.trim() === "" || workspacePathInput.trim() === "";

  const resetWorkspaceForm = () => {
    setWorkspaceFormRepoId(null);
    setWorkspaceNameInput("");
    setWorkspacePathInput("");
    setDashboardNewWorkspaceFolder("");
  };

  const [unlinkTarget, setUnlinkTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const handleLogout = () => {
    if (!currentUser) return;
    ipc.sendMessage("auth:logout", { daemonId: currentUser.daemonId });
  };

  const handleUnlinkWorkspace = () => {
    if (!unlinkTarget) return;
    ipc.sendMessage("workspace:unlink", { workspaceId: unlinkTarget.id });
    setUnlinkTarget(null);
  };

  const openCreateWorkspaceDialog = (repoId: string) => {
    setWorkspaceFormRepoId(repoId);
    setIsCreateWorkspaceDialogVisible(true);
  };

  const hideCreateWorkspaceDialog = () => {
    setIsCreateWorkspaceDialogVisible(false);
    resetWorkspaceForm();
  };

  const handleBrowseWorkspacePath = async () => {
    ipc.sendMessage("dashboard:select-workspace-folder", null);
  };

  const handleCreateWorkspace = () => {
    if (!workspaceFormRepoId) {
      hideCreateWorkspaceDialog();
      return;
    }

    ipc.sendMessage("workspace:create", {
      repoId: workspaceFormRepoId,
      name: workspaceNameInput,
      path: workspacePathInput,
      defaultBranchName: "main",
    });

    hideCreateWorkspaceDialog();
  };

  useEffect(() => {
    setWorkspacePathInput(dashboardNewWorkspaceFolder);
  }, [dashboardNewWorkspaceFolder]);

  useEffect(() => {
    if (users && users.length > 0 && !currentUser) {
      setCurrentUser(users[0]);
    }
  }, [users]);

  useEffect(() => {
    if (currentUser && orgs.length > 0 && !currentOrgId) {
      setCurrentOrgId(orgs[0].id);
    }
  }, [currentUser, orgs, currentOrgId]);

  useEffect(() => {
    ipc.sendMessage("dashboard:refresh", {
      daemonId: currentUser?.daemonId || null,
      orgId: currentOrgId,
    });
  }, [currentUser, currentOrgId]);

  return (
    <div className="bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      <TitleBar
        left={<span className="text-sm font-semibold">Checkpoint</span>}
      />
      {/*
        Top-level route (not inside the bounded Workspace shell), so size from
        the viewport rather than a percentage chain. Subtract the titlebar
        (40px), the header row (3rem), the p-6 vertical padding (3rem), and the
        grid gap (1rem) so the content fits with the bottom padding visible.
      */}
      <div className="p-6 grid grid-rows-[3rem_calc(100vh-3rem-3rem-1rem-40px)] gap-4">
        <div className="flex items-center gap-2">
          {currentUser?.details && (
            <Avatar
              image={currentUser.details.image ?? undefined}
              label={
                currentUser.details.image
                  ? undefined
                  : (
                      currentUser.details.name ??
                      currentUser.details.email ??
                      "?"
                    )
                      .charAt(0)
                      .toUpperCase()
              }
              shape="circle"
              size="normal"
              className="mr-[0.5rem]"
              style={{
                backgroundColor: currentUser.details.image
                  ? "transparent"
                  : "var(--color-bg-surface)",
                color: "var(--color-text-primary)",
              }}
            />
          )}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Accounts
            </span>
            <Dropdown
              value={currentUser?.details?.id || null}
              options={users
                ?.filter((user) => user.details !== null)
                .map((user) => ({
                  label: user.details!.username || user.details!.email,
                  value: user.details!.id,
                }))
                .concat(
                  { label: "Add login credentials...", value: "add" },
                  { label: "Logout", value: "logout" },
                )}
              placeholder="Select a User"
              pt={dropdownPt}
              onChange={(e) => {
                if (e.value === "add") {
                  setCurrentUser(null);
                  navigate("/login", { state: { from: "dashboard" } });
                } else if (e.value === "logout") {
                  handleLogout();
                } else {
                  const selectedUser = users?.find(
                    (user) => user.details?.id === e.value,
                  );
                  if (selectedUser) {
                    setCurrentUser(selectedUser);
                  }
                }
              }}
            />
          </div>
          <div className="self-stretch w-[2rem] flex justify-center">
            <div className="w-[0.125rem] h-[60%] m-auto bg-[var(--color-border-default)] rounded-full" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Orgs
            </span>
            <Dropdown
              value={currentOrgId}
              options={orgs.map((org) => ({ label: org.name, value: org.id }))}
              onChange={(e) => {
                setCurrentOrgId(e.value);
              }}
              placeholder="Select an Organization"
              pt={dropdownPt}
            />
          </div>
        </div>
        <div className="row-span-1">
          <Splitter
            layout="horizontal"
            className="w-full h-full"
            pt={{
              gutter: {
                className: "config-splitter-gutter h-full",
              },
            }}
          >
            <SplitterPanel
              size={40}
              minSize={20}
              className="rounded-lg pr-5 mr-1"
            >
              <div className="w-full h-full grid grid-rows-[2.5rem_calc(100%-2.5rem)]">
                <div className="flex items-center p-2">
                  <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Repositories
                  </span>
                  <Button
                    label={<FontAwesomeIcon icon={faPlus} />}
                    tooltip="Create new repository..."
                    className="ml-[1rem] text-[0.8em] p-[0.25rem]"
                  />
                </div>
                <div className="p-2 overflow-y-auto h-full space-y-2">
                  {repos.map((repo) => (
                    <Fragment key={repo.id}>
                      <Card
                        padding={false}
                        className="grid grid-cols-[1.75rem_minmax(0,1fr)_3rem] items-center p-3"
                      >
                        <div className="col-span-1 text-[var(--color-text-secondary)]">
                          <FontAwesomeIcon icon={faNetworkWired} />
                        </div>
                        <div
                          className="col-span-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-primary)]"
                          title={repo.name}
                        >
                          {repo.name}
                        </div>
                        <div className="col-span-1">
                          <Button
                            label={<FontAwesomeIcon icon={faPlus} />}
                            tooltip="Create new workspace..."
                            className="ml-[1rem] text-[0.8em] p-[0.25rem]"
                            onClick={() => openCreateWorkspaceDialog(repo.id)}
                          />
                        </div>
                      </Card>
                      {workspaces
                        ?.filter((ws) => ws.repoId === repo.id)
                        .map((ws) => (
                          <div
                            key={ws.id}
                            className="ml-9 grid grid-cols-[1.75rem_minmax(0,1fr)_5.5rem] items-center rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3"
                          >
                            <div className="col-span-1">
                              <FontAwesomeIcon
                                icon={
                                  ws.id === currentWorkspace?.id
                                    ? faFolderOpen
                                    : faFolder
                                }
                                style={{
                                  color:
                                    ws.id === currentWorkspace?.id
                                      ? "var(--color-files)"
                                      : "var(--color-text-secondary)",
                                }}
                              />
                            </div>
                            <div className="grid grid-flow-row auto-rows col-span-1 min-w-0">
                              <div
                                className="text-[0.9em] overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-primary)]"
                                title={ws.name}
                              >
                                {ws.name}
                              </div>
                              <div
                                className="text-[0.6em] overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-muted)]"
                                title={ws.localPath}
                              >
                                {ws.localPath}
                              </div>
                            </div>
                            <div className="col-span-1 flex gap-1 justify-end">
                              <Button
                                label={
                                  <FontAwesomeIcon
                                    icon={faArrowUpRightFromSquare}
                                  />
                                }
                                tooltip="Open workspace"
                                className="text-[0.8em] p-[0.25rem]"
                                onClick={() => {
                                  ipc.sendMessage("workspace:select", {
                                    id: ws.id,
                                  });
                                }}
                              />
                              <Button
                                label={<FontAwesomeIcon icon={faLinkSlash} />}
                                tooltip="Unlink workspace"
                                className="text-[0.8em] p-[0.25rem]"
                                onClick={() => {
                                  setUnlinkTarget({
                                    id: ws.id,
                                    name: ws.name,
                                  });
                                }}
                              />
                            </div>
                          </div>
                        ))}
                    </Fragment>
                  ))}
                </div>
              </div>
            </SplitterPanel>
            <SplitterPanel
              size={60}
              minSize={30}
              className="rounded-lg pl-5 ml-1"
              style={{ zIndex: 1 }}
            >
              <div className="w-full h-full grid grid-rows-[2.5rem_calc(100%-2.5rem)]">
                <div className="flex items-center p-2">
                  <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Repository / Workspace Details
                  </span>
                </div>
                <div className="flex h-full items-center justify-center">
                  <EmptyState
                    icon={
                      <FontAwesomeIcon
                        icon={faFolderOpen}
                        className="text-3xl"
                      />
                    }
                    title="Nothing selected"
                    description="Select a repository or workspace on the left to see its details here."
                  />
                </div>
              </div>
            </SplitterPanel>
          </Splitter>
        </div>
      </div>
      <Dialog
        header="Create Workspace"
        visible={isCreateWorkspaceDialogVisible}
        style={{ width: "32rem" }}
        pt={dialogPt}
        modal
        onHide={hideCreateWorkspaceDialog}
        footer={
          <div className="flex w-full justify-end gap-2">
            <UIButton
              type="button"
              variant="secondary"
              onClick={hideCreateWorkspaceDialog}
            >
              Cancel
            </UIButton>
            <UIButton
              type="button"
              onClick={handleCreateWorkspace}
              disabled={isWorkspaceFormInvalid}
            >
              Create Workspace
            </UIButton>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          {selectedWorkspaceRepo && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-bg-surface)] px-3 py-2 text-xs">
              <FontAwesomeIcon
                icon={faNetworkWired}
                className="text-[var(--color-text-muted)]"
              />
              <span className="text-[var(--color-text-secondary)]">
                Repository
              </span>
              <span className="font-medium text-[var(--color-text-primary)]">
                {currentOrgId !== null
                  ? orgs.find((o) => o.id === currentOrgId)?.name + " / "
                  : ""}
                {selectedWorkspaceRepo.name}
              </span>
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              Workspace Name
            </span>
            <InputText
              className={inputClassName}
              value={workspaceNameInput}
              onChange={(e) => setWorkspaceNameInput(e.target.value)}
              placeholder="My Workspace"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              Workspace Path
            </span>
            <div className="flex gap-2">
              <InputText
                className={`flex-1 ${inputClassName}`}
                value={workspacePathInput}
                onChange={(e) => setWorkspacePathInput(e.target.value)}
                placeholder="C:\\Projects\\MyWorkspace"
              />
              <UIButton
                type="button"
                variant="secondary"
                onClick={handleBrowseWorkspacePath}
              >
                Browse
              </UIButton>
            </div>
          </label>
        </div>
      </Dialog>
      <Dialog
        header="Unlink Workspace"
        visible={unlinkTarget !== null}
        style={{ width: "28rem" }}
        pt={dialogPt}
        modal
        onHide={() => setUnlinkTarget(null)}
        footer={
          <div className="flex w-full justify-end gap-2">
            <UIButton
              type="button"
              variant="secondary"
              onClick={() => setUnlinkTarget(null)}
            >
              Cancel
            </UIButton>
            <UIButton
              type="button"
              variant="danger"
              onClick={handleUnlinkWorkspace}
            >
              Unlink
            </UIButton>
          </div>
        }
      >
        <p className="text-[0.9em] text-[var(--color-text-secondary)]">
          Are you sure you want to unlink{" "}
          <strong className="text-[var(--color-text-primary)]">
            {unlinkTarget?.name}
          </strong>
          ? The workspace directory will not be deleted, but Checkpoint will
          stop tracking changes.
        </p>
      </Dialog>
    </div>
  );
}
