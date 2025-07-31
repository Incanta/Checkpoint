export const schema = gql`
  type RepoRole {
    id: String!
    access: RepoAccess!
    repo: Repo!
    repoId: String!
    user: User!
    userId: String!
  }
`;
