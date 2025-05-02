export const schema = gql`
  type ChangeList {
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
    parent: ChangeList
    children: [ChangeList]!
    parentNumber: Int
    fileChanges: [FileChange]!
  }

  type Query {
    changeList(id: String!): ChangeList! @requireAuth
    changeLists(repoId: String!, numbers: [Int!]!): [ChangeList!]! @requireAuth
  }

  input ModificationInput {
    delete: Boolean!
    path: String!
    oldPath: String
  }

  input CreateChangeListInput {
    message: String!
    repoId: String!
    branchName: String!
    versionIndex: String!
    modifications: [ModificationInput!]!
  }

  input UpdateChangeListInput {
    message: String
  }

  type Mutation {
    createChangeList(input: CreateChangeListInput!): ChangeList! @requireAuth
    updateChangeList(id: String!, input: UpdateChangeListInput!): ChangeList! @requireAuth
  }
`;
