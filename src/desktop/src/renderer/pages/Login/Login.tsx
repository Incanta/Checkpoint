import { useAtomValue } from "jotai";
import { useNavigate } from "react-router";
import { ipc } from "../ipc";
import { nanoid } from "nanoid";
import { currentUserAtom } from "../../../common/state/auth";
import { useState } from "react";

export default function Login(): React.ReactElement {
  const [daemonId] = useState(nanoid());
  const user = useAtomValue(currentUserAtom);
  const [url, setUrl] = useState("http://checkpoint.localhost:3000");
  const navigate = useNavigate();

  if (user?.details) {
    setTimeout(() => navigate("/dashboard"), 0);
  }

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
        {user?.auth?.code && user.details === null && (
          <p>Enter the code in the browser: {user.auth.code}</p>
        )}
      </div>
    </div>
  );
}
