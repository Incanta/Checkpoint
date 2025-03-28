export const schema = gql`
  type OrgUser {
    id: String!
    role: OrgRole!
    canCreateRepos: Boolean!
    org: Org!
    orgId: String!
    user: User!
    userId: String!
  }
`;
