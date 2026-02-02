import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestEnvironment, type TestEnvironment } from "../fixtures";
import {
  createTestWorkspace,
  createTestFile,
  readTestFile,
  listTestFiles,
  type TestWorkspace,
} from "../utils";
import { promises as fs } from "fs";

describe("System Integration Tests", () => {
  let env: TestEnvironment;
  let testWorkspaces: TestWorkspace[] = [];

  beforeAll(async () => {
    env = await createTestEnvironment();
  }, 60000);

  afterAll(async () => {
    // Clean up all test workspaces
    for (const workspace of testWorkspaces) {
      try {
        await workspace.cleanup();
      } catch (e) {
        console.warn(`Failed to cleanup workspace: ${e}`);
      }
    }
  });

  it("should complete full workflow: org creation, repo, workspace, version, collaboration", async () => {
    // ========================================
    // Step 1: users[0] creates an organization
    // ========================================
    const orgName = `test-org-${Date.now()}`;
    const org = await env.users[0].apiClient.org.createOrg.mutate({
      name: orgName,
    });

    expect(org).toBeDefined();
    expect(org.id).toBeDefined();
    expect(org.name).toBe(orgName);

    console.log(`[Step 1] Created organization: ${org.name} (${org.id})`);

    // ========================================
    // Step 2: users[0] creates a repo in that org
    // ========================================
    const repoName = `test-repo-${Date.now()}`;
    const repo = await env.users[0].apiClient.repo.createRepo.mutate({
      name: repoName,
      orgId: org.id,
    });

    expect(repo).toBeDefined();
    expect(repo.id).toBeDefined();
    expect(repo.name).toBe(repoName);
    expect(repo.orgId).toBe(org.id);

    console.log(`[Step 2] Created repository: ${repo.name} (${repo.id})`);

    // ========================================
    // Step 3: users[0] creates a workspace via daemon API and local folder
    // ========================================
    const user0Workspace = await createTestWorkspace(
      `user0-workspace-${Date.now()}`,
    );
    testWorkspaces.push(user0Workspace);

    // Ensure the local folder exists
    await fs.mkdir(user0Workspace.path, { recursive: true });

    // Create workspace in the system via daemon
    const workspaceResponse =
      await env.users[0].daemonClient.workspaces.create.mutate({
        daemonId: env.users[0].daemonId,
        name: user0Workspace.name,
        repoId: repo.id,
        path: user0Workspace.path,
        defaultBranchName: "main",
      });

    expect(workspaceResponse).toBeDefined();
    expect(workspaceResponse.workspace).toBeDefined();
    expect(workspaceResponse.workspace.id).toBeDefined();
    expect(workspaceResponse.workspace.repoId).toBe(repo.id);

    const user0WorkspaceId = workspaceResponse.workspace.id;

    console.log(
      `[Step 3] Created workspace: ${user0Workspace.name} at ${user0Workspace.path}`,
    );

    // ========================================
    // Step 4: users[0] adds a file to the local folder
    // ========================================
    const testFileName = "README.md";
    const testFileContent = `# Test Repository

This is a test file created at ${new Date().toISOString()}.

## Features
- Version control
- Collaboration
- File syncing
`;

    await createTestFile(user0Workspace, testFileName, testFileContent);

    // Verify file was created
    const createdContent = await readTestFile(user0Workspace, testFileName);
    expect(createdContent).toBe(testFileContent);

    console.log(`[Step 4] Created file: ${testFileName}`);

    // ========================================
    // Step 5: users[0] makes an initial version/submission via daemon
    // ========================================
    await env.users[0].daemonClient.workspaces.submit.query({
      daemonId: env.users[0].daemonId,
      workspaceId: user0WorkspaceId,
      message: "Initial commit with README",
      modifications: [
        {
          delete: false,
          path: testFileName,
        },
      ],
      shelved: false,
    });

    console.log(`[Step 5] Submitted initial version`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the history shows the submission using the API client
    const history =
      await env.users[0].apiClient.changelist.getChangelists.query({
        repoId: repo.id,
        branchName: "main",
        start: {
          number: null,
          timestamp: null,
        },
        count: 100,
      });

    // Should have at least 2 changelists: initial (number 0) and our commit (number 1)
    expect(history.length).toBeGreaterThanOrEqual(2);
    const latestChangelist = history.find(
      (cl: { number: number }) => cl.number === 1,
    );
    expect(latestChangelist).toBeDefined();
    expect(latestChangelist?.message).toBe("Initial commit with README");

    console.log(`[Step 5] Verified history: ${history.length} changelists`);

    // ========================================
    // Step 6: users[0] adds users[1] to the org
    // ========================================
    const addUserResult = await env.users[0].apiClient.org.addUserToOrg.mutate({
      orgId: org.id,
      userEmail: env.users[1].email,
      role: "MEMBER",
    });

    expect(addUserResult).toBeDefined();
    expect(addUserResult.orgId).toBe(org.id);

    console.log(`[Step 6] Added user ${env.users[1].email} to org`);

    // Verify users[1] can see the org
    const user1Orgs = await env.users[1].apiClient.org.myOrgs.query();
    const foundOrg = user1Orgs.find((o) => o.id === org.id);
    expect(foundOrg).toBeDefined();
    expect(foundOrg?.name).toBe(orgName);

    console.log(`[Step 6] Verified user 1 can see org`);

    // ========================================
    // Step 7: users[1] creates a workspace for the repo
    // ========================================
    const user1Workspace = await createTestWorkspace(
      `user1-workspace-${Date.now()}`,
    );
    testWorkspaces.push(user1Workspace);

    // Ensure the local folder exists
    await fs.mkdir(user1Workspace.path, { recursive: true });

    // Create workspace in the system via daemon
    const workspace1Response =
      await env.users[1].daemonClient.workspaces.create.mutate({
        daemonId: env.users[1].daemonId,
        name: user1Workspace.name,
        repoId: repo.id,
        path: user1Workspace.path,
        defaultBranchName: "main",
      });

    expect(workspace1Response).toBeDefined();
    expect(workspace1Response.workspace).toBeDefined();
    expect(workspace1Response.workspace.id).toBeDefined();

    const user1WorkspaceId = workspace1Response.workspace.id;

    console.log(
      `[Step 7] Created workspace for user 1: ${user1Workspace.name} at ${user1Workspace.path}`,
    );

    // ========================================
    // Step 8: users[1] pulls the latest version via daemon
    // ========================================
    await env.users[1].daemonClient.workspaces.pull.query({
      daemonId: env.users[1].daemonId,
      workspaceId: user1WorkspaceId,
      changelistId: null, // Pull latest
      filePaths: null, // Pull all files
    });

    console.log(`[Step 8] Pulled latest version to user 1 workspace`);

    // ========================================
    // Step 9: Verify that the local workspaces are identical
    // ========================================
    // List files in both workspaces
    const user0Files = await listTestFiles(user0Workspace);
    const user1Files = await listTestFiles(user1Workspace);

    console.log(`[Step 9] User 0 files: ${JSON.stringify(user0Files)}`);
    console.log(`[Step 9] User 1 files: ${JSON.stringify(user1Files)}`);

    // Both should have the same files
    expect(user1Files.sort()).toEqual(user0Files.sort());

    // Compare file contents
    for (const file of user0Files) {
      const user0Content = await readTestFile(user0Workspace, file);
      const user1Content = await readTestFile(user1Workspace, file);

      expect(user1Content).toBe(user0Content);
      console.log(`[Step 9] File ${file} content matches`);
    }

    console.log(`[Step 9] VERIFIED: Workspaces are identical!`);

    // ========================================
    // Step 10: users[1] modifies the README.md
    // ========================================
    const modifiedReadmeContent = `# Test Repository

This is a test file created at ${new Date().toISOString()}.

## Features
- Version control
- Collaboration
- File syncing

## Changes by User 1
This section was added by user 1 to test modification syncing.
`;

    await createTestFile(user1Workspace, testFileName, modifiedReadmeContent);

    // Verify file was modified locally
    const modifiedContent = await readTestFile(user1Workspace, testFileName);
    expect(modifiedContent).toBe(modifiedReadmeContent);

    console.log(`[Step 10] Modified README.md in user 1 workspace`);

    // ========================================
    // Step 11: users[1] submits the modification
    // ========================================
    await env.users[1].daemonClient.workspaces.submit.query({
      daemonId: env.users[1].daemonId,
      workspaceId: user1WorkspaceId,
      message: "Updated README with user 1 changes",
      modifications: [
        {
          delete: false,
          path: testFileName,
        },
      ],
      shelved: false,
    });

    console.log(`[Step 11] Submitted README modification`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify history shows the new submission
    const historyAfterModify =
      await env.users[1].apiClient.changelist.getChangelists.query({
        repoId: repo.id,
        branchName: "main",
        start: {
          number: null,
          timestamp: null,
        },
        count: 100,
      });

    const modifyChangelist = historyAfterModify.find(
      (cl: { number: number }) => cl.number === 2,
    );
    expect(modifyChangelist).toBeDefined();
    expect(modifyChangelist?.message).toBe(
      "Updated README with user 1 changes",
    );

    console.log(
      `[Step 11] Verified history: ${historyAfterModify.length} changelists`,
    );

    // ========================================
    // Step 12: users[0] pulls the change
    // ========================================
    await env.users[0].daemonClient.workspaces.pull.query({
      daemonId: env.users[0].daemonId,
      workspaceId: user0WorkspaceId,
      changelistId: null, // Pull latest
      filePaths: null, // Pull all files
    });

    console.log(`[Step 12] Pulled changes to user 0 workspace`);

    // ========================================
    // Step 13: Verify user 0 has the modified README
    // ========================================
    const user0ReadmeContent = await readTestFile(user0Workspace, testFileName);
    expect(user0ReadmeContent).toBe(modifiedReadmeContent);

    console.log(`[Step 13] VERIFIED: User 0 received modified README!`);

    // ========================================
    // Step 14: users[1] adds a second file and removes README in the same submission
    // ========================================
    const secondFileName = "CONTRIBUTING.md";
    const secondFileContent = `# Contributing Guide

Thank you for your interest in contributing!

## How to Contribute
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

Created at ${new Date().toISOString()}
`;

    // Add the new file
    await createTestFile(user1Workspace, secondFileName, secondFileContent);

    // Remove the README.md
    await fs.unlink(`${user1Workspace.path}/${testFileName}`);

    console.log(
      `[Step 14] Added ${secondFileName} and removed ${testFileName} in user 1 workspace`,
    );

    // ========================================
    // Step 15: users[1] submits both changes together
    // ========================================
    await env.users[1].daemonClient.workspaces.submit.query({
      daemonId: env.users[1].daemonId,
      workspaceId: user1WorkspaceId,
      message: "Added CONTRIBUTING.md and removed README.md",
      modifications: [
        {
          delete: true,
          path: testFileName,
        },
        {
          delete: false,
          path: secondFileName,
        },
      ],
      shelved: false,
    });

    console.log(`[Step 15] Submitted combined add/delete changes`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify history shows the new submission
    const historyAfterCombined =
      await env.users[1].apiClient.changelist.getChangelists.query({
        repoId: repo.id,
        branchName: "main",
        start: {
          number: null,
          timestamp: null,
        },
        count: 100,
      });

    const combinedChangelist = historyAfterCombined.find(
      (cl: { number: number }) => cl.number === 3,
    );
    expect(combinedChangelist).toBeDefined();
    expect(combinedChangelist?.message).toBe(
      "Added CONTRIBUTING.md and removed README.md",
    );

    console.log(
      `[Step 15] Verified history: ${historyAfterCombined.length} changelists`,
    );

    // ========================================
    // Step 16: users[0] pulls the changes
    // ========================================
    await env.users[0].daemonClient.workspaces.pull.query({
      daemonId: env.users[0].daemonId,
      workspaceId: user0WorkspaceId,
      changelistId: null, // Pull latest
      filePaths: null, // Pull all files
    });

    console.log(`[Step 16] Pulled combined changes to user 0 workspace`);

    // ========================================
    // Step 17: Verify both workspaces are identical after add/delete
    // ========================================
    const user0FinalFiles = await listTestFiles(user0Workspace);
    const user1FinalFiles = await listTestFiles(user1Workspace);

    console.log(
      `[Step 17] User 0 final files: ${JSON.stringify(user0FinalFiles)}`,
    );
    console.log(
      `[Step 17] User 1 final files: ${JSON.stringify(user1FinalFiles)}`,
    );

    // Both should have the same files
    expect(user0FinalFiles.sort()).toEqual(user1FinalFiles.sort());

    // README.md should be gone
    expect(user0FinalFiles).not.toContain(testFileName);
    expect(user1FinalFiles).not.toContain(testFileName);

    // CONTRIBUTING.md should exist
    expect(user0FinalFiles).toContain(secondFileName);
    expect(user1FinalFiles).toContain(secondFileName);

    // Compare file contents
    for (const file of user0FinalFiles) {
      const user0FileContent = await readTestFile(user0Workspace, file);
      const user1FileContent = await readTestFile(user1Workspace, file);

      expect(user0FileContent).toBe(user1FileContent);
      console.log(`[Step 17] File ${file} content matches`);
    }

    // Verify CONTRIBUTING.md has the correct content
    const user0ContribContent = await readTestFile(
      user0Workspace,
      secondFileName,
    );
    expect(user0ContribContent).toBe(secondFileContent);

    console.log(
      `[Step 17] VERIFIED: Workspaces are identical after add/delete operations!`,
    );

    // ========================================
    // Step 18: users[0] modifies CONTRIBUTING.md and submits
    // ========================================
    const modifiedContribContent = `# Contributing Guide

Thank you for your interest in contributing!

## How to Contribute
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Code of Conduct
Please be respectful and follow our community guidelines.

Modified by User 0 at ${new Date().toISOString()}
`;

    await createTestFile(
      user0Workspace,
      secondFileName,
      modifiedContribContent,
    );

    await env.users[0].daemonClient.workspaces.submit.query({
      daemonId: env.users[0].daemonId,
      workspaceId: user0WorkspaceId,
      message: "Updated CONTRIBUTING.md with code of conduct",
      modifications: [
        {
          delete: false,
          path: secondFileName,
        },
      ],
      shelved: false,
    });

    console.log(`[Step 18] User 0 modified and submitted CONTRIBUTING.md`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ========================================
    // Step 19: Before pulling, users[1] adds a 3rd file and submits
    // ========================================
    const thirdFileName = "LICENSE.md";
    const thirdFileContent = `# License

MIT License

Copyright (c) ${new Date().getFullYear()}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

Created by User 1 at ${new Date().toISOString()}
`;

    await createTestFile(user1Workspace, thirdFileName, thirdFileContent);

    await env.users[1].daemonClient.workspaces.submit.query({
      daemonId: env.users[1].daemonId,
      workspaceId: user1WorkspaceId,
      message: "Added LICENSE.md",
      modifications: [
        {
          delete: false,
          path: thirdFileName,
        },
      ],
      shelved: false,
    });

    console.log(
      `[Step 19] User 1 added and submitted LICENSE.md (without pulling first)`,
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify history shows both submissions
    const historyAfterParallel =
      await env.users[0].apiClient.changelist.getChangelists.query({
        repoId: repo.id,
        branchName: "main",
        start: {
          number: null,
          timestamp: null,
        },
        count: 100,
      });

    console.log(
      `[Step 19] History now has ${historyAfterParallel.length} changelists`,
    );

    // ========================================
    // Step 20: Both users pull to sync
    // ========================================
    await env.users[0].daemonClient.workspaces.pull.query({
      daemonId: env.users[0].daemonId,
      workspaceId: user0WorkspaceId,
      changelistId: null,
      filePaths: null,
    });

    console.log(`[Step 20] User 0 pulled latest changes`);

    await env.users[1].daemonClient.workspaces.pull.query({
      daemonId: env.users[1].daemonId,
      workspaceId: user1WorkspaceId,
      changelistId: null,
      filePaths: null,
    });

    console.log(`[Step 20] User 1 pulled latest changes`);

    // ========================================
    // Step 21: Verify both workspaces have both files
    // ========================================
    const user0SyncedFiles = await listTestFiles(user0Workspace);
    const user1SyncedFiles = await listTestFiles(user1Workspace);

    console.log(
      `[Step 21] User 0 synced files: ${JSON.stringify(user0SyncedFiles)}`,
    );
    console.log(
      `[Step 21] User 1 synced files: ${JSON.stringify(user1SyncedFiles)}`,
    );

    // Both should have the same files
    expect(user0SyncedFiles.sort()).toEqual(user1SyncedFiles.sort());

    // Both CONTRIBUTING.md and LICENSE.md should exist
    expect(user0SyncedFiles).toContain(secondFileName);
    expect(user0SyncedFiles).toContain(thirdFileName);
    expect(user1SyncedFiles).toContain(secondFileName);
    expect(user1SyncedFiles).toContain(thirdFileName);

    // Verify CONTRIBUTING.md has user 0's modifications
    const user0SyncedContrib = await readTestFile(
      user0Workspace,
      secondFileName,
    );
    const user1SyncedContrib = await readTestFile(
      user1Workspace,
      secondFileName,
    );
    expect(user0SyncedContrib).toBe(modifiedContribContent);
    expect(user1SyncedContrib).toBe(modifiedContribContent);

    console.log(`[Step 21] CONTRIBUTING.md content matches (user 0's changes)`);

    // Verify LICENSE.md has user 1's content
    const user0SyncedLicense = await readTestFile(
      user0Workspace,
      thirdFileName,
    );
    const user1SyncedLicense = await readTestFile(
      user1Workspace,
      thirdFileName,
    );
    expect(user0SyncedLicense).toBe(thirdFileContent);
    expect(user1SyncedLicense).toBe(thirdFileContent);

    console.log(`[Step 21] LICENSE.md content matches (user 1's changes)`);

    // Compare all file contents
    for (const file of user0SyncedFiles) {
      const user0SyncedContent = await readTestFile(user0Workspace, file);
      const user1SyncedContent = await readTestFile(user1Workspace, file);

      expect(user0SyncedContent).toBe(user1SyncedContent);
      console.log(`[Step 21] File ${file} content matches`);
    }

    console.log(
      `[Step 21] VERIFIED: Both workspaces synced correctly after parallel submissions!`,
    );
  }, 240000); // 4 minute timeout for the extended test
});
