import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { accountsAtom } from "../../../common/state/auth";

export default function Loading(): React.ReactElement {
  const accounts = useAtomValue(accountsAtom);
  const navigate = useNavigate();

  if (accounts === null) {
    return <div>Loading...</div>;
  }

  navigate(accounts.length === 0 ? "/welcome" : "/dashboard");

  return <div />;
}
