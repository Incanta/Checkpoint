import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { usersAtom } from "../../../common/state/auth";
import { currentWorkspaceAtom } from "../../../common/state/workspace";

export default function Loading(): React.ReactElement {
  const users = useAtomValue(usersAtom);
  const workspace = useAtomValue(currentWorkspaceAtom);
  const navigate = useNavigate();

  if (users === null) {
    return <div>Loading...</div>;
  }

  setTimeout(() => {
    navigate(
      users.length === 0 ? "/welcome" : workspace ? "/workspace" : "/dashboard",
    );
  }, 0);

  return <div />;
}
