export const schema = gql`
  type Org {
    id: String!
    deletedAt: DateTime
    deletedBy: String
    name: String!
    defaultRepoAccess: RepoAccess
    defaultCanCreateRepos: Boolean
    users: [OrgUser!]
    repos: [Repo!]
  }

  input OrgQueryInput {
    id: String!
    idIsName: Boolean!
    includeUsers: Boolean
    includeRepos: Boolean
  }

  type Query {
    myOrgs: [Org!]! @requireAuth
    org(input: OrgQueryInput!): Org @requireAuth
  }

  input CreateOrgInput {
    name: String!
  }

  input UpdateOrgInput {
    name: String
    defaultRepoAccess: RepoAccess
    defaultCanCreateRepos: Boolean
  }

  type Mutation {
    createOrg(input: CreateOrgInput!): Org! @requireAuth
    updateOrg(id: String!, input: UpdateOrgInput!): Org! @requireAuth
    deleteOrg(id: String!): Org! @requireAuth
    restoreOrg(id: String!): Org! @requireAuth
  }
`;
