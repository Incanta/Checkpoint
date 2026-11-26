using Xunit;

namespace Checkpoint.Integration.Tests;

/// <summary>
/// Skip handling shared by the live tests. Locally a missing environment variable skips the test.
/// CI sets CHECKPOINT_TEST_REQUIRE_LIVE=1, which turns those skips into failures, so a broken job
/// setup shows red instead of passing with nothing tested.
/// </summary>
static class LiveTest
{
	static bool RequireLive => Environment.GetEnvironmentVariable("CHECKPOINT_TEST_REQUIRE_LIVE") == "1";

	/// <summary>
	/// Skips (or, with CHECKPOINT_TEST_REQUIRE_LIVE=1, fails) the current test when the condition is true.
	/// </summary>
	public static void SkipIf(bool condition, string reason)
	{
		if (condition && RequireLive)
		{
			Assert.Fail($"{reason} (CHECKPOINT_TEST_REQUIRE_LIVE=1 forbids skipping)");
		}
		Skip.If(condition, reason);
	}

	public static string? Env(string name)
	{
		string? value = Environment.GetEnvironmentVariable(name);
		return String.IsNullOrEmpty(value) ? null : value;
	}
}
