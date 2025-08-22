import { getTestPrismaClient } from '../setup/database';

export interface TestUser {
  id: string;
  name: string;
  username: string;
  email: string;
}

export interface TestOrg {
  id: string;
  name: string;
}

export interface TestRepo {
  id: string;
  name: string;
  orgId: string;
}

export interface TestChangelist {
  id: string;
  number: number;
  message: string;
  repoId: string;
}

export class TestDataHelper {
  private prisma = getTestPrismaClient();

  async createTestUser(overrides: Partial<TestUser> = {}): Promise<TestUser> {
    const defaultUser = {
      name: 'Test User',
      username: `testuser_${Date.now()}`,
      email: `test_${Date.now()}@example.com`,
    };

    const userData = { ...defaultUser, ...overrides };
    
    const user = await this.prisma.user.create({
      data: userData,
    });

    return {
      id: user.id,
      name: user.name || userData.name,
      username: user.username,
      email: user.email,
    };
  }

  async createTestOrg(userId: string, overrides: Partial<TestOrg> = {}): Promise<TestOrg> {
    const defaultOrg = {
      name: `testorg_${Date.now()}`,
    };

    const orgData = { ...defaultOrg, ...overrides };
    
    const org = await this.prisma.org.create({
      data: orgData,
    });

    // Add user as admin
    await this.prisma.orgUser.create({
      data: {
        orgId: org.id,
        userId: userId,
        role: 'ADMIN',
      },
    });

    return {
      id: org.id,
      name: org.name,
    };
  }

  async createTestRepo(orgId: string, userId: string, overrides: Partial<TestRepo> = {}): Promise<TestRepo> {
    const defaultRepo = {
      name: `testrepo_${Date.now()}`,
      public: false,
    };

    const repoData = { ...defaultRepo, ...overrides };
    
    const repo = await this.prisma.repo.create({
      data: {
        name: repoData.name,
        public: repoData.public,
        orgId: orgId,
      },
    });

    // Create main branch
    await this.prisma.branch.create({
      data: {
        name: 'main',
        repoId: repo.id,
        headNumber: 0,
        isDefault: true,
      },
    });

    // Create initial changelist
    await this.prisma.changelist.create({
      data: {
        number: 0,
        message: 'Repo Creation',
        versionIndex: '',
        stateTree: {},
        repoId: repo.id,
        userId: userId,
      },
    });

    return {
      id: repo.id,
      name: repo.name,
      orgId: repo.orgId,
    };
  }

  async createTestChangelist(
    repoId: string, 
    userId: string, 
    overrides: Partial<TestChangelist> = {}
  ): Promise<TestChangelist> {
    // Get the next changelist number
    const lastChangelist = await this.prisma.changelist.findFirst({
      where: { repoId },
      orderBy: { number: 'desc' },
    });

    const nextNumber = (lastChangelist?.number ?? -1) + 1;

    const defaultChangelist = {
      message: `Test commit ${Date.now()}`,
      versionIndex: `version_${Date.now()}`,
      stateTree: { files: [] },
    };

    const changelistData = { ...defaultChangelist, ...overrides };
    
    const changelist = await this.prisma.changelist.create({
      data: {
        number: nextNumber,
        message: changelistData.message,
        versionIndex: changelistData.versionIndex,
        stateTree: changelistData.stateTree,
        repoId: repoId,
        userId: userId,
      },
    });

    // Update branch head
    await this.prisma.branch.updateMany({
      where: {
        repoId: repoId,
        isDefault: true,
      },
      data: {
        headNumber: nextNumber,
      },
    });

    return {
      id: changelist.id,
      number: changelist.number,
      message: changelist.message,
      repoId: changelist.repoId,
    };
  }

  async cleanupTestData(): Promise<void> {
    // Clean up in reverse dependency order
    await this.prisma.fileChange.deleteMany();
    await this.prisma.changelist.deleteMany();
    await this.prisma.branch.deleteMany();
    await this.prisma.repoRole.deleteMany();
    await this.prisma.repo.deleteMany();
    await this.prisma.orgUser.deleteMany();
    await this.prisma.org.deleteMany();
    await this.prisma.user.deleteMany();
  }
}