import { useNavigate } from "react-router";

export default function Page(): React.ReactElement {
  const navigate = useNavigate();

  return (
    <div>
      Welcome
      <br />
      <button onClick={() => navigate("/login")}>Go to Login</button>
    </div>
  );
}
