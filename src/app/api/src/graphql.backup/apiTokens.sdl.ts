export const schema = gql`
  type ApiToken {
    id: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    expiresAt: DateTime

    name: String!
    token: String # only returned if deviceCode is not null
    deviceCode: String

    userId: String!
  }

  type Query {
    apiToken(deviceCode: String!): ApiToken @skipAuth
    myApiTokens: [ApiToken!]! @requireAuth
  }

  type Mutation {
    createApiToken(name: String!, expiresAt: DateTime, deviceCode: String): ApiToken! @requireAuth
    deleteApiToken(id: String!): Boolean! @requireAuth
    renameApiToken(id: String!, name: String!): ApiToken! @requireAuth
  }
`;
