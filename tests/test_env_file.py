from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.db import database_url_from_env
from worker.env import env_value
from worker.config import _providers_from_env


class EnvFileTests(unittest.TestCase):
    def test_env_value_prefers_file_over_environment_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            secret_path = Path(tmp) / "secret.txt"
            secret_path.write_text("from-file\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "TEST_SECRET": "from-env",
                    "TEST_SECRET_FILE": str(secret_path),
                },
                clear=True,
            ):
                self.assertEqual(env_value("TEST_SECRET"), "from-file")

    def test_database_url_can_be_constructed_from_postgres_password_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            secret_path = Path(tmp) / "postgres-password.txt"
            secret_path.write_text("p@ss word\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "DATABASE_URL": "",
                    "POSTGRES_HOST": "db",
                    "POSTGRES_PORT": "5432",
                    "POSTGRES_DB": "research_intelligence",
                    "POSTGRES_USER": "research_app",
                    "POSTGRES_PASSWORD_FILE": str(secret_path),
                },
                clear=True,
            ):
                self.assertEqual(
                    database_url_from_env(),
                    "postgresql://research_app:p%40ss%20word@db:5432/research_intelligence",
                )

    def test_provider_env_rejects_multiple_openrouter_instances(self) -> None:
        providers = [
            {"id": "openrouter", "provider_type": "openrouter"},
            {"id": "openrouter-backup", "provider_type": "openrouter"},
        ]
        with patch.dict(os.environ, {"LLM_PROVIDERS_JSON": json.dumps(providers)}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "only one OpenRouter provider"):
                _providers_from_env()


if __name__ == "__main__":
    unittest.main()
