export const schema = gql`
  type FileCheckout {
    id: String!
    createdAt: DateTime!
    removedAt: DateTime
    locked: Boolean!
    file: File!
    fileId: String!
    user: User!
    userId: String!
  }

  input FileCheckoutInput {
    fileId: String!
    locked: Boolean!
  }

  # type Query {
  #   fileCheckout(repoId: String!): [FileCheckout!]! @requireAuth
  # }

  type Mutation {
    checkout(workspaceId: String!, files: [FileCheckoutInput!]!): Boolean! @requireAuth
  }
`;
