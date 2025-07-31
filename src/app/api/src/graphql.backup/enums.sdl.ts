export const schema = gql`
  enum RepoAccess {
    NONE
    READ
    WRITE
    ADMIN
  }

  enum FileChangeType {
    ADD
    DELETE
    MODIFY
  }

  enum OrgRole {
    MEMBER
    BILLING
    ADMIN
  }

  enum RepoAccess {
    NONE
    READ
    WRITE
    ADMIN
  }
`;
