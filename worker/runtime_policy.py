from __future__ import annotations

from typing import Any, Iterable, Mapping

from .job_policy import worker_group_policies


class RuntimePolicyError(RuntimeError):
    pass


RUNTIME_FIELDS = (
    "worker_process_count",
    "global_llm_request_concurrency",
    "global_embedding_request_concurrency",
    "embedding_concurrency",
    "project_judgment_concurrency",
    "project_chat_profile_concurrency",
)
_RUNTIME_BOUNDS = {
    "worker_process_count": (1, 16),
    "global_llm_request_concurrency": (1, 64),
    "global_embedding_request_concurrency": (1, 64),
    "embedding_concurrency": (1, 32),
    "project_judgment_concurrency": (1, 8),
    "project_chat_profile_concurrency": (1, 8),
}


def _as_dict(row: Any) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    return {key: row[key] for key in row.keys()}


def merge_runtime_policy(runtime_row: Any, override_rows: Iterable[Any]) -> dict[str, Any]:
    if runtime_row is None:
        raise RuntimePolicyError("worker runtime policy singleton is missing")
    runtime = _as_dict(runtime_row)
    try:
        revision = int(runtime["revision"])
        if revision < 1:
            raise ValueError
        values = {field: int(runtime[field]) for field in RUNTIME_FIELDS}
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimePolicyError("worker runtime policy row is invalid") from exc
    if any(not lower <= values[field] <= upper for field, (lower, upper) in _RUNTIME_BOUNDS.items()):
        raise RuntimePolicyError("worker runtime policy row is invalid")
    if (
        values["embedding_concurrency"] > values["global_embedding_request_concurrency"]
        or values["project_judgment_concurrency"] > values["global_llm_request_concurrency"]
        or values["project_chat_profile_concurrency"] > values["global_llm_request_concurrency"]
    ):
        raise RuntimePolicyError("worker runtime policy row is invalid")

    groups = {
        name: {
            **policy,
            "max_running": policy["default_max_running"],
            "source": policy["limit_mode"] if policy["limit_mode"] != "capacity" else "default",
            "editable": policy["limit_mode"] == "capacity",
        }
        for name, policy in worker_group_policies().items()
    }
    seen: set[str] = set()
    for raw in override_rows:
        row = _as_dict(raw)
        group = str(row.get("concurrency_group") or "")
        if group in seen:
            raise RuntimePolicyError(f"duplicate worker group override: {group}")
        seen.add(group)
        if group not in groups:
            raise RuntimePolicyError(f"unknown worker group override: {group or '<empty>'}")
        if groups[group]["limit_mode"] != "capacity":
            raise RuntimePolicyError(f"worker group {group} does not allow overrides")
        try:
            row_revision = int(row["policy_revision"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimePolicyError(f"invalid worker group override revision: {group}") from exc
        if row_revision != revision:
            raise RuntimePolicyError(f"worker group override revision mismatch: {group}")
        limit = row.get("max_running")
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 1):
            raise RuntimePolicyError(f"invalid worker group override limit: {group}")
        groups[group]["max_running"] = limit
        groups[group]["source"] = "override"

    return {"revision": revision, **values, "groups": groups}


def load_runtime_policy(conn: Any) -> dict[str, Any]:
    try:
        rows = conn.execute(
            """SELECT policy.*, override_row.concurrency_group,
                      override_row.max_running, override_row.policy_revision
               FROM worker_runtime_policy policy
               LEFT JOIN worker_group_limit_overrides override_row ON TRUE
               WHERE policy.singleton_id = 1
               ORDER BY override_row.concurrency_group"""
        ).fetchall()
        if not rows:
            return merge_runtime_policy(None, [])
        overrides = [row for row in rows if row["concurrency_group"] is not None]
        return merge_runtime_policy(rows[0], overrides)
    except RuntimePolicyError:
        raise
    except Exception as exc:
        raise RuntimePolicyError("worker runtime policy is unavailable") from exc


def effective_group_limit(snapshot: Mapping[str, Any], group: str) -> int | None:
    policy = (snapshot.get("groups") or {}).get(str(group or ""))
    if not isinstance(policy, Mapping):
        raise RuntimePolicyError(f"worker job references unknown concurrency group: {group or '<empty>'}")
    value = policy.get("max_running")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise RuntimePolicyError(f"worker group has invalid effective limit: {group}")
    return value
