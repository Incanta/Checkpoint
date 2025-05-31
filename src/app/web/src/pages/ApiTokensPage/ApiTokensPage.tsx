import { useAuth } from "src/authentication";

import { gql, useMutation, useQuery } from "@apollo/client";

import { Form, Submit, TextField } from "@redwoodjs/forms";
import { useState } from "react";

const ME_QUERY = gql`
  query me {
    me {
      id
      email
    }
  }
`;

const TOKENS_QUERY = gql`
  query tokens {
    myApiTokens {
      id
      createdAt
      updatedAt
      expiresAt
      name
    }
  }
`;

const CREATE_API_TOKEN_MUTATION = gql`
  mutation CreateApiToken($name: String!, $deviceCode: String!) {
    createApiToken(name: $name, deviceCode: $deviceCode) {
      id
      token
    }
  }
`;

const DELETE_API_TOKEN_MUTATION = gql`
  mutation DeleteApiToken($id: String!) {
    deleteApiToken(id: $id)
  }
`;

const ApiTokens = () => {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <div>
        Not logged in.{" "}
        <a href="/auth/?show=signin&redirectToPath=tokens">Login</a>
      </div>
    );
  }

  const { data, loading, error } = useQuery(ME_QUERY);

  const {
    data: tokensData,
    loading: tokensLoading,
    error: tokensError,
  } = useQuery(TOKENS_QUERY);

  const [createApiToken] = useMutation(CREATE_API_TOKEN_MUTATION, {
    refetchQueries: [{ query: TOKENS_QUERY }],
  });

  const [deleteApiToken] = useMutation(DELETE_API_TOKEN_MUTATION, {
    refetchQueries: [{ query: TOKENS_QUERY }],
  });

  const [inputValue, setInputValue] = useState("");

  const handleChange = (e) => {
    let value = e.target.value.replace(/-/g, ""); // Remove existing hyphens
    let formattedValue = "";
    for (let i = 0; i < value.length; i++) {
      formattedValue += value[i];
      if ((i + 1) % 4 === 0 && i !== value.length - 1) {
        formattedValue += "-"; // Insert hyphen every four characters
      }
    }
    setInputValue(formattedValue);
  };

  if (loading || tokensLoading) {
    return <div>Loading...</div>;
  }

  if (error || tokensError) {
    return <div>Error: {error?.message || tokensError?.message}</div>;
  }

  return (
    <>
      <button onClick={() => (window.location.href = "/")}>Home</button>
      <br />
      <p>Logged in as {data.me.email}</p>
      <p>API Tokens:</p>
      <Form
        onSubmit={() => {
          const nameInputElement = document.querySelector(
            'input[name="tokenName"]',
          ) as any;
          const deviceCodeInputElement = document.querySelector(
            'input[name="deviceCode"]',
          ) as any;
          createApiToken({
            variables: {
              name: nameInputElement.value,
              deviceCode: deviceCodeInputElement.value,
            },
          });
          nameInputElement.value = "";
          deviceCodeInputElement.value = "";
        }}
      >
        <TextField name="tokenName" placeholder="Token Name" />
        <TextField
          name="deviceCode"
          placeholder="Device Code"
          onChange={handleChange}
          maxLength={9}
          value={inputValue}
          pattern="^\d{4}-\d{4}$"
          title="Device Code must be in the format XXXX-XXXX where X is a number 0-9."
        />{" "}
        <Submit>Create Token</Submit>
      </Form>
      <ul>
        {tokensData.myApiTokens.map((apiToken) => (
          <li key={apiToken.id}>
            <span>
              {apiToken.name} (Created {apiToken.createdAt}, Updated{" "}
              {apiToken.updatedAt})<br />
              <Form
                onSubmit={() => {
                  deleteApiToken({
                    variables: { id: apiToken.id },
                  });
                }}
              >
                <Submit>Delete</Submit>
              </Form>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
};

export default ApiTokens;
