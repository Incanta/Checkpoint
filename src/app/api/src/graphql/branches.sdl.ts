export const schema = gql`
  type Branch {
    id: String!
    repo: Repo!
    repoId: String!
    name: String!
    headNumber: Int!
    isDefault: Boolean!
  }

  # input CreateBranchInput {
  #   repoId: String!
  #   name: String!
  #   headNumber: Int!
  # }

  # input UpdateBranchInput {
  #   name: String
  #   headNumber: Int
  # }

  # type Mutation {
  #   createBranch(input: CreateBranchInput!): Branch! @requireAuth
  #   updateBranch(repoId: String!, name: String!, input: UpdateBranchInput!): Branch! @requireAuth
  #   changeDefaultBranch(repoId: String!, name: String!): Branch! @requireAuth
  #   deleteBranch(repoId: String!, name: String!): Branch! @requireAuth
  # }
`;
