export const schema = gql`
  type User {
    id: String!
    name: String!
    username: String!
    email: String!
    checkpointAdmin: Boolean!
    orgs: [OrgUser]!
    specificRepoRoles: [RepoRole]!
    fileCheckouts: [FileCheckout]!
    changelists: [Changelist]!
  }

  type Query {
    me: User! @requireAuth
    users: [User!]! @requireAuth
    user(id: String!): User @requireAuth
  }

  input CreateUserInput {
    name: String!
    username: String!
    email: String!
  }

  input UpdateUserInput {
    name: String
    username: String
    email: String
  }

  type Mutation {
    createUser(input: CreateUserInput!): User! @requireAuth
    updateUser(id: String!, input: UpdateUserInput!): User! @requireAuth
    deleteUser(id: String!): String @requireAuth
  }
`;
