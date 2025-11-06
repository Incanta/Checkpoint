import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { ipc } from "../ipc";
import { nanoid } from "nanoid";
import { currentAccount } from "../../../common/state/auth";
import { useState } from "react";

export default function Page(): React.ReactElement {
  const [daemonId] = useState(nanoid());
  const account = useAtomValue(currentAccount);
  const [url, setUrl] = useState("https://checkpointvcs.com");
  const navigate = useNavigate();

  return (
    <div className="grid">
      <div className="row-span-1 ">
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
    </div>
  );
}
