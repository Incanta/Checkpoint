export const schema = gql`
  type StorageToken {
    token: String!
    expiration: Int!
    backendUrl: String!
  }

  type Query {
    storageToken(orgId: String!, repoId: String!, write: Boolean!): StorageToken! @requireAuth
  }
`;
