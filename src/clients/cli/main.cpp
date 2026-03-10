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
 *   checkout <file>               Check out a controlled file
 *   revert <file...>              Revert files to head version
 *   diff <file>                   Show diff for a file
 *   init [orgName/repoName]       Initialize a workspace in the current directory
 */

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "argparse.hpp"
#include "commands.hpp"

int main(int argc, char** argv) {
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

  // branch
  argparse::ArgumentParser branchCmd("branch");
  branchCmd.add_description("List branches");

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

  // ─── Register sub-commands ─────────────────────────────────────

  program.add_subparser(statusCmd);
  program.add_subparser(addCmd);
  program.add_subparser(restoreCmd);
  program.add_subparser(submitCmd);
  program.add_subparser(pullCmd);
  program.add_subparser(logCmd);
  program.add_subparser(branchCmd);
  program.add_subparser(checkoutCmd);
  program.add_subparser(revertCmd);
  program.add_subparser(diffCmd);
  program.add_subparser(initCmd);

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
      } else if (cmd == "checkout") {
        std::cerr << checkoutCmd;
      } else if (cmd == "revert") {
        std::cerr << revertCmd;
      } else if (cmd == "diff") {
        std::cerr << diffCmd;
      } else if (cmd == "init") {
        std::cerr << initCmd;
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
      return checkpoint::cmdLog();
    }

    if (program.is_subcommand_used(branchCmd)) {
      return checkpoint::cmdBranch();
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

    // No command specified — show help
    std::cout << program;
    return 0;

  } catch (const std::exception& err) {
    std::cerr << "\033[31m" << "error: " << err.what() << "\033[0m" << std::endl;
    return 1;
  }
}
