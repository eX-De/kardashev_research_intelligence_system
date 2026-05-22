from __future__ import annotations

from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Protocol

from .config import Settings
from .db import clean_unicode


REMOTE_OBSIDIAN_BACKENDS = {"oss", "s3", "r2"}
DEFAULT_REMOTE_OUTPUT_PREFIX = "Research Intelligence"


class RemoteObjectClient(Protocol):
    def list_keys(self, prefix: str) -> list[str]:
        ...

    def download_to_file(self, key: str, destination: Path) -> None:
        ...

    def object_exists(self, key: str) -> bool:
        ...

    def put_file_append_only(self, key: str, source: Path, content_type: str) -> None:
        ...


def _clean_key_part(value: object) -> str:
    return clean_unicode(str(value or "")).replace("\\", "/").strip().strip("/")


def _join_key(*parts: object) -> str:
    return "/".join(part for part in (_clean_key_part(value) for value in parts) if part)


def obsidian_remote_backend(settings: Settings) -> str:
    backend = clean_unicode(str(getattr(settings, "obsidian_storage_backend", "local") or "local")).strip().lower()
    if backend in {"object", "remote"}:
        return "s3"
    return backend


def obsidian_remote_enabled(settings: Settings) -> bool:
    return obsidian_remote_backend(settings) in REMOTE_OBSIDIAN_BACKENDS


def obsidian_remote_output_prefix(settings: Settings) -> str:
    return _clean_key_part(getattr(settings, "obsidian_remote_output_prefix", "")) or DEFAULT_REMOTE_OUTPUT_PREFIX


def obsidian_remote_configured(settings: Settings) -> bool:
    if not obsidian_remote_enabled(settings):
        return False
    backend = obsidian_remote_backend(settings)
    bucket = clean_unicode(str(getattr(settings, "obsidian_remote_bucket", "") or "")).strip()
    endpoint = clean_unicode(str(getattr(settings, "obsidian_remote_endpoint_url", "") or "")).strip()
    access_key = clean_unicode(str(getattr(settings, "obsidian_remote_access_key_id", "") or "")).strip()
    secret = clean_unicode(str(getattr(settings, "obsidian_remote_secret_access_key", "") or "")).strip()
    if not bucket:
        return False
    if backend in {"oss", "r2"} and not endpoint:
        return False
    if backend in {"oss", "r2"} and (not access_key or not secret):
        return False
    return True


def obsidian_remote_mirror_path(settings: Settings) -> Path:
    return Path(getattr(settings, "obsidian_remote_mirror_dir", "./data/obsidian_remote_vault")).expanduser()


def obsidian_remote_status(settings: Settings) -> dict[str, object]:
    backend = obsidian_remote_backend(settings)
    prefix = _clean_key_part(getattr(settings, "obsidian_remote_prefix", ""))
    output_prefix = obsidian_remote_output_prefix(settings)
    return {
        "enabled": obsidian_remote_enabled(settings),
        "configured": obsidian_remote_configured(settings),
        "backend": backend,
        "bucket": clean_unicode(str(getattr(settings, "obsidian_remote_bucket", "") or "")).strip(),
        "prefix": prefix,
        "output_prefix": output_prefix,
        "mirror_dir": str(obsidian_remote_mirror_path(settings)),
        "append_only": True,
    }


class S3CompatibleClient:
    def __init__(self, settings: Settings):
        try:
            import boto3
            from botocore.exceptions import ClientError, ParamValidationError
        except ImportError as exc:
            raise RuntimeError("boto3 is required for S3/R2-compatible Obsidian storage") from exc

        self._client_error = ClientError
        self._param_validation_error = ParamValidationError
        endpoint = clean_unicode(str(getattr(settings, "obsidian_remote_endpoint_url", "") or "")).strip() or None
        region = clean_unicode(str(getattr(settings, "obsidian_remote_region", "") or "")).strip() or None
        access_key = clean_unicode(str(getattr(settings, "obsidian_remote_access_key_id", "") or "")).strip() or None
        secret = clean_unicode(str(getattr(settings, "obsidian_remote_secret_access_key", "") or "")).strip() or None
        self.bucket = clean_unicode(str(getattr(settings, "obsidian_remote_bucket", "") or "")).strip()
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret,
        )

    def list_keys(self, prefix: str) -> list[str]:
        kwargs = {"Bucket": self.bucket}
        if prefix:
            kwargs["Prefix"] = prefix
        keys: list[str] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(**kwargs):
            for item in page.get("Contents", []):
                key = str(item.get("Key") or "")
                if key:
                    keys.append(key)
        return keys

    def download_to_file(self, key: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as handle:
            self.client.download_fileobj(self.bucket, key, handle)

    def object_exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except self._client_error as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def put_file_append_only(self, key: str, source: Path, content_type: str) -> None:
        try:
            with source.open("rb") as handle:
                self.client.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=handle,
                    ContentType=content_type,
                    IfNoneMatch="*",
                )
            return
        except (TypeError, self._param_validation_error):
            pass
        except Exception as exc:
            response = getattr(exc, "response", {}) or {}
            code = str(response.get("Error", {}).get("Code", ""))
            if code in {"PreconditionFailed", "412"}:
                raise RuntimeError(f"Remote object already exists: {key}") from exc
            raise

        if self.object_exists(key):
            raise RuntimeError(f"Remote object already exists: {key}")
        with source.open("rb") as handle:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=handle, ContentType=content_type)


class AliyunOssClient:
    def __init__(self, settings: Settings):
        try:
            import oss2
        except ImportError as exc:
            raise RuntimeError("oss2 is required for Aliyun OSS Obsidian storage") from exc

        self.oss2 = oss2
        endpoint = clean_unicode(str(getattr(settings, "obsidian_remote_endpoint_url", "") or "")).strip()
        bucket_name = clean_unicode(str(getattr(settings, "obsidian_remote_bucket", "") or "")).strip()
        access_key = clean_unicode(str(getattr(settings, "obsidian_remote_access_key_id", "") or "")).strip()
        secret = clean_unicode(str(getattr(settings, "obsidian_remote_secret_access_key", "") or "")).strip()
        self.bucket = oss2.Bucket(oss2.Auth(access_key, secret), endpoint, bucket_name)

    def list_keys(self, prefix: str) -> list[str]:
        return [item.key for item in self.oss2.ObjectIterator(self.bucket, prefix=prefix)]

    def download_to_file(self, key: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.bucket.get_object_to_file(key, str(destination))

    def object_exists(self, key: str) -> bool:
        return bool(self.bucket.object_exists(key))

    def put_file_append_only(self, key: str, source: Path, content_type: str) -> None:
        headers = {
            "Content-Type": content_type,
            "x-oss-forbid-overwrite": "true",
        }
        try:
            self.bucket.put_object_from_file(key, str(source), headers=headers)
        except Exception as exc:
            message = str(exc)
            if "FileAlreadyExists" in message or "forbid overwrite" in message.lower():
                raise RuntimeError(f"Remote object already exists: {key}") from exc
            raise


def _client(settings: Settings) -> RemoteObjectClient:
    backend = obsidian_remote_backend(settings)
    if backend == "oss":
        return AliyunOssClient(settings)
    if backend in {"s3", "r2"}:
        return S3CompatibleClient(settings)
    raise RuntimeError(f"Unsupported Obsidian storage backend: {backend}")


def _list_prefix(settings: Settings) -> str:
    prefix = _clean_key_part(getattr(settings, "obsidian_remote_prefix", ""))
    return f"{prefix}/" if prefix else ""


def _relative_from_key(key: str, prefix: str) -> str:
    normalized = clean_unicode(str(key or "")).replace("\\", "/").lstrip("/")
    root = prefix.strip("/")
    if root and normalized.startswith(root + "/"):
        return normalized[len(root) + 1 :].strip("/")
    if root and normalized == root:
        return ""
    return normalized.strip("/")


def _safe_local_target(root: Path, rel_path: str) -> Path:
    parts = [part for part in PurePosixPath(rel_path).parts if part not in {"", "."}]
    target = root.joinpath(*parts).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise RuntimeError("Remote Obsidian key resolves outside the local mirror") from exc
    return target


def sync_remote_obsidian_to_mirror(settings: Settings) -> tuple[Settings, dict[str, int]]:
    if not obsidian_remote_configured(settings):
        return settings, {
            "remote_enabled": 1 if obsidian_remote_enabled(settings) else 0,
            "remote_configured": 0,
            "remote_objects_seen": 0,
            "remote_markdown_downloaded": 0,
            "remote_objects_skipped": 0,
        }

    mirror = obsidian_remote_mirror_path(settings).resolve()
    mirror.mkdir(parents=True, exist_ok=True)
    client = _client(settings)
    prefix = _list_prefix(settings)
    seen = 0
    downloaded = 0
    skipped = 0
    for key in client.list_keys(prefix):
        seen += 1
        rel = _relative_from_key(key, prefix)
        if not rel or not rel.lower().endswith(".md"):
            skipped += 1
            continue
        try:
            target = _safe_local_target(mirror, rel)
        except RuntimeError:
            skipped += 1
            continue
        client.download_to_file(key, target)
        downloaded += 1

    effective_settings = replace(settings, obsidian_vault_path=mirror)
    return effective_settings, {
        "remote_enabled": 1,
        "remote_configured": 1,
        "remote_objects_seen": seen,
        "remote_markdown_downloaded": downloaded,
        "remote_objects_skipped": skipped,
    }


def _candidate_append_only_paths(rel_path: str) -> list[str]:
    rel = _clean_key_part(rel_path)
    path = PurePosixPath(rel)
    suffix = path.suffix or ".md"
    stem = path.name[: -len(suffix)] if path.name.endswith(suffix) else path.name
    parent = "" if path.parent.as_posix() == "." else path.parent.as_posix()
    candidates = [rel]
    for index in range(2, 102):
        name = f"{stem}-{index}{suffix}"
        candidates.append(_join_key(parent, name))
    return candidates


def upload_markdown_append_only(settings: Settings, source: Path, relative_path: str) -> dict[str, object]:
    if not obsidian_remote_configured(settings):
        raise RuntimeError("Remote Obsidian storage is not fully configured")
    rel = _clean_key_part(relative_path)
    if not rel.lower().endswith(".md"):
        rel += ".md"
    output_prefix = obsidian_remote_output_prefix(settings)
    if output_prefix and not (rel == output_prefix or rel.startswith(output_prefix + "/")):
        raise RuntimeError("Remote Obsidian export path must be inside the configured output prefix")

    client = _client(settings)
    root_prefix = _clean_key_part(getattr(settings, "obsidian_remote_prefix", ""))
    for candidate in _candidate_append_only_paths(rel):
        key = _join_key(root_prefix, candidate)
        if client.object_exists(key):
            continue
        client.put_file_append_only(key, source, "text/markdown; charset=utf-8")
        return {"key": key, "path": candidate}
    raise RuntimeError("Unable to find an append-only Obsidian export path")
