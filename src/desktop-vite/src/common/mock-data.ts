import { Account } from "./state/auth";

export namespace MockedData {
  export const accounts: Account[] = [
    {
      id: "1",
      serverEndpoint: "https://checkpointvcs.com",
      email: "user@gmail.com",
      username: "user1",
      name: "User One",
    },
  ];
}
