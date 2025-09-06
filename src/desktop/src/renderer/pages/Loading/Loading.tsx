import { useAtomValue } from "jotai";
import { accountsAtom } from "../../../common/state/auth";

export default function Page(): React.ReactElement {
  const accounts = useAtomValue(accountsAtom);

  if (accounts === null) {
    return <div>Loading...</div>;
  }

  window.location.href = accounts.length === 0 ? "/welcome" : "/dashboard";

  return <div />;
}
