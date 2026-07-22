from __future__ import annotations

import os
import sys


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("usage: exec_in_dir <directory-fd> <command> [args...]")
    descriptor = int(sys.argv[1])
    command = sys.argv[2:]
    os.fchdir(descriptor)
    os.close(descriptor)
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()
