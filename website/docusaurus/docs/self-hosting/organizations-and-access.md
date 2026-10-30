---
sidebar_position: 7
---

# Organizations and access

Access in Checkpoint works like a small Perforce or GitHub setup: an instance admin controls who gets an account, organizations hold repositories, and roles decide who can read, write, and administer each repository.

## Instance admin

The **instance admin** is the first account registered on the instance. It is a flag on the account (not an org role) and gives:

- the **Admin** item in the user menu, which opens the Admin area,
- the right to create invitations when `auth.invite-only` is `"admin"` (the default),
- the right to grant membership in any organization and access to any repository when inviting someone, and
- the list of every invitation on the instance, with the ability to resend or revoke any of them.

Being instance admin does not by itself give access to an organization's repositories. To work in an org, the instance admin needs to be a member like anyone else (creating the org makes them its admin).

:::note
There is no screen for making another account an instance admin yet. Keep the first account's credentials safe, and give it a passkey or authenticator app.
:::

### The Admin area

Open the user menu, then **Admin**. On a self-hosted instance it has two tabs:

- **Dashboard**: counts of users, organizations, and repositories.
- **Updates**: check for, download, install, and roll back Checkpoint versions. See [Updates](./updates.md).

## Licensing

Self-hosted instances are fully featured: every feature is available, no license key is needed, and nothing is tracked per user. The billing and subscription screens only appear on Incanta's hosted service, so you can ignore them.

## Organizations

An organization owns repositories and has members. Any signed-in user can create one from the **+** menu in the top bar, **New organization**, and becomes its admin.

### Org roles

| Role | Can do |
| --- | --- |
| **Admin** | Everything in the org: edit org settings, add members, require MFA, delete the org, and administer every repository in it. |
| **Member** | Access repositories according to the org's default repository access and any per-repository grants (below). |

### Org settings

Org admins open the org, then **Settings**:

- **Organization name**.
- **Default repository access**: None, Read, Write, or Admin. It applies to every member for every repository in the org. New orgs start at **Write**.
- **Members can create repositories by default**: on for new orgs. When off, only org admins can create repositories.
- **Require two-factor authentication**: see [Requiring MFA for an organization](./authentication.md#requiring-mfa-for-an-organization).
- Binary file extensions, which control which files are never auto-merged.
- **Delete this organization**, under Danger zone.

The **Members** tab lists members with their role and MFA status, and has the **Add a member** form.

## Repositories

Create a repository from the **+** menu, **New repository**, and pick the org. Org admins can always create repositories; members can when **Members can create repositories by default** is on. A member who creates a repository becomes its admin.

### Repository access

A person's access to a repository is the highest of:

| Source | Access |
| --- | --- |
| Org **Admin** role | Admin on every repository in the org |
| Org membership | The org's **Default repository access** |
| A per-repository grant | Read, Write, or Admin on that repository |

What each level allows:

- **Read**: browse, clone, and pull.
- **Write**: also submit changelists, create branches, and claim files.
- **Admin**: also change repository settings (name, merge request reviews, merge permissions, issue tracker), force-release other people's claims, and delete the repository.

Per-repository grants are given when you invite someone (see below). Write and Admin grants only take effect for people who are also members of the repository's org, so when you invite someone to write to a repository, also add them to its org.

Repository admins can also limit who may merge into mainline and release branches under the repository's settings, **Merge permissions**. With an empty list, everyone with write access can merge.

## Inviting people

With the default `auth.invite-only: "admin"`, new people need an invitation from the instance admin. With `"member"`, any signed-in user can invite. See [Who may register](./authentication.md#who-may-register-invite-only).

1. Open the **+** menu, **Invite user**.
2. Enter the person's email. A display name and username are optional; they prefill the person's account.
3. Under **Initial access**, optionally pick organizations (with a role) and repositories (with Read, Write, or Admin). You can only grant orgs you administer and repositories you administer, unless you are the instance admin.
4. Click **Send invite**.

The page then shows an **Invite created** card with a signup link of the form:

```text
<server.external-url>/signin?invite=<token>
```

- **With email configured**, the invitation is also emailed to the person. See [Configuration](./configuration.md) for SMTP settings (`email.yaml`).
- **Without email**, nothing is sent. Copy the link with **Copy** and send it to the person yourself, through chat or another channel you trust.

Anyone who has the link can use it to register as that email address (the signup form is locked to the invited email), so share it only with the invitee. When they register, through the link or through an identity provider with the same email, they get the access listed on the invitation.

Invitations created from this page do not expire. The **Invitations** list on the same page shows each one's status; use **Revoke** to cancel a pending invitation or **Resend** to email it again. Invitations can't be created for an email that already has an account, or that already has a pending invitation.

### Adding existing users to an org

For someone who already has an account, an org admin can use the org's **Settings**, **Members**, **Add a member**: enter their email, pick **Member** or **Admin**, and click **Add**.

## Removing people and changing roles

The web app does not yet have a way to remove someone from an organization, change a member's role, or edit per-repository grants after an invitation is accepted. Plan roles before inviting people.

Things you can do today:

- Revoke a pending invitation before it is used.
- Ask the person to revoke their own devices and tokens under **Devices & Tokens**.
- Lower the org's **Default repository access** to limit what every member gets by default.

## Related

- [Authentication](./authentication.md): sign-up policy, sign-in methods, MFA, and API tokens.
- [Configuration](./configuration.md): email and other settings.
- [Troubleshooting](../troubleshooting.md)
