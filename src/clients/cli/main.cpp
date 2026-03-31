/**
 * Checkpoint CLI — A command-line client for the Checkpoint daemon.
 *
 * Usage:
 *   checkpoint <command> [options]
 *   chk <command> [options]
 *
 * Commands:
 *   status                        Show pending changes
 *   add <file...>                 Stage files for submission
 *   restore [--staged] <file...>  Unstage or revert files
 *   submit --message <msg>        Submit staged files
 *   pull                          Sync changes from remote
 *   log                           Show version history
 *   branch                        List branches
 *   switch <branch>               Switch to a different branch
 *   merge <branch>                Merge a branch into the current branch
 *   checkout <file>               Check out a controlled file
 *   revert <file...>              Revert files to head version
 *   diff <file>                   Show diff for a file
 *   init [orgName/repoName]       Initialize a workspace in the current directory
 *   accounts                      List authenticated accounts
 *   login [--endpoint URL]        Authenticate with a Checkpoint server
 *   shelve <name> [-m msg]        Shelve staged files to a named shelf
 *   unshelve <name> [-b branch]   Submit a shelf to a branch
 *   shelf [list|delete <name>]    Manage shelves
 *   artifact upload <cl> <files>  Upload artifacts for a changelist
 */

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "argparse.hpp"
#include "commands.hpp"

int main(int argc, char** argv) {
  // Preprocess argv: expand "-N" shorthand to "--limit N" for the log command.
  // e.g. `chk log -5` becomes `chk log --limit 5`
  // Two-pass: collect strings first, then take pointers (avoids dangling from realloc).
  std::vector<std::string> argStorage;
  bool seenLog = false;
  for (int i = 0; i < argc; ++i) {
    std::string arg = argv[i];
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

  argparse::ArgumentParser program(programName, "1.0.0");
  program.add_description("Checkpoint version control CLI");

  // ─── Sub-commands ──────────────────────────────────────────────

  // status
  argparse::ArgumentParser statusCmd("status");
  statusCmd.add_description("Show pending changes in the current workspace");

  // add
  argparse::ArgumentParser addCmd("add");
  addCmd.add_description("Stage files for submission (mark for add)");
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

  // submit
  argparse::ArgumentParser submitCmd("submit");
  submitCmd.add_description("Submit staged files as a new version");
  submitCmd.add_argument("--message", "-m")
      .help("Submission message")
      .required();

  // pull
  argparse::ArgumentParser pullCmd("pull");
  pullCmd.add_description("Sync changes from remote");

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
  checkoutCmd.add_argument("--lock", "-l")
      .help("Lock the file (prevent others from editing)")
      .default_value(false)
      .implicit_value(true);

  // revert
  argparse::ArgumentParser revertCmd("revert");
  revertCmd.add_description("Revert files to their head version");
  revertCmd.add_argument("files")
      .help("File(s) to revert")
      .nargs(argparse::nargs_pattern::at_least_one);

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

  // shelve
  argparse::ArgumentParser shelveCmd("shelve");
  shelveCmd.add_description("Shelve staged files to a named shelf");
  shelveCmd.add_argument("name")
      .help("Name of the shelf");
  shelveCmd.add_argument("--message", "-m")
      .help("Shelf message")
      .default_value(std::string(""));

  // unshelve
  argparse::ArgumentParser unshelveCmd("unshelve");
  unshelveCmd.add_description("Submit a shelf to a branch");
  unshelveCmd.add_argument("name")
      .help("Name of the shelf to submit");
  unshelveCmd.add_argument("--branch", "-b")
      .help("Target branch (defaults to current branch)")
      .default_value(std::string(""));

  // shelf (management subcommand)
  argparse::ArgumentParser shelfCmd("shelf");
  shelfCmd.add_description("Manage shelves");
  shelfCmd.add_argument("action")
      .help("Action: list, delete")
      .default_value(std::string("list"))
      .nargs(argparse::nargs_pattern::optional);
  shelfCmd.add_argument("name")
      .help("Shelf name (for delete)")
      .default_value(std::string(""))
      .nargs(argparse::nargs_pattern::optional);

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
      .help("Files to upload as artifacts")
      .remaining();
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

  // ─── Register sub-commands ─────────────────────────────────────

  program.add_subparser(statusCmd);
  program.add_subparser(addCmd);
  program.add_subparser(restoreCmd);
  program.add_subparser(submitCmd);
  program.add_subparser(pullCmd);
  program.add_subparser(logCmd);
  program.add_subparser(branchCmd);
  program.add_subparser(switchCmd);
  program.add_subparser(mergeCmd);
  program.add_subparser(checkoutCmd);
  program.add_subparser(revertCmd);
  program.add_subparser(diffCmd);
  program.add_subparser(initCmd);
  program.add_subparser(accountsCmd);
  program.add_subparser(loginCmd);
  program.add_subparser(shelveCmd);
  program.add_subparser(unshelveCmd);
  program.add_subparser(shelfCmd);
  program.add_subparser(artifactCmd);
  program.add_subparser(configCmd);

  // ─── Parse arguments ──────────────────────────────────────────

  try {
    program.parse_args(argc, argv);
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
      } else if (cmd == "restore") {
        std::cerr << restoreCmd;
      } else if (cmd == "submit") {
        std::cerr << submitCmd;
      } else if (cmd == "pull") {
        std::cerr << pullCmd;
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
      } else if (cmd == "accounts") {
        std::cerr << accountsCmd;
      } else if (cmd == "login") {
        std::cerr << loginCmd;
      } else if (cmd == "shelve") {
        std::cerr << shelveCmd;
      } else if (cmd == "unshelve") {
        std::cerr << unshelveCmd;
      } else if (cmd == "shelf") {
        std::cerr << shelfCmd;
      } else if (cmd == "artifact") {
        std::cerr << artifactCmd;
      } else if (cmd == "config") {
        std::cerr << configCmd;
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
    if (program.is_subcommand_used(statusCmd)) {
      return checkpoint::cmdStatus();
    }

    if (program.is_subcommand_used(addCmd)) {
      auto files = addCmd.get<std::vector<std::string>>("files");
      return checkpoint::cmdAdd(files);
    }

    if (program.is_subcommand_used(restoreCmd)) {
      auto files = restoreCmd.get<std::vector<std::string>>("files");
      bool staged = restoreCmd.get<bool>("--staged");
      return checkpoint::cmdRestore(files, staged);
    }

    if (program.is_subcommand_used(submitCmd)) {
      auto message = submitCmd.get<std::string>("--message");
      return checkpoint::cmdSubmit(message);
    }

    if (program.is_subcommand_used(pullCmd)) {
      return checkpoint::cmdPull();
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
      bool locked = checkoutCmd.get<bool>("--lock");
      return checkpoint::cmdCheckout(file, locked);
    }

    if (program.is_subcommand_used(revertCmd)) {
      auto files = revertCmd.get<std::vector<std::string>>("files");
      return checkpoint::cmdRevert(files);
    }

    if (program.is_subcommand_used(diffCmd)) {
      auto file = diffCmd.get<std::string>("file");
      return checkpoint::cmdDiff(file);
    }

    if (program.is_subcommand_used(initCmd)) {
      auto repo = initCmd.get<std::string>("repo");
      return checkpoint::cmdInit(repo);
    }

    if (program.is_subcommand_used(accountsCmd)) {
      return checkpoint::cmdAccounts();
    }

    if (program.is_subcommand_used(loginCmd)) {
      auto endpoint = loginCmd.get<std::string>("--endpoint");
      auto daemonId = loginCmd.get<std::string>("--id");
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
      return checkpoint::cmdLogin(endpoint, daemonId);
    }

    if (program.is_subcommand_used(shelveCmd)) {
      auto name = shelveCmd.get<std::string>("name");
      auto msg = shelveCmd.get<std::string>("--message");
      return checkpoint::cmdShelve(name, msg);
    }

    if (program.is_subcommand_used(unshelveCmd)) {
      auto name = unshelveCmd.get<std::string>("name");
      auto branch = unshelveCmd.get<std::string>("--branch");
      return checkpoint::cmdUnshelve(name, branch);
    }

    if (program.is_subcommand_used(shelfCmd)) {
      auto action = shelfCmd.get<std::string>("action");
      auto name = shelfCmd.get<std::string>("name");
      if (action == "list" || action.empty()) {
        return checkpoint::cmdShelfList();
      } else if (action == "delete") {
        if (name.empty()) {
          std::cerr << "error: shelf delete requires a shelf name." << std::endl;
          return 1;
        }
        return checkpoint::cmdShelfDelete(name);
      } else {
        std::cerr << "error: unknown shelf action '" << action << "'. Use 'list' or 'delete'." << std::endl;
        return 1;
      }
    }

    if (program.is_subcommand_used(artifactCmd)) {
      auto action = artifactCmd.get<std::string>("action");
      if (action == "upload") {
        auto clStr = artifactCmd.get<std::string>("cl_number");
        if (clStr.empty()) {
          std::cerr << "error: artifact upload requires a changelist number." << std::endl;
          std::cerr << "  Usage: chk artifact upload <cl-number> <file1> [file2] ..." << std::endl;
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
          // no remaining files
        }
        auto msg = artifactCmd.get<std::string>("--message");
        return checkpoint::cmdArtifactUpload(clNum, files, msg);
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
        std::cerr << "error: unknown config key '" << key << "'. Supported: artifacts" << std::endl;
        return 1;
      }
    }

    // No command specified — show help
    std::cout << program;
    return 0;

  } catch (const std::exception& err) {
    std::cerr << "\033[31m" << "error: " << err.what() << "\033[0m" << std::endl;
    return 1;
  }
}
