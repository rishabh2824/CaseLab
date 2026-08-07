import time
from functools import lru_cache
import boto3
from botocore.config import Config
from infra.settings import getSettings

SPACES_REGION = "sfo3"
SPACES_ENDPOINT = "https://sfo3.digitaloceanspaces.com"
SPACES_BUCKET = "case-file"

# generate_presigned_url signs with the current instant (X-Amz-Date), so calling it fresh
# on every read mints a new query string - and therefore a new URL - every time, even
# though the actual expiry (spaces_download_expiry, ~9000s) barely moved. Since the URL is
# what the browser's HTTP cache keys on, that means every avatar re-downloads on every state
# fetch. Rounding "now" down to a 15-minute bucket before signing means repeat reads within
# the same window get the byte-identical URL back (see getUrl's lru_cache below) - the real
# expiry is still ~9000s past whenever it was first minted in that window, so this never
# hands out a URL that's actually about to expire.
GET_URL_BUCKET_SECONDS = 15 * 60


@lru_cache(maxsize=1)
def getSpacesClient():
    settings = getSettings()
    return boto3.client(
        "s3",
        region_name=SPACES_REGION,
        endpoint_url=SPACES_ENDPOINT,
        aws_access_key_id=settings.spaces_key,
        aws_secret_access_key=settings.spaces_secret,
        # Explicit timeouts: botocore's defaults are 60s connect + 60s read (before its
        # own retry budget even kicks in), so a stalled Spaces connection can otherwise
        # tie up whoever's calling this client -- deleteObject below, run through
        # run_in_threadpool, is the caller that actually matters, but the timeout is on
        # the shared client either way. putUrl/getUrl never touch the network (they only
        # sign locally), so this has no effect on them.
        config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=10, retries={"max_attempts": 2}),
    )


def putUrl(object_key: str, content_type=None) -> str:
    settings = getSettings()
    client = getSpacesClient()
    params: dict[str, str] = {"Bucket": SPACES_BUCKET, "Key": object_key}
    if content_type: params["ContentType"] = content_type
    return client.generate_presigned_url("put_object", Params=params, ExpiresIn=settings.spaces_upload_expiry)


# bucket is `object_key` + the current 15-minute window, not `object_key` alone - a
# genuinely unbounded cache (one entry per file, forever) would leak memory over a
# long-lived process; keying by bucket too means old entries simply stop being requested
# and age out under maxsize's normal LRU eviction instead of needing manual invalidation.
@lru_cache(maxsize=4096)
def _cachedGetUrl(object_key: str, expires_in: int, bucket: int) -> str:
    client = getSpacesClient()
    params: dict[str, str] = {"Bucket": SPACES_BUCKET, "Key": object_key}
    return client.generate_presigned_url("get_object", Params=params, ExpiresIn=expires_in)


def getUrl(object_key: str) -> str:
    settings = getSettings()
    bucket = int(time.time() // GET_URL_BUCKET_SECONDS)
    return _cachedGetUrl(object_key, settings.spaces_download_expiry, bucket)


def deleteObject(object_key: str) -> None:
    client = getSpacesClient()
    client.delete_object(Bucket=SPACES_BUCKET, Key=object_key)
