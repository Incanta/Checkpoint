import { Splitter, SplitterPanel } from "primereact/splitter";
import Button from "../../components/Button";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { useEffect, useState } from "react";
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
    <div>
      <div className="p-[1.5rem] grid grid-rows-[2.5rem_calc(100vh-2.5rem-3rem-30px)] gap-4">
        <div className="row-span-1">
          <Dropdown
            value={currentUser?.details?.id || null}
            options={users
              ?.filter((user) => user.details !== null)
              .map((user) => ({
                label: user.details!.username || user.details!.email,
                value: user.details!.id,
              }))
              .concat({ label: "Add login credentials...", value: "add" })}
            placeholder="Select a User"
            onChange={(e) => {
              if (e.value === "add") {
                setCurrentUser(null);
                navigate("/login");
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
          <Dropdown
            value={currentOrgId}
            options={orgs.map((org) => ({ label: org.name, value: org.id }))}
            onChange={(e) => {
              setCurrentOrgId(e.value);
            }}
            placeholder="Select an Organization"
            className="ml-[0.5rem]"
          />
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
              style={{
                borderColor: "#181818",
                borderWidth: "0.12rem",
                borderRadius: "0.5rem",
                borderStyle: "solid",
                marginRight: "0.25rem",
              }}
            >
              <div className="w-full h-full grid grid-rows-[2.5rem_calc(100%-2.5rem)]">
                <div
                  style={{
                    padding: "0.5rem",
                    borderColor: "#1A1A1A",
                    borderWidth: "0 0 1px 0",
                    borderStyle: "solid",
                  }}
                >
                  <span>Repositories</span>
                  <Button
                    label={<FontAwesomeIcon icon={faPlus} />}
                    tooltip="Create new repository..."
                    className="ml-[1rem] text-[0.8em] p-[0.25rem]"
                  />
                </div>
                <div className="p-[0.5rem] overflow-y-auto h-full">
                  {repos.map((repo) => (
                    <>
                      <div
                        key={repo.id}
                        style={{
                          padding: "0.5rem",
                          margin: "0.5rem",
                          borderWidth: "0",
                          borderRadius: "0.25rem",
                          backgroundColor: "#343434",
                          boxShadow:
                            "0.13rem 0.13rem 0.13rem rgba(0, 0, 0, 0.3)",
                        }}
                        className="grid grid-cols-[1.75rem_auto_3rem] items-center"
                      >
                        <div className="col-span-1">
                          <FontAwesomeIcon icon={faNetworkWired} />
                        </div>
                        <div className="col-span-1">{repo.name}</div>
                        <div className="col-span-1">
                          <Button
                            label={<FontAwesomeIcon icon={faPlus} />}
                            tooltip="Create new workspace..."
                            className="ml-[1rem] text-[0.8em] p-[0.25rem]"
                            onClick={() => openCreateWorkspaceDialog(repo.id)}
                          />
                        </div>
                      </div>
                      {workspaces
                        ?.filter((ws) => ws.repoId === repo.id)
                        .map((ws) => (
                          <div
                            key={ws.id}
                            style={{
                              padding: "0.5rem",
                              margin: "0.5rem",
                              marginLeft: "3rem",
                              borderWidth: "0",
                              borderRadius: "0.25rem",
                              backgroundColor: "#343434",
                              boxShadow:
                                "0.13rem 0.13rem 0.13rem rgba(0, 0, 0, 0.3)",
                            }}
                            className="grid grid-cols-[1.75rem_auto_3rem] items-center"
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
                                      ? "#FFCA3B"
                                      : "",
                                }}
                              />
                            </div>
                            <div className="grid grid-flow-row auto-rows col-span-1">
                              <div className="text-[0.9em]" title={ws.name}>
                                {ws.name}
                              </div>
                              <div
                                className="text-[0.6em]"
                                title={ws.localPath}
                              >
                                {ws.localPath}
                              </div>
                            </div>
                            <div className="col-span-1">
                              <Button
                                label={
                                  <FontAwesomeIcon
                                    icon={faArrowUpRightFromSquare}
                                  />
                                }
                                tooltip="Open workspace"
                                className="ml-[1rem] text-[0.8em] p-[0.25rem]"
                                onClick={() => {
                                  ipc.sendMessage("workspace:select", {
                                    id: ws.id,
                                  });
                                }}
                              />
                            </div>
                          </div>
                        ))}
                    </>
                  ))}
                </div>
              </div>
            </SplitterPanel>
            <SplitterPanel
              size={60}
              minSize={30}
              style={{
                zIndex: 1,
                borderColor: "#1A1A1A",
                borderWidth: "1px",
                borderRadius: "0.5rem",
                borderStyle: "solid",
                marginLeft: "0.25rem",
              }}
            >
              <div className="w-full h-full grid grid-rows-[2.5rem_calc(100%-2.5rem)]">
                <div
                  style={{
                    padding: "0.5rem",
                    borderColor: "#1A1A1A",
                    borderWidth: "0 0 1px 0",
                    borderStyle: "solid",
                  }}
                >
                  Repository / Workspace Details
                </div>
                <div></div>
              </div>
            </SplitterPanel>
          </Splitter>
        </div>
      </div>
      <Dialog
        header="Create Workspace"
        visible={isCreateWorkspaceDialogVisible}
        style={{
          width: "32rem",
          backgroundColor: "#2C2C2C",
          padding: "1rem",
          borderRadius: "0.5rem",
          boxShadow: "0.2rem 0.2rem 2rem 0.1rem #00000094",
        }}
        modal
        onHide={hideCreateWorkspaceDialog}
        footer={
          <div className="flex w-full justify-end gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded bg-[#3b3b3b] text-white"
              onClick={hideCreateWorkspaceDialog}
            >
              Cancel
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded bg-[#2563EB] text-white disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleCreateWorkspace}
              disabled={isWorkspaceFormInvalid}
            >
              Create Workspace
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {selectedWorkspaceRepo && (
            <div className="text-[0.8em] text-white/70">
              Repository:{" "}
              <span className="text-white">
                {currentOrgId !== null
                  ? orgs.find((o) => o.id === currentOrgId)?.name + " / "
                  : ""}
                {selectedWorkspaceRepo.name}
              </span>
            </div>
          )}
          <label className="flex flex-col gap-2 text-[0.85em]">
            <span>Workspace Name</span>
            <InputText
              className="w-full"
              value={workspaceNameInput}
              onChange={(e) => setWorkspaceNameInput(e.target.value)}
              placeholder="My Workspace"
            />
          </label>
          <label className="flex flex-col gap-2 text-[0.85em]">
            <span>Workspace Path</span>
            <div className="flex gap-2">
              <InputText
                className="flex-1"
                value={workspacePathInput}
                onChange={(e) => setWorkspacePathInput(e.target.value)}
                placeholder="C:\\Projects\\MyWorkspace"
              />
              <button
                type="button"
                className="px-3 py-2 rounded bg-[#3b3b3b] text-white"
                onClick={handleBrowseWorkspacePath}
              >
                Browse
              </button>
            </div>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
