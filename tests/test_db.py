from __future__ import annotations

import unittest

from helpers import connect_test_db


class PostgresTestDatabaseTests(unittest.TestCase):
    def test_test_database_helper_uses_postgres_connection(self) -> None:
        conn = connect_test_db()
        try:
            self.assertEqual(conn.dialect, "postgres")
            row = conn.execute("SELECT COUNT(*) AS count FROM job_runs").fetchone()
            self.assertEqual(row["count"], 0)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

