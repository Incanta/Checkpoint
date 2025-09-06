import { publicProcedure, router } from "../trpc";
import { AuthenticateDevice } from "@checkpointvcs/client";
import { CreateApiClient } from "@checkpointvcs/common";

export const authRouter = router({
  login: publicProcedure.query(async ({ ctx }) => {
    const code = await new Promise<string>((resolve) =>
      AuthenticateDevice((code) => {
        resolve(code);
      }),
    );

    return { code };
  }),

  getUser: publicProcedure.query(async ({ ctx }) => {
    const client = await CreateApiClient();

    let meResponse: any;
    try {
      meResponse = await client.user.me.query();
    } catch (e: any) {
      throw new Error("Not logged in");
    }

    return { user: meResponse };
  }),
});
