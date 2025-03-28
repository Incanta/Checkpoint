export const schema = gql`
  type FileChange {
    id: String!
    file: File!
    fileId: String!
    changeList: ChangeList!
    repoId: String!
    changeListNumber: Int!
    type: FileChangeType!
    oldPath: String
  }
`;
