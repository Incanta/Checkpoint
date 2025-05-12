export const schema = gql`
  type FileChange {
    id: String!
    file: File!
    fileId: String!
    changelist: Changelist!
    repoId: String!
    changelistNumber: Int!
    type: FileChangeType!
    oldPath: String
  }
`;
