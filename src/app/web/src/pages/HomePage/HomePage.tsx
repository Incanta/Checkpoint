import { useAuth } from "src/auth";

import { gql, useMutation, useQuery } from "@apollo/client";

import { Form, Submit, TextField } from "@redwoodjs/forms";

const ME_QUERY = gql`
  query {
    me {
      id
      email
    }
  }
`;

const ORGS_QUERY = gql`
  query {
    myOrgs {
      id
      name
      repos {
        id
        name
      }
    }
  }
`;

const CREATE_ORG_MUTATION = gql`
  mutation CreateOrg($name: String!) {
    createOrg(input: { name: $name }) {
      id
      name
    }
  }
`;

const CREATE_REPO_MUTATION = gql`
  mutation CreateRepo($orgId: String!, $name: String!) {
    createRepo(input: { orgId: $orgId, name: $name }) {
      id
      name
    }
  }
`;

const HomePage = () => {
  const { isAuthenticated, signUp, logIn, logOut, userMetadata } = useAuth();

  const { data, loading, error } = useQuery(ME_QUERY);

  const {
    data: orgsData,
    loading: orgsLoading,
    error: orgsError,
  } = useQuery(ORGS_QUERY);

  const [createOrg] = useMutation(CREATE_ORG_MUTATION, {
    refetchQueries: [{ query: ORGS_QUERY }],
  });

  const [createRepo] = useMutation(CREATE_REPO_MUTATION, {
    refetchQueries: [{ query: ORGS_QUERY }],
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

  if (loading || orgsLoading) {
    return <div>Loading...</div>;
  }

  if (error || orgsError) {
    return <div>Error: {error?.message || orgsError?.message}</div>;
  }

  return (
    <>
      <button onClick={() => logOut()}>log out</button>
      <br />
      <p>Logged in as {data.me.email}</p>
      <p>Orgs:</p>
      <Form
        onSubmit={() => {
          const inputElement = document.querySelector(
            'input[name="orgName"]',
          ) as any;
          createOrg({ variables: { name: inputElement.value } });
          inputElement.value = "";
        }}
      >
        <TextField name="orgName" placeholder="New org name" />{" "}
        <Submit>Create Org</Submit>
      </Form>
      <ul>
        {orgsData.myOrgs.map((org) => (
          <li key={org.id}>
            <span>
              {org.name} ({org.id})<br />
              <Form
                onSubmit={() => {
                  const inputElement = document.querySelector(
                    `input[name="repoName-${org.id}"]`,
                  ) as any;
                  createRepo({
                    variables: { orgId: org.id, name: inputElement.value },
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
              {org.repos.map((repo) => (
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
