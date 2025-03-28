export const schema = gql`
  type ChangeList {
    id: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    number: Int!
    message: String!
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
    changeList(id: String!): ChangeList @requireAuth
  }

  input CreateChangeListInput {
    message: String!
    repoId: String!
    userId: String!
    parentNumber: Int
  }

  input UpdateChangeListInput {
    message: String
  }

  type Mutation {
    createChangeList(input: CreateChangeListInput!): ChangeList! @requireAuth
    updateChangeList(id: String!, input: UpdateChangeListInput!): ChangeList! @requireAuth
  }
`;
