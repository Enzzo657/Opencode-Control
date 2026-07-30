from __future__ import annotations

from opencode_control.redaction import REDACTED, redact_text, secret_name


def test_redacts_headers_cookies_tokens_and_url_credentials() -> None:
    secrets = [
        "bearer-secret-value",
        "cookie-secret-value",
        "super-secret-password",
        "github_pat_1234567890abcdef",
        "url-password",
        "signed-query-value",
    ]
    source = "\n".join(
        [
            "Authorization: Bearer bearer-secret-value",
            "Cookie: session=cookie-secret-value; theme=dark",
            "password=super-secret-password",
            "token github_pat_1234567890abcdef",
            "https://user:url-password@example.com/path?signature=signed-query-value",
        ]
    )

    result = redact_text(source)

    assert REDACTED in result
    for secret in secrets:
        assert secret not in result
    assert "example.com/path" in result


def test_redacts_secret_names_with_unusual_separators() -> None:
    assert secret_name("customCredential")
    assert secret_name("PRIVATE-KEY")
    assert secret_name("session_token")
    assert not secret_name("model")
