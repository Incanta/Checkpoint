#pragma once

#include <functional>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

#ifdef _WIN32
#include <conio.h>
#include <windows.h>
#else
#include <termios.h>
#include <unistd.h>
#endif

namespace checkpoint {

/**
 * Cross-platform raw-mode key reader for interactive terminal menus.
 * Supports arrow keys, Enter, and Escape.
 */
namespace term {

enum class Key {
  Up,
  Down,
  Enter,
  Escape,
  Other,
};

#ifdef _WIN32

inline Key readKey() {
  int ch = _getch();
  if (ch == 0 || ch == 0xE0) {
    int ext = _getch();
    switch (ext) {
      case 72:
        return Key::Up;
      case 80:
        return Key::Down;
      default:
        return Key::Other;
    }
  }
  switch (ch) {
    case 13:
      return Key::Enter;
    case 27:
      return Key::Escape;
    default:
      return Key::Other;
  }
}

inline void enableAnsi() {
  HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD mode = 0;
  GetConsoleMode(hOut, &mode);
  SetConsoleMode(hOut, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

#else  // POSIX

inline Key readKey() {
  struct termios oldt, newt;
  tcgetattr(STDIN_FILENO, &oldt);
  newt = oldt;
  newt.c_lflag &= ~(ICANON | ECHO);
  tcsetattr(STDIN_FILENO, TCSANOW, &newt);

  int ch = getchar();
  Key result = Key::Other;

  if (ch == 27) {  // ESC or escape sequence
    int next = getchar();
    if (next == '[') {
      int code = getchar();
      switch (code) {
        case 'A':
          result = Key::Up;
          break;
        case 'B':
          result = Key::Down;
          break;
        default:
          result = Key::Other;
          break;
      }
    } else if (next == EOF || next == 27) {
      result = Key::Escape;
    } else {
      result = Key::Escape;
    }
  } else if (ch == '\n' || ch == '\r') {
    result = Key::Enter;
  }

  tcsetattr(STDIN_FILENO, TCSANOW, &oldt);
  return result;
}

inline void enableAnsi() {
  // ANSI codes work natively on POSIX terminals
}

#endif

}  // namespace term

/**
 * Display an interactive selection menu.
 *
 * Shows a list of items with a cursor the user can move with arrow keys.
 * Enter selects, Escape cancels (returns nullopt).
 *
 * @param prompt  Text displayed above the list
 * @param items   Display strings for each item
 * @return Index of the selected item, or nullopt if cancelled
 */
inline std::optional<size_t> interactiveSelect(
    const std::string& prompt,
    const std::vector<std::string>& items) {
  if (items.empty()) {
    return std::nullopt;
  }

  term::enableAnsi();

  size_t selected = 0;
  const size_t count = items.size();

  // Hide cursor
  std::cout << "\033[?25l";

  auto render = [&]() {
    // Move cursor up to overwrite (except on first draw)
    std::cout << "\033[" << (count + 1) << "A";
    std::cout << "\r";

    // Print prompt
    std::cout << "\033[1m" << prompt << "\033[0m"
              << "\033[2m  (↑/↓ select, enter confirm, esc cancel)\033[0m"
              << "\033[K" << std::endl;

    // Print items
    for (size_t i = 0; i < count; i++) {
      if (i == selected) {
        std::cout << "  \033[36m❯ " << items[i] << "\033[0m";
      } else {
        std::cout << "    \033[2m" << items[i] << "\033[0m";
      }
      std::cout << "\033[K" << std::endl;
    }
  };

  // Initial draw: print blank lines to reserve space, then render
  std::cout << prompt << std::endl;
  for (size_t i = 0; i < count; i++) {
    std::cout << std::endl;
  }
  render();

  while (true) {
    auto key = term::readKey();
    switch (key) {
      case term::Key::Up:
        if (selected > 0)
          selected--;
        else
          selected = count - 1;
        render();
        break;
      case term::Key::Down:
        if (selected < count - 1)
          selected++;
        else
          selected = 0;
        render();
        break;
      case term::Key::Enter:
        // Show cursor
        std::cout << "\033[?25h";
        return selected;
      case term::Key::Escape:
        // Show cursor
        std::cout << "\033[?25h";
        return std::nullopt;
      default:
        break;
    }
  }
}

}  // namespace checkpoint
