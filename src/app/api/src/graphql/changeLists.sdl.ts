export const schema = gql`
  type Changelist {
    id: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    number: Int!
    message: String!
    versionIndex: String!
    stateTree: JSON!
    repo: Repo!
    repoId: String!
    user: User
    userId: String
    heads: [Branch]!
    parent: Changelist
    children: [Changelist]!
    parentNumber: Int
    fileChanges: [FileChange]!
  }

  type Query {
    changelist(id: String!): Changelist! @requireAuth
    changelists(repoId: String!, numbers: [Int!]!): [Changelist!]! @requireAuth
  }

  input ModificationInput {
    delete: Boolean!
    path: String!
    oldPath: String
  }

  input CreateChangelistInput {
    message: String!
    repoId: String!
    branchName: String!
    versionIndex: String!
    modifications: [ModificationInput!]!
    keepCheckedOut: Boolean!
    workspaceId: String!
  }

  input UpdateChangelistInput {
    message: String
  }

  type Mutation {
    createChangelist(input: CreateChangelistInput!): Changelist! @requireAuth
    updateChangelist(id: String!, input: UpdateChangelistInput!): Changelist! @requireAuth
  }
`;
