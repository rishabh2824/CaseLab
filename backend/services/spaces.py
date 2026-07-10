from functools import lru_cache

import boto3
from botocore.config import Config
from settings import get_settings


@lru_cache(maxsize=1)
def get_spaces_client():
    """Cached client, built once and reused (same pattern as get_db_client).

    Construction loads/validates botocore service models and the credential
    chain — real CPU work on the event loop — while generate_presigned_url
    itself is cheap local signing and thread-safe to call on a shared client.
    Building a fresh client per call was wasted work on every presigned URL
    (every profile photo, every contact, every 15s poll, every student).
    """
    settings = get_settings()
    return boto3.client(
        "s3",
        region_name=settings.spaces_region,
        endpoint_url=settings.spaces_endpoint,
        aws_access_key_id=settings.spaces_key,
        aws_secret_access_key=settings.spaces_secret,
        config=Config(signature_version="s3v4"),
    )


def create_presigned_put_url(object_key: str, content_type=None) -> str:
    settings = get_settings()
    client = get_spaces_client()
    params: dict[str, str] = {"Bucket": settings.spaces_bucket, "Key": object_key}
    if content_type:
        params["ContentType"] = content_type
    return client.generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=settings.spaces_presign_expiry_seconds,
    )


def create_presigned_get_url(object_key: str) -> str:
    settings = get_settings()
    client = get_spaces_client()
    params: dict[str, str] = {"Bucket": settings.spaces_bucket, "Key": object_key}
    return client.generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=settings.spaces_presign_expiry_seconds,
    )
