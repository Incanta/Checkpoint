export const schema = gql`
  type File {
    id: String!
    path: String!
    repo: Repo!
    repoId: String!
    changes: [FileChange]!
    locks: [FileLock]!
  }

  type Query {
    files(ids: [String!]!): [File!]! @requireAuth
  }
`;
