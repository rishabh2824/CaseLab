from urllib.parse import urlsplit
from infra.spaces import SPACES_BUCKET, getUrl, putUrl

# Regression test for a bug where SPACES_ENDPOINT baked the bucket name into the
# hostname (e.g. "https://case-file.sfo3.digitaloceanspaces.com"). boto3 falls back
# to path-style addressing for custom endpoint_urls, so it appended the bucket a
# second time as a literal path segment, silently writing/reading objects under a
# spurious "case-file/" folder instead of the real key.


def assert_clean_object_url(url: str, object_key: str) -> None:
    parts = urlsplit(url)
    assert SPACES_BUCKET not in parts.netloc, f"bucket must not be baked into the host: {parts.netloc}"
    assert parts.path == f"/{SPACES_BUCKET}/{object_key}", f"unexpected path: {parts.path}"


def test_put_url_does_not_duplicate_bucket_in_path():
    assert_clean_object_url(putUrl("cases/some-case/abc123.png", "image/png"), "cases/some-case/abc123.png")


def test_get_url_does_not_duplicate_bucket_in_path():
    assert_clean_object_url(getUrl("cases/some-case/abc123.png"), "cases/some-case/abc123.png")
