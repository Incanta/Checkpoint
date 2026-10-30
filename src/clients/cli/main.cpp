/**
 * Checkpoint CLI: A command-line client for the Checkpoint daemon.
 *
 * Usage:
 *   checkpoint <command> [options]
 *   chk <command> [options]
 *
 * Commands:
 *   status                        Show pending changes
 *   add <file...>                 Stage files for submission
 *   move (-b <branch>|-c <id>) <file...>  Restage into a branch or changelist
 *   changelist (cl) <action>      Manage pending changelists (new, list,
 *                                 edit, delete)
 *   restore [--staged] <file...>  Unstage or revert files
 *   chmod (+x|-x) <file...>       Executable or not in the next submit
 *   submit [-m <msg>] [-c <id>]   Submit staged files
 *   pull                          Sync changes from remote
 *   log                           Show version history
 *   branch                        List branches
 *   switch <branch>               Switch to a different branch
 *   merge <branch>                Merge a branch into the current branch
 *   checkout <file>               Check out a controlled file
 *   revert <file...>              Revert files to head version
 *   revert -a [file...]           Revert files identical to head version
 *   diff <file>                   Show diff for a file
 *   init [orgName/repoName]       Initialize a workspace in the current directory
 *   unlink                        Unlink a workspace from the daemon
 *   accounts                      List authenticated accounts
 *   login [--endpoint URL]        Authenticate with a Checkpoint server
 *   logout                        Remove authentication for a Checkpoint server
 *   artifact upload <cl> -t <type> [files]  Upload artifacts for a changelist
 *   mcp [status|enable|disable]   Manage the daemon's MCP server
 *   bug-report                    Collect a redacted log bundle for a bug report
 *   redact <file> [-o out]        Write a redacted copy of a log file
 */

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include "argparse.hpp"
#include "commands.hpp"

// Pending changelist ids start at 1; the commands take 0 to mean "none".
static bool checkChangelistArg(const std::optional<int>& id) {
  if (id.has_value() && *id <= 0) {
    std::cerr << "error: invalid changelist id " << *id << "." << std::endl;
    return false;
  }
  return true;
}

int main(int argc, char** argv) {
  // Preprocess argv: expand "-N" shorthand to "--limit N" for the log command.
  // e.g. `chk log -5` becomes `chk log --limit 5`
  // Two-pass: collect strings first, then take pointers (avoids dangling from realloc).
  // Also expands the `cl` alias to `changelist` when it is the command (the
  // first non-option argument); argparse has no subcommand aliases.
  std::vector<std::string> argStorage;
  bool seenLog = false;
  bool seenCommand = false;
  for (int i = 0; i < argc; ++i) {
    std::string arg = argv[i];
    if (i > 0 && !seenCommand && !arg.empty() && arg[0] != '-') {
      seenCommand = true;
      if (arg == "cl") arg = "changelist";
    }
    if (i > 0 && arg == "log") seenLog = true;
    if (seenLog && arg.size() >= 2 && arg[0] == '-' && arg[1] != '-' &&
        std::all_of(arg.begin() + 1, arg.end(), ::isdigit)) {
      argStorage.push_back("--limit");
      argStorage.push_back(arg.substr(1));
    } else {
      argStorage.push_back(arg);
    }
  }
  std::vector<char*> newArgv;
  newArgv.reserve(argStorage.size());
  for (auto& s : argStorage) newArgv.push_back(s.data());
  argc = static_cast<int>(newArgv.size());
  argv = newArgv.data();

  // Determine if running as "chk" alias
  std::string exeName = std::filesystem::path(argv[0]).stem().string();
  std::string programName = (exeName == "chk") ? "chk" : "checkpoint";

  // ─── Top-level parser ──────────────────────────────────────────

  argparse::ArgumentParser program(programName, checkpoint::CLIENT_VERSION);
  program.add_description("Checkpoint version control CLI");

  // Global flag: never use or start a resident daemon. When set (or when
  // CHECKPOINT_DAEMONLESS is set in the environment), workspace commands spawn
  // a short-lived, workspace-scoped ephemeral daemon instead.
  program.add_argument("--no-daemon")
      .help("Force daemonless mode (spawn an ephemeral daemon per command)")
      .default_value(false)
      .implicit_value(true);

  // ─── Sub-commands ──────────────────────────────────────────────

  // status
  argparse::ArgumentParser statusCmd("status");
  statusCmd.add_description("Show pending changes in the current workspace");

  // add
  argparse::ArgumentParser addCmd("add");
  addCmd.add_description("Stage files for submission");
  addCmd.add_argument("--patch", "-p")
      .help("Stage individual hunks of one text file, interactively")
      .default_value(false)
      .implicit_value(true);
  addCmd.add_argument("--branch", "-b")
      .help("Stage into this feature branch's changelist (default: domain root)")
      .default_value(std::string(""));
  addCmd.add_argument("--changelist", "-c")
      .help("Stage into this numbered pending changelist (submits to its branch)")
      .scan<'i', int>();
  addCmd.add_argument("files")
      .help("File(s) to stage")
      .nargs(argparse::nargs_pattern::at_least_one);

  // restore
  argparse::ArgumentParser restoreCmd("restore");
  restoreCmd.add_description("Unstage staged files, or revert files to head");
  restoreCmd.add_argument("--staged", "-s")
      .help("Unstage files (remove from staged)")
      .default_value(false)
      .implicit_value(true);
  restoreCmd.add_argument("files")
      .help("File(s) to restore")
      .nargs(argparse::nargs_pattern::at_least_one);

  // chmod
  argparse::ArgumentParser chmodCmd("chmod");
  chmodCmd.add_description(
      "Make files executable (+x) or not (-x) in their next submit; works on "
      "Windows too");
  chmodCmd.set_prefix_chars("-+");
  chmodCmd.add_argument("+x")
      .help("Make the files executable")
      .default_value(false)
      .implicit_value(true);
  chmodCmd.add_argument("-x")
      .help("Make the files not executable")
      .default_value(false)
      .implicit_value(true);
  chmodCmd.add_argument("files")
      .help("File(s) to change")
      .nargs(argparse::nargs_pattern::at_least_one);

  // submit
  argparse::ArgumentParser submitCmd("submit");
  submitCmd.add_description("Submit staged files as a new version");
  submitCmd.add_argument("--message", "-m")
      .help("Submission message (default: the changelist's description)")
      .default_value(std::string(""));
  submitCmd.add_argument("--branch", "-b")
      .help("Submit this branch's default changelist (default: domain root)")
      .default_value(std::string(""));
  submitCmd.add_argument("--changelist", "-c")
      .help("Submit this numbered pending changelist instead")
      .scan<'i', int>();
  submitCmd.add_argument("--no-progress")
      .help("Disable the progress bar (also skips progress callbacks entirely)")
      .default_value(false)
      .implicit_value(true);

  // pull
  argparse::ArgumentParser pullCmd("pull");
  pullCmd.add_description("Sync changes from remote");
  pullCmd.add_argument("--changelist", "-c")
      .help("Sync to a specific changelist number instead of the branch head")
      .scan<'i', int>();
  pullCmd.add_argument("--no-progress")
      .help("Disable the progress bar (also skips progress callbacks entirely)")
      .default_value(false)
      .implicit_value(true);
  pullCmd.add_argument("--confirm-links")
      .help("Team Sync linked repos to move even though they have local "
            "changes, are ahead of the pin, or another workspace moved them")
      .nargs(argparse::nargs_pattern::at_least_one);
  pullCmd.add_argument("--skip-links")
      .help("Sync only this workspace and leave its Team Sync linked repos "
            "where they are")
      .default_value(false)
      .implicit_value(true);

  // clean
  argparse::ArgumentParser cleanCmd("clean");
  cleanCmd.add_description(
      "Restore the workspace to a pristine copy of its current changelist "
      "(reverts modified files, removes untracked files, releases checkouts)");
  cleanCmd.add_argument("--yes", "-y")
      .help("Skip the confirmation prompt (for CI/automation)")
      .default_value(false)
      .implicit_value(true);
  cleanCmd.add_argument("--no-progress")
      .help("Disable the progress bar (also skips progress callbacks entirely)")
      .default_value(false)
      .implicit_value(true);

  // log
  argparse::ArgumentParser logCmd("log");
  logCmd.add_description("Show version history");
  logCmd.add_argument("-l", "--limit")
      .help("Limit the number of changelists shown")
      .scan<'i', int>();

  // branch
  argparse::ArgumentParser branchCmd("branch");
  branchCmd.add_description("List branches");

  // switch
  argparse::ArgumentParser switchCmd("switch");
  switchCmd.add_description("Switch to a different branch");
  switchCmd.add_argument("branch")
      .help("Name of the branch to switch to");

  // merge
  argparse::ArgumentParser mergeCmd("merge");
  mergeCmd.add_description("Merge a branch into the current branch");
  mergeCmd.add_argument("branch")
      .help("Branch to merge from");

  // checkout
  argparse::ArgumentParser checkoutCmd("checkout");
  checkoutCmd.add_description("Check out a controlled file for editing");
  checkoutCmd.add_argument("file")
      .help("File to check out");
  checkoutCmd.add_argument("--exclusive", "-x")
      .help("Take an exclusive claim even on a mergeable file (blocks others)")
      .default_value(false)
      .implicit_value(true);

  // revert
  argparse::ArgumentParser revertCmd("revert");
  revertCmd.add_description("Revert files to their head version");
  revertCmd.add_argument("-a", "--unchanged")
      .help("Only revert files identical to their head version (all pending "
            "changes when no files are given)")
      .default_value(false)
      .implicit_value(true);
  revertCmd.add_argument("files")
      .help("File(s) to revert")
      .nargs(argparse::nargs_pattern::any);

  // diff
  argparse::ArgumentParser diffCmd("diff");
  diffCmd.add_description("Show diff for a file");
  diffCmd.add_argument("file")
      .help("File to diff");

  // init
  argparse::ArgumentParser initCmd("init");
  initCmd.add_description("Initialize a workspace in the current directory");
  initCmd.add_argument("repo")
      .help("Repository in orgName/repoName format (interactive if omitted)")
      .default_value(std::string(""))
      .nargs(argparse::nargs_pattern::optional);
  initCmd.add_argument("--branch", "-b")
      .help("Branch to base the workspace on (default: main)")
      .default_value(std::string("main"));
  initCmd.add_argument("--account")
      .help("Account email or username to use when multiple accounts are "
            "logged in (avoids the interactive picker; useful for CI)")
      .default_value(std::string(""));

  // unlink
  argparse::ArgumentParser unlinkCmd("unlink");
  unlinkCmd.add_description("Unlink a workspace from the daemon");

  // accounts
  argparse::ArgumentParser accountsCmd("accounts");
  accountsCmd.add_description("List authenticated accounts");

  // login
  argparse::ArgumentParser loginCmd("login");
  loginCmd.add_description("Authenticate with a Checkpoint server");
  loginCmd.add_argument("--endpoint", "-e")
      .help("Server URL (e.g. https://app.checkpointvcs.com or http://localhost:13000)")
      .default_value(std::string("http://localhost:13000"));
  loginCmd.add_argument("--id")
      .help("Daemon ID for this credential (default: auto-generated)")
      .default_value(std::string(""));
  loginCmd.add_argument("--token", "-t")
      .help("API token for non-interactive login (headless/CI). "
            "Mint one in the web UI under Settings > Devices & Tokens.")
      .default_value(std::string(""));

  // logout
  argparse::ArgumentParser logoutCmd("logout");
  logoutCmd.add_description("Remove authentication for a Checkpoint server");

  // artifact (subcommand)
  argparse::ArgumentParser artifactCmd("artifact");
  artifactCmd.add_description("Manage artifacts");
  artifactCmd.add_argument("action")
      .help("Action: upload")
      .default_value(std::string(""));
  artifactCmd.add_argument("cl_number")
      .help("Changelist number to attach artifacts to")
      .default_value(std::string(""))
      .nargs(argparse::nargs_pattern::optional);
  artifactCmd.add_argument("files")
      .help("Files or folders to upload; leave out to collect the files "
            "teamsync.yaml's include and exclude patterns for --type select")
      .nargs(argparse::nargs_pattern::any)
      .default_value(std::vector<std::string>{});
  artifactCmd.add_argument("--type", "-t")
      .help("Artifact type (the set workspaces apply), as in teamsync.yaml. "
            "Required.")
      .default_value(std::string(""));
  artifactCmd.add_argument("--replace")
      .help("Replace the type's set at the changelist instead of adding to "
            "it (the default when no files are named)")
      .default_value(false)
      .implicit_value(true);
  artifactCmd.add_argument("--message", "-m")
      .help("Upload message")
      .default_value(std::string(""));

  // config (subcommand)
  argparse::ArgumentParser configCmd("config");
  configCmd.add_description("Manage workspace configuration");
  configCmd.add_argument("key")
      .help("Config key");
  configCmd.add_argument("value")
      .help("Config value");

  // mcp (subcommand)
  argparse::ArgumentParser mcpCmd("mcp");
  mcpCmd.add_description(
      "Manage the daemon's MCP server (exposes the daemon API to AI tools)");
  mcpCmd.add_argument("action")
      .help("Action: status, enable, disable")
      .default_value(std::string("status"))
      .nargs(argparse::nargs_pattern::optional);

  // update (subcommand): wraps the daemon's GitHub-Releases updater
  argparse::ArgumentParser updateCmd("update");
  updateCmd.add_description("Check for and apply Checkpoint updates");
  updateCmd.add_argument("action")
      .help("Action: check, install")
      .default_value(std::string("check"))
      .nargs(argparse::nargs_pattern::optional);
  updateCmd.add_argument("--yes", "-y")
      .help("Skip confirmation prompt for install")
      .default_value(false)
      .implicit_value(true);

  // bug-report
  argparse::ArgumentParser bugReportCmd("bug-report");
  bugReportCmd.add_description(
      "Collect the daemon's logs, versions, and workspace summaries into a "
      "redacted zip to attach to a bug report");

  // redact
  argparse::ArgumentParser redactCmd("redact");
  redactCmd.add_description(
      "Write a redacted copy of a log file (for example `docker compose logs` "
      "output from a self-hosted server) using the bug-report redaction rules");
  redactCmd.add_argument("file")
      .help("File to redact (left unchanged)");
  redactCmd.add_argument("--output", "-o")
      .help("Where to write the copy (default: <name>.redacted<ext> beside it)")
      .default_value(std::string(""));

  // ─── Register sub-commands ─────────────────────────────────────

  program.add_subparser(statusCmd);
  argparse::ArgumentParser moveCmd("move");
  moveCmd.add_description(
      "Restage files into a different branch's default changelist, or into a "
      "numbered pending changelist");
  moveCmd.add_argument("--branch", "-b")
      .help("Target branch (must be active in this workspace)")
      .default_value(std::string(""));
  moveCmd.add_argument("--changelist", "-c")
      .help("Target numbered pending changelist")
      .scan<'i', int>();
  moveCmd.add_argument("files")
      .help("Files to move")
      .remaining();

  // changelist (alias: cl), with its own sub-commands
  argparse::ArgumentParser changelistCmd("changelist");
  changelistCmd.add_description(
      "Manage pending changelists: numbered groupings of staged files that "
      "submit together (alias: cl)");

  argparse::ArgumentParser clNewCmd("new");
  clNewCmd.add_description("Create an empty pending changelist and print its id");
  clNewCmd.add_argument("--message", "-m")
      .help("Description")
      .default_value(std::string(""));
  clNewCmd.add_argument("--branch", "-b")
      .help("Branch it submits to (default: domain root)")
      .default_value(std::string(""));

  argparse::ArgumentParser clListCmd("list");
  clListCmd.add_description("List pending changelists and their file counts");

  argparse::ArgumentParser clEditCmd("edit");
  clEditCmd.add_description(
      "Set the description of a numbered changelist, or of a branch's default "
      "changelist");
  clEditCmd.add_argument("changelist")
      .help("Changelist id, or \"default\"");
  clEditCmd.add_argument("--message", "-m")
      .help("New description")
      .required();
  clEditCmd.add_argument("--branch", "-b")
      .help("With \"default\": whose default changelist (default: domain root)")
      .default_value(std::string(""));

  argparse::ArgumentParser clDeleteCmd("delete");
  clDeleteCmd.add_description(
      "Delete a pending changelist; its files stay staged in their branch's "
      "default changelist");
  clDeleteCmd.add_argument("changelist")
      .help("Changelist id");

  changelistCmd.add_subparser(clNewCmd);
  changelistCmd.add_subparser(clListCmd);
  changelistCmd.add_subparser(clEditCmd);
  changelistCmd.add_subparser(clDeleteCmd);

  program.add_subparser(addCmd);
  program.add_subparser(moveCmd);
  program.add_subparser(changelistCmd);
  program.add_subparser(restoreCmd);
  program.add_subparser(chmodCmd);
  program.add_subparser(submitCmd);
  program.add_subparser(pullCmd);
  program.add_subparser(cleanCmd);
  program.add_subparser(logCmd);
  program.add_subparser(branchCmd);
  program.add_subparser(switchCmd);
  program.add_subparser(mergeCmd);
  program.add_subparser(checkoutCmd);
  program.add_subparser(revertCmd);
  program.add_subparser(diffCmd);
  program.add_subparser(initCmd);
  program.add_subparser(unlinkCmd);
  program.add_subparser(accountsCmd);
  program.add_subparser(loginCmd);
  program.add_subparser(logoutCmd);
  program.add_subparser(artifactCmd);
  program.add_subparser(configCmd);
  program.add_subparser(mcpCmd);
  program.add_subparser(updateCmd);
  program.add_subparser(bugReportCmd);
  program.add_subparser(redactCmd);

  // ─── Parse arguments ──────────────────────────────────────────

  try {
    program.parse_args(argc, argv);
    checkpoint::setForceDaemonless(program.get<bool>("--no-daemon"));
  } catch (const std::exception& err) {
    std::cerr << err.what() << std::endl;
    std::cerr << std::endl;

    // Show help for the relevant subcommand if possible
    if (argc >= 2) {
      std::string cmd = argv[1];
      if (cmd == "status") {
        std::cerr << statusCmd;
      } else if (cmd == "add") {
        std::cerr << addCmd;
      } else if (cmd == "move") {
        std::cerr << moveCmd;
      } else if (cmd == "changelist") {
        std::string action = argc >= 3 ? argv[2] : "";
        if (action == "new") {
          std::cerr << clNewCmd;
        } else if (action == "list") {
          std::cerr << clListCmd;
        } else if (action == "edit") {
          std::cerr << clEditCmd;
        } else if (action == "delete") {
          std::cerr << clDeleteCmd;
        } else {
          std::cerr << changelistCmd;
        }
      } else if (cmd == "restore") {
        std::cerr << restoreCmd;
      } else if (cmd == "submit") {
        std::cerr << submitCmd;
      } else if (cmd == "pull") {
        std::cerr << pullCmd;
      } else if (cmd == "clean") {
        std::cerr << cleanCmd;
      } else if (cmd == "log") {
        std::cerr << logCmd;
      } else if (cmd == "branch") {
        std::cerr << branchCmd;
      } else if (cmd == "switch") {
        std::cerr << switchCmd;
      } else if (cmd == "merge") {
        std::cerr << mergeCmd;
      } else if (cmd == "checkout") {
        std::cerr << checkoutCmd;
      } else if (cmd == "revert") {
        std::cerr << revertCmd;
      } else if (cmd == "diff") {
        std::cerr << diffCmd;
      } else if (cmd == "init") {
        std::cerr << initCmd;
      } else if (cmd == "unlink") {
        std::cerr << unlinkCmd;
      } else if (cmd == "accounts") {
        std::cerr << accountsCmd;
      } else if (cmd == "login") {
        std::cerr << loginCmd;
      } else if (cmd == "logout") {
        std::cerr << logoutCmd;
      } else if (cmd == "artifact") {
        std::cerr << artifactCmd;
      } else if (cmd == "config") {
        std::cerr << configCmd;
      } else if (cmd == "mcp") {
        std::cerr << mcpCmd;
      } else if (cmd == "update") {
        std::cerr << updateCmd;
      } else if (cmd == "bug-report") {
        std::cerr << bugReportCmd;
      } else if (cmd == "redact") {
        std::cerr << redactCmd;
      } else {
        std::cerr << program;
      }
    } else {
      std::cerr << program;
    }

    return 1;
  }

  // ─── Dispatch commands ─────────────────────────────────────────

  try {
    // Check CLI ↔ Daemon API version compatibility before any command,
    // EXCEPT `update`, which is how the user recovers from a bad version
    // mismatch in the first place, and the diagnostics commands, which must
    // still work when something is wrong.
    if (!program.is_subcommand_used(updateCmd) &&
        !program.is_subcommand_used(bugReportCmd) &&
        !program.is_subcommand_used(redactCmd)) {
      int versionResult = checkpoint::checkDaemonVersion();
      if (versionResult != 0) return versionResult;
    }

    if (program.is_subcommand_used(statusCmd)) {
      return checkpoint::cmdStatus();
    }

    if (program.is_subcommand_used(moveCmd)) {
      auto files = moveCmd.get<std::vector<std::string>>("files");
      auto branch = moveCmd.get<std::string>("--branch");
      auto changelist = moveCmd.present<int>("--changelist");
      if (!checkChangelistArg(changelist)) return 1;
      if (files.empty()) {
        std::cerr << "error: move requires at least one file." << std::endl;
        return 1;
      }
      if (branch.empty() == !changelist.has_value()) {
        std::cerr << "error: move takes exactly one of -b <branch> or "
                  << "-c <changelist>." << std::endl;
        return 1;
      }
      return checkpoint::cmdMove(files, branch, changelist.value_or(0));
    }

    if (program.is_subcommand_used(changelistCmd)) {
      if (changelistCmd.is_subcommand_used(clNewCmd)) {
        return checkpoint::cmdChangelistNew(
            clNewCmd.get<std::string>("--message"),
            clNewCmd.get<std::string>("--branch"));
      }
      if (changelistCmd.is_subcommand_used(clEditCmd)) {
        auto target = clEditCmd.get<std::string>("changelist");
        auto branch = clEditCmd.get<std::string>("--branch");
        auto message = clEditCmd.get<std::string>("--message");
        if (target == "default") {
          return checkpoint::cmdChangelistEdit(0, branch, message);
        }
        int id = 0;
        if (!checkpoint::parseChangelistId(target, id)) {
          std::cerr << "error: invalid changelist \"" << target
                    << "\"; use an id or \"default\"." << std::endl;
          return 1;
        }
        if (!branch.empty()) {
          std::cerr << "error: -b only applies to \"default\"; a numbered "
                    << "changelist already has a branch." << std::endl;
          return 1;
        }
        return checkpoint::cmdChangelistEdit(id, "", message);
      }
      if (changelistCmd.is_subcommand_used(clDeleteCmd)) {
        auto target = clDeleteCmd.get<std::string>("changelist");
        int id = 0;
        if (!checkpoint::parseChangelistId(target, id)) {
          std::cerr << "error: invalid changelist id \"" << target << "\"."
                    << std::endl;
          return 1;
        }
        return checkpoint::cmdChangelistDelete(id);
      }
      // `list`, or no action at all, lists.
      return checkpoint::cmdChangelistList();
    }

    if (program.is_subcommand_used(addCmd)) {
      auto files = addCmd.get<std::vector<std::string>>("files");
      auto branch = addCmd.get<std::string>("--branch");
      auto changelist = addCmd.present<int>("--changelist");
      if (!checkChangelistArg(changelist)) return 1;
      if (changelist.has_value() && !branch.empty()) {
        std::cerr << "error: add takes -b or -c, not both; a changelist "
                  << "submits to its own branch." << std::endl;
        return 1;
      }
      if (addCmd.get<bool>("--patch")) {
        if (changelist.has_value()) {
          std::cerr << "error: add --patch does not take -c; stage the hunks, "
                    << "then \"chk move -c\" the file." << std::endl;
          return 1;
        }
        if (files.size() != 1) {
          std::cerr << "error: add --patch takes exactly one file." << std::endl;
          return 1;
        }
        return checkpoint::cmdAddPatch(files[0], branch);
      }
      return checkpoint::cmdAdd(files, branch, changelist.value_or(0));
    }

    if (program.is_subcommand_used(restoreCmd)) {
      auto files = restoreCmd.get<std::vector<std::string>>("files");
      bool staged = restoreCmd.get<bool>("--staged");
      return checkpoint::cmdRestore(files, staged);
    }

    if (program.is_subcommand_used(chmodCmd)) {
      bool on = chmodCmd.get<bool>("+x");
      bool off = chmodCmd.get<bool>("-x");
      if (on == off) {
        std::cerr << "error: chmod takes exactly one of +x or -x." << std::endl;
        return 1;
      }
      return checkpoint::cmdChmod(
          on ? "+x" : "-x", chmodCmd.get<std::vector<std::string>>("files"));
    }

    if (program.is_subcommand_used(submitCmd)) {
      auto message = submitCmd.get<std::string>("--message");
      bool noProgress = submitCmd.get<bool>("--no-progress");
      auto branch = submitCmd.get<std::string>("--branch");
      auto changelist = submitCmd.present<int>("--changelist");
      if (!checkChangelistArg(changelist)) return 1;
      if (changelist.has_value() && !branch.empty()) {
        std::cerr << "error: submit takes -b or -c, not both; a changelist "
                  << "submits to its own branch." << std::endl;
        return 1;
      }
      return checkpoint::cmdSubmit(message, noProgress, branch,
                                   changelist.value_or(0));
    }

    if (program.is_subcommand_used(pullCmd)) {
      auto changelist = pullCmd.present<int>("--changelist");
      auto confirmLinks =
          pullCmd.present<std::vector<std::string>>("--confirm-links")
              .value_or(std::vector<std::string>{});
      return checkpoint::cmdPull(pullCmd.get<bool>("--no-progress"),
                                 changelist, confirmLinks,
                                 pullCmd.get<bool>("--skip-links"));
    }

    if (program.is_subcommand_used(cleanCmd)) {
      return checkpoint::cmdClean(cleanCmd.get<bool>("--no-progress"),
                                  cleanCmd.get<bool>("--yes"));
    }

    if (program.is_subcommand_used(logCmd)) {
      auto limit = logCmd.present<int>("--limit");
      return checkpoint::cmdLog(limit.has_value() ? limit.value() : 0);
    }

    if (program.is_subcommand_used(branchCmd)) {
      return checkpoint::cmdBranch();
    }

    if (program.is_subcommand_used(switchCmd)) {
      auto branch = switchCmd.get<std::string>("branch");
      return checkpoint::cmdSwitch(branch);
    }

    if (program.is_subcommand_used(mergeCmd)) {
      auto branch = mergeCmd.get<std::string>("branch");
      return checkpoint::cmdMerge(branch);
    }

    if (program.is_subcommand_used(checkoutCmd)) {
      auto file = checkoutCmd.get<std::string>("file");
      bool exclusive = checkoutCmd.get<bool>("--exclusive");
      return checkpoint::cmdCheckout(file, exclusive);
    }

    if (program.is_subcommand_used(revertCmd)) {
      auto files = revertCmd.get<std::vector<std::string>>("files");
      if (revertCmd.get<bool>("--unchanged")) {
        return checkpoint::cmdRevertUnchanged(files);
      }
      if (files.empty()) {
        std::cerr << "error: revert needs at least one file (or -a to revert "
                     "unchanged files)"
                  << std::endl;
        std::cerr << revertCmd;
        return 1;
      }
      return checkpoint::cmdRevert(files);
    }

    if (program.is_subcommand_used(diffCmd)) {
      auto file = diffCmd.get<std::string>("file");
      return checkpoint::cmdDiff(file);
    }

    if (program.is_subcommand_used(initCmd)) {
      auto repo = initCmd.get<std::string>("repo");
      auto branch = initCmd.get<std::string>("--branch");
      auto account = initCmd.get<std::string>("--account");
      return checkpoint::cmdInit(repo, branch, account);
    }

    if (program.is_subcommand_used(unlinkCmd)) {
      return checkpoint::cmdUnlink();
    }

    if (program.is_subcommand_used(accountsCmd)) {
      return checkpoint::cmdAccounts();
    }

    if (program.is_subcommand_used(loginCmd)) {
      auto endpoint = loginCmd.get<std::string>("--endpoint");
      auto daemonId = loginCmd.get<std::string>("--id");
      auto token = loginCmd.get<std::string>("--token");
      if (daemonId.empty()) {
        // Generate a unique daemon ID (21-char alphanumeric, similar to nanoid)
        static const char charset[] =
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<> dist(0, sizeof(charset) - 2);
        daemonId = "cli-";
        for (int i = 0; i < 21; i++) {
          daemonId += charset[dist(gen)];
        }
      }
      return checkpoint::cmdLogin(endpoint, daemonId, token);
    }

    if (program.is_subcommand_used(logoutCmd)) {
      return checkpoint::cmdLogout();
    }

    if (program.is_subcommand_used(artifactCmd)) {
      auto action = artifactCmd.get<std::string>("action");
      if (action == "upload") {
        const char* usage =
            "  Usage: chk artifact upload <cl-number> --type <type> [files...] [--replace]";
        auto clStr = artifactCmd.get<std::string>("cl_number");
        if (clStr.empty()) {
          std::cerr << "error: artifact upload requires a changelist number." << std::endl;
          std::cerr << usage << std::endl;
          return 1;
        }
        auto type = artifactCmd.get<std::string>("--type");
        if (type.empty()) {
          std::cerr << "error: artifact upload requires --type, the artifact type from teamsync.yaml." << std::endl;
          std::cerr << usage << std::endl;
          return 1;
        }
        int clNum;
        try {
          clNum = std::stoi(clStr);
        } catch (...) {
          std::cerr << "error: invalid changelist number: " << clStr << std::endl;
          return 1;
        }
        std::vector<std::string> files;
        try {
          files = artifactCmd.get<std::vector<std::string>>("files");
        } catch (...) {
          // no files named
        }
        auto msg = artifactCmd.get<std::string>("--message");
        return checkpoint::cmdArtifactUpload(
            clNum, files, msg, type, artifactCmd.get<bool>("--replace"));
      } else {
        std::cerr << "error: unknown artifact action '" << action << "'. Use 'upload'." << std::endl;
        return 1;
      }
    }

    if (program.is_subcommand_used(configCmd)) {
      auto key = configCmd.get<std::string>("key");
      auto value = configCmd.get<std::string>("value");
      if (false /* TODO */) {
        // placeholder for future config options
      } else {
        std::cerr << "error: unknown config key '" << key << "'. Supported: TODO" << std::endl;
        return 1;
      }
    }

    if (program.is_subcommand_used(mcpCmd)) {
      auto action = mcpCmd.get<std::string>("action");
      if (action == "status" || action.empty()) {
        return checkpoint::cmdMcpStatus();
      } else if (action == "enable") {
        return checkpoint::cmdMcpSetEnabled(true);
      } else if (action == "disable") {
        return checkpoint::cmdMcpSetEnabled(false);
      } else {
        std::cerr << "error: unknown mcp action '" << action
                  << "'. Use 'status', 'enable', or 'disable'." << std::endl;
        return 1;
      }
    }

    if (program.is_subcommand_used(updateCmd)) {
      auto action = updateCmd.get<std::string>("action");
      bool yes = updateCmd.get<bool>("--yes");
      if (action == "check" || action.empty()) {
        return checkpoint::cmdUpdateCheck();
      } else if (action == "install") {
        return checkpoint::cmdUpdateInstall(yes);
      } else {
        std::cerr << "error: unknown update action '" << action
                  << "'. Use 'check' or 'install'." << std::endl;
        return 1;
      }
    }

    if (program.is_subcommand_used(bugReportCmd)) {
      return checkpoint::cmdBugReport();
    }

    if (program.is_subcommand_used(redactCmd)) {
      return checkpoint::cmdRedact(redactCmd.get<std::string>("file"),
                                   redactCmd.get<std::string>("--output"));
    }

    // No command specified: show help
    std::cout << program;
    return 0;

  } catch (const std::exception& err) {
    std::string msg = err.what();
    // The daemon's hard-block middleware returns this exact message via tRPC
    // FORBIDDEN when the running daemon is below the connected server's
    // minimumDaemonVersion. Render a friendlier prompt instead of a raw error.
    if (msg.find("update required") != std::string::npos) {
      std::cerr << "\033[1;31m" << "error: " << "\033[0m"
                << "\033[31m" << msg << "\033[0m" << std::endl;
      std::cerr << "  Run `chk update install` to upgrade Checkpoint."
                << std::endl;
      return 1;
    }
    std::cerr << "\033[31m" << "error: " << err.what() << "\033[0m" << std::endl;
    return 1;
  }
}
