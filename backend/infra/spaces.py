from functools import lru_cache
import boto3
from botocore.config import Config
from infra.settings import get_settings

SPACES_REGION = "sfo3"
# Regional endpoint only — must NOT include the bucket name. boto3 falls back to
# path-style addressing for custom endpoint_urls, so a bucket-in-hostname endpoint
# (e.g. "https://case-file.sfo3.digitaloceanspaces.com") gets the bucket appended
# a second time as a literal path segment ("/case-file/{key}"), silently writing
# and reading objects under a spurious "case-file/" folder inside the bucket.
SPACES_ENDPOINT = "https://sfo3.digitaloceanspaces.com"
SPACES_BUCKET = "case-file"


@lru_cache(maxsize=1)
def get_spaces_client():
    settings = get_settings()
    return boto3.client(
        "s3",
        region_name=SPACES_REGION,
        endpoint_url=SPACES_ENDPOINT,
        aws_access_key_id=settings.spaces_key,
        aws_secret_access_key=settings.spaces_secret,
        config=Config(signature_version="s3v4"),
    )


def putUrl(object_key: str, content_type=None) -> str:
    settings = get_settings()
    client = get_spaces_client()
    params: dict[str, str] = {"Bucket": SPACES_BUCKET, "Key": object_key}
    if content_type: params["ContentType"] = content_type
    return client.generate_presigned_url("put_object", Params=params, ExpiresIn=settings.spaces_upload_expiry)


def getUrl(object_key: str) -> str:
    settings = get_settings()
    client = get_spaces_client()
    params: dict[str, str] = {"Bucket": SPACES_BUCKET, "Key": object_key}
    return client.generate_presigned_url("get_object", Params=params, ExpiresIn=settings.spaces_download_expiry)
