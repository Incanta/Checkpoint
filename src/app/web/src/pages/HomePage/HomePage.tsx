import { useAuth } from "src/auth";

const HomePage = () => {
  const { isAuthenticated, signUp, logIn } = useAuth();

  return (
    <>
      {/* MetaTags, h1, paragraphs, etc. */}

      <p>{JSON.stringify({ isAuthenticated })}</p>
      <button onClick={logIn}>log in</button>
      <button onClick={signUp}>sign up</button>
    </>
  );
};

export default HomePage;
