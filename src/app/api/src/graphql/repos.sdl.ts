export const schema = gql`
  type Repo {
    id: String!
    deletedAt: DateTime
    deletedBy: String
    name: String!
    public: Boolean!
    org: Org
    orgId: String!
    additionalRoles: [RepoRole]!
    files: [File]!
    changelists: [Changelist]!
    branches: [Branch]!
  }

  type Query {
    repos(orgId: String!): [Repo!]! @requireAuth
    repo(id: String!): Repo @requireAuth
  }

  input CreateRepoInput {
    name: String!
    orgId: String!
  }

  input UpdateRepoInput {
    name: String
    public: Boolean
  }

  type Mutation {
    createRepo(input: CreateRepoInput!): Repo! @requireAuth
    updateRepo(id: String!, input: UpdateRepoInput!): Repo! @requireAuth
    deleteRepo(id: String!): Repo! @requireAuth
    restoreRepo(id: String!): Repo! @requireAuth
  }
`;
