from __future__ import annotations

import fcntl
import os
import re
import secrets
import stat
from pathlib import Path

ACCESS_TOKEN_FILE = "access-token"
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


class AccessTokenError(RuntimeError):
    pass


def load_or_create_access_token(data_dir: Path) -> str:
    path = data_dir / ACCESS_TOKEN_FILE
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise AccessTokenError(f"could not open runtime access token: {error}") from error
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise AccessTokenError("runtime access token path is unsafe")
        os.fchmod(descriptor, 0o600)
        content = os.read(descriptor, 256)
        if not content:
            token = secrets.token_urlsafe(32)
            os.write(descriptor, token.encode("ascii"))
            os.fsync(descriptor)
            return token
        try:
            token = content.decode("ascii")
        except UnicodeDecodeError as error:
            raise AccessTokenError("runtime access token is invalid") from error
        if not _TOKEN_PATTERN.fullmatch(token):
            raise AccessTokenError("runtime access token is invalid")
        return token
    finally:
        os.close(descriptor)
