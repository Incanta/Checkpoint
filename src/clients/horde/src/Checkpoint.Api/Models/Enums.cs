namespace Checkpoint.Api.Models;

/// <summary>
/// Type of change a changelist applies to a file. Matches the FileChangeType Prisma enum.
/// </summary>
public enum FileChangeKind
{
	ADD,
	DELETE,
	MODIFY,
}

/// <summary>
/// Branch classification. Matches the BranchType Prisma enum.
/// </summary>
public enum BranchKind
{
	MAINLINE,
	RELEASE,
	FEATURE,
}
