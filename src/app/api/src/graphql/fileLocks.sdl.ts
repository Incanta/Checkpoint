export const schema = gql`
  type FileLock {
    id: String!
    createdAt: DateTime!
    unlockedAt: DateTime
    file: File!
    fileId: String!
    user: User!
    userId: String!
  }

  type Query {
    fileLocks(repoId: String!): [FileLock!]! @requireAuth
  }

  type Mutation {
    lockFile(fileId: String!): String @requireAuth
    unlockFile(fileId: String!): String @requireAuth
  }
`;
