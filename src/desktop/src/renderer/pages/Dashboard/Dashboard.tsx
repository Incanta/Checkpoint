import { Splitter, SplitterPanel } from "primereact/splitter";
import Button from "../../components/Button";
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
import { useNavigate } from "react-router-dom";
import {
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

  const [currentOrgId, setCurrentOrgId] = useState<string | null>(
    currentWorkspace?.orgId || null,
  );

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
                              <div className="text-[0.6em]" title={ws.rootPath}>
                                {ws.rootPath}
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
    </div>
  );
}
