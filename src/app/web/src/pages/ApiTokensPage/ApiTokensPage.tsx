import { useAuth } from "src/authentication";
import { trpc } from "src/utils/trpc";

import { Form, Submit, TextField } from "@redwoodjs/forms";
import { useState } from "react";

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

  const { data: meData, isLoading: meLoading, error: meError } = trpc.users.me.useQuery();

  const { data: tokensData, isLoading: tokensLoading, error: tokensError } = trpc.apiTokens.list.useQuery();

  const utils = trpc.useUtils();

  const createApiTokenMutation = trpc.apiTokens.create.useMutation({
    onSuccess: () => {
      utils.apiTokens.list.invalidate();
    },
  });

  const deleteApiTokenMutation = trpc.apiTokens.delete.useMutation({
    onSuccess: () => {
      utils.apiTokens.list.invalidate();
    },
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

  if (meLoading || tokensLoading) {
    return <div>Loading...</div>;
  }

  if (meError || tokensError) {
    return <div>Error: {meError?.message || tokensError?.message}</div>;
  }

  return (
    <>
      <button onClick={() => (window.location.href = "/")}>Home</button>
      <br />
      <p>Logged in as {meData?.email}</p>
      <p>API Tokens:</p>
      <Form
        onSubmit={() => {
          const nameInputElement = document.querySelector(
            'input[name="tokenName"]',
          ) as any;
          createApiTokenMutation.mutate({
            name: nameInputElement.value,
          });
          nameInputElement.value = "";
          setInputValue("");
        }}
      >
        <TextField name="tokenName" placeholder="Token Name" />
        <Submit>Create Token</Submit>
      </Form>
      <ul>
        {tokensData?.map((apiToken) => (
          <li key={apiToken.id}>
            <span>
              {apiToken.name} (Created {apiToken.createdAt}, Updated{" "}
              {apiToken.updatedAt})<br />
              <Form
                onSubmit={() => {
                  deleteApiTokenMutation.mutate({
                    id: apiToken.id,
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
