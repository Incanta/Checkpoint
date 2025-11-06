import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { usersAtom } from "../../../common/state/auth";

export default function Loading(): React.ReactElement {
  const users = useAtomValue(usersAtom);
  const navigate = useNavigate();

  if (users === null) {
    return <div>Loading...</div>;
  }

  navigate(users.length === 0 ? "/welcome" : "/dashboard");

  return <div />;
}
