import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAtomValue } from "jotai";
import { usersAtom } from "../../../common/state/auth";
import { currentWorkspaceAtom } from "../../../common/state/workspace";
import { daemonConnectionAtom } from "../../../common/state/daemon";
import ConnectingScreen from "../../components/ConnectingScreen";

export default function Loading(): React.ReactElement {
  const users = useAtomValue(usersAtom);
  const workspace = useAtomValue(currentWorkspaceAtom);
  const connection = useAtomValue(daemonConnectionAtom);
  const navigate = useNavigate();

  useEffect(() => {
    if (connection !== "connected" || users === null) {
      return;
    }

    navigate(
      users.length === 0 ? "/login" : workspace ? "/workspace" : "/dashboard",
    );
  }, [connection, users, workspace, navigate]);

  // Until the daemon answers (and we've decided where to route), show the
  // connecting screen. It surfaces a "is the daemon running?" hint if the
  // connection is slow.
  return <ConnectingScreen />;
}
