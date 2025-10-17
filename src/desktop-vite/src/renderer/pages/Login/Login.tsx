import { useAtom } from "jotai";
import { authAttemptAtom } from "../../../common/state/auth";
import { useNavigate } from "react-router-dom";
import { ipc } from "../ipc";

export default function Page(): React.ReactElement {
  const [authAttempt, setAuthAttempt] = useAtom(authAttemptAtom);
  const navigate = useNavigate();

  return (
    <div>
      <h1>Login</h1>
      <input type="text" placeholder="URL" />
      <button
        onClick={() =>
          ipc.sendMessage("auth:login", {
            endpoint: "test",
          })
        }
      >
        Login
      </button>
      {authAttempt && authAttempt.authCode && !authAttempt.finished && (
        <p>Enter the code in the browser: {authAttempt.authCode}</p>
      )}
      {authAttempt && authAttempt.finished && (
        <>
          <p>Login successful!</p>
          <button
            onClick={() => {
              setAuthAttempt(null);
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
