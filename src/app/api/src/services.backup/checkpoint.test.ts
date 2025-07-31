import type { Org, Repo, User } from "@prisma/client";

import { createUser } from "./users";
import { RedwoodUser } from "src/lib/auth";
import { createOrg, myOrgs } from "./orgs/orgs";
import { createRepo, repos, repo } from "./repos/repos";

// Generated boilerplate tests do not account for all circumstances
// and can fail without adjustments, e.g. Float.
//           Please refer to the RedwoodJS Testing Docs:
//       https://redwoodjs.com/docs/testing#testing-services
// https://redwoodjs.com/docs/testing#jest-expect-type-considerations

describe("Checkpoint", () => {
  let mockContext: any;
  const userName = "Foo Bar";
  const userUsername = "user";
  const userEmail = "user@email.com";
  let orgId: string;

  test("creates a user", async () => {
    const result = await createUser({
      input: {
        name: userName,
        username: userUsername,
        email: userEmail,
      },
    });

    expect(result.name).toEqual(userName);
    expect(result.username).toEqual(userUsername);
    expect(result.email).toEqual(userEmail);

    mockContext = { context: { currentUser: result } };
  });

  test("returns no orgs for user", async () => {
    const orgs = await myOrgs({}, mockContext);

    expect(orgs.length).toBe(0);
  });

  test("creates an org", async () => {
    const org = await createOrg(
      { input: { name: "org" } },
      mockContext
    );

    expect(org.name).toEqual("org");

    const orgs = await myOrgs({}, mockContext);
    expect(orgs.length).toBe(1);
    const myOrg = orgs[0] as Org;
    expect(myOrg.name).toBe("org");
    orgId = myOrg.id;
  });

  test("creates a repo", async () => {
    const cratedRepo = await createRepo({
      input: {
        name: "repo",
        orgId,
      },
    }, mockContext);

    expect(cratedRepo.name).toBe("repo");

    const orgRepos = await repos({ orgId }, mockContext);

    expect(orgRepos.length).toBe(1);
    const myRepo = orgRepos[0] as Repo;
    expect(myRepo.id).toEqual(cratedRepo.id);
    expect(myRepo.id).not.toBeNull();
    expect(myRepo.id).not.toBe("")

    const otherRepo = await repo({ id: myRepo.id }, mockContext);
    expect(otherRepo.id).toEqual(myRepo.id);
  });
});
