import { useAuth } from "src/authentication";
import { trpc } from "src/utils/trpc";

import { Form, Submit, TextField } from "@redwoodjs/forms";

const HomePage = () => {
  const { isAuthenticated, signUp, logIn, logOut, userMetadata } = useAuth();

  const { data: meData, isLoading: meLoading, error: meError } = trpc.users.me.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  const { data: orgsData, isLoading: orgsLoading, error: orgsError } = trpc.orgs.myOrgs.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  const utils = trpc.useUtils();

  const createOrgMutation = trpc.orgs.create.useMutation({
    onSuccess: () => {
      utils.orgs.myOrgs.invalidate();
    },
  });

  const createRepoMutation = trpc.repos.create.useMutation({
    onSuccess: () => {
      utils.orgs.myOrgs.invalidate();
    },
  });

  if (!isAuthenticated) {
    return (
      <>
        <button onClick={() => logIn()}>log in</button>
        <br />
        <button onClick={() => signUp()}>sign up</button>
      </>
    );
  }

  if (meLoading || orgsLoading) {
    return <div>Loading...</div>;
  }

  if (meError || orgsError) {
    return <div>Error: {meError?.message || orgsError?.message}</div>;
  }

  return (
    <>
      <button onClick={() => logOut()}>log out</button>
      <br />
      <p>Logged in as {meData?.email}</p>
      <p>Orgs:</p>
      <Form
        onSubmit={() => {
          const inputElement = document.querySelector(
            'input[name="orgName"]',
          ) as any;
          createOrgMutation.mutate({ name: inputElement.value });
          inputElement.value = "";
        }}
      >
        <TextField name="orgName" placeholder="New org name" />{" "}
        <Submit>Create Org</Submit>
      </Form>
      <ul>
        {orgsData?.map((org) => (
          <li key={org.id}>
            <span>
              {org.name} ({org.id})<br />
              <Form
                onSubmit={() => {
                  const inputElement = document.querySelector(
                    `input[name="repoName-${org.id}"]`,
                  ) as any;
                  createRepoMutation.mutate({
                    orgId: org.id, 
                    name: inputElement.value 
                  });
                  inputElement.value = "";
                }}
              >
                <TextField
                  name={`repoName-${org.id}`}
                  placeholder="New repo name"
                />{" "}
                <Submit>Create Repo</Submit>
              </Form>
            </span>
            <ul>
              {org.repos?.map((repo) => (
                <li key={repo.id}>
                  {repo.name} ({repo.id})
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
};

export default HomePage;
