import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { ipc } from "../ipc";
import { nanoid } from "nanoid";
import { accountsAtom, authAccountAtom } from "../../../common/state/auth";
import { useState } from "react";

export default function Page(): React.ReactElement {
  const [daemonId] = useState(nanoid());
  const account = useAtomValue(authAccountAtom);
  const [url, setUrl] = useState("");
  const navigate = useNavigate();

  return (
    <div>
      <h1>Login</h1>
      <input
        type="text"
        placeholder="URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button
        onClick={() =>
          ipc.sendMessage("auth:login", {
            daemonId,
            endpoint: url,
          })
        }
      >
        Login
      </button>
      {account?.auth?.code && account.details === null && (
        <p>Enter the code in the browser: {account.auth.code}</p>
      )}
      {account?.details && (
        <>
          <p>Login successful!</p>
          <button
            onClick={() => {
              navigate("/workspace");
            }}
          >
            Dashboard
          </button>
        </>
      )}
    </div>
  );
}
