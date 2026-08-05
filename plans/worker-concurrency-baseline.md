# Worker concurrency baseline (2026-08-05)

## Environment and reproducibility

- Windows host, PostgreSQL 17 at `localhost:5432`, isolated schema per test.
- Python 3.11.11 and two real `python -m worker.service` processes.
- Worker timestamps use millisecond precision. RSS uses Win32 `GetProcessMemoryInfo` (Working Set); Linux fallback reads `/proc/<pid>/statm`.
- PostgreSQL cost is sampled from `pg_stat_activity` using a per-run `PGAPPNAME`. Counts include worker runtime/heartbeat connections, not the test controller.
- The controlled daily occupies the real handler after `worker_jobs.status=running` is committed. A temporary `job_runs.meta_json` trigger takes a known advisory marker lock, delays only the first daily metadata update for 3.0 seconds, then raises a controlled error so no external arXiv/provider request enters the sample. The trigger and function are removed in `finally`.

Commands:

```powershell
# Set TEST_DATABASE_URL to an isolated PostgreSQL test database using the normal secret source.
python -m unittest discover -s tests -p 'test_worker_concurrency_postgres.py' -v
python -m unittest discover -s tests -p 'test_compute_service_postgres.py' -v
python -m unittest discover -s tests -p 'test_resource_limiter.py' -v
node --test tests/node/workerQueue.postgres.test.js
```

The raw machine-readable lines are emitted as `STAGE6_BENCHMARK ...` and `STAGE6_DEEP_SEARCH ...` by those tests.

## One worker versus two workers

The three manual jobs submitted while daily was running were Reader URL import, paper report, and artifact index. They use controlled invalid/missing entities so the sample isolates queue/dispatch cost rather than internet latency.

| Metric | 1 worker | 2 workers |
| --- | ---: | ---: |
| Reader import queue wait | 2090 ms | 66 ms |
| Paper report queue wait | 2416 ms | 290 ms |
| Artifact index queue wait | 2653 ms | 520 ms |
| Queue wait p50 | 2416 ms | 290 ms |
| Queue wait p95 (max of n=3) | 2653 ms | 520 ms |
| Handler duration p50 | 50 ms | 53 ms |
| Handler duration p95 (max of n=3) | 60 ms | 56 ms |
| Worker idle RSS, per process | 52.5 MiB | 52.4, 52.6 MiB |
| Worker running RSS, per process | 52.8 MiB | 52.6, 52.9 MiB |
| Idle RSS aggregate | 52.5 MiB | 105.0 MiB |
| Running RSS aggregate | 52.8 MiB | 105.5 MiB |
| PostgreSQL connections while services idle | 0 | 0 |
| PostgreSQL connections while daily handler blocked | 1 | 1 |
| Peak named worker connections during daily + manual interval | 1 | 1 |
| Retried manual jobs | 0 | 0 |

The measured manual p50 fell by 88% and p95 by 80%. The second worker added about 53 MiB Working Set; the two-worker aggregate remained below the explicit 128 MiB benchmark budget. Workers open PostgreSQL connections on demand, so both replica counts retained zero connections in the idle sample. A 1 ms sampler saw one named worker connection in both the daily-only and daily-plus-manual windows; the fast manual handlers did not keep the second connection open long enough to increase that sampled peak. The separate simultaneous-claim test opens two independent worker connections, so deployments conservatively budget one active job connection per replica plus short heartbeat/resource-slot connections and Node/compute pools.

## Deep-search latency while daily is represented as running

`tests/test_compute_service_postgres.py::test_deep_search_starts_while_daily_is_running_without_creating_job_records` proves that deep search starts with a persisted running daily and creates no worker/job-run rows. That same test sends a real HTTP request through the compute service and real `deep_search` algorithm against the isolated minimal PostgreSQL corpus; only the embedding/index boundary is controlled for determinism:

| Metric | Sample |
| --- | ---: |
| First response byte | 35.7 ms |
| Complete JSON response | 36.1 ms |

Deep search is a non-streaming JSON endpoint, so TTFB and total are intentionally close. This is a reproducible real-path minimal-corpus sample with controlled embedding, not a live-provider/full-corpus latency claim.

## LLM and embedding outbound concurrency

The controlled HTTP provider accepts at most two simultaneous requests and would return 429 above that boundary. Eight concurrent callers were issued separately through the real lowest-level `call_chat_json` and `embed_text` HTTP paths with global limit 2.

| Boundary | Requests | Configured global limit | Peak observed | HTTP 429 | 429 ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| LLM chat | 8 | 2 | 2 | 0 | 0% |
| Embedding | 8 | 2 | 2 | 0 | 0% |

The PostgreSQL limiter test separately runs six callers at limit 2 and observes peak 2, then kills a process holding the only LLM slot and reacquires it in under two seconds. A paid/live provider was not called because no benchmark credential or spend authorization was supplied; live-provider peak/429 is therefore N/A. The controlled local provider is the acceptance measurement for limiter correctness, while production provider telemetry remains the deployment sizing input.

## Duplicate, deduplicated, retry, and recovery samples

- Concurrent Node `Promise.all` and independent Python PostgreSQL connections enqueue the same Reader canonical URL set in different order: created `1`, deduplicated `1`, duplicate active rows `0`, `task.started` events `1`.
- Two real worker services execute five independent jobs: duplicate executions `0`, every job `attempts=1`.
- Daily/manual benchmark: retried manual jobs `0` in both replica runs.
- The broader PostgreSQL matrix covers group/key mutexes, daily+Reader parallelism, same/different artifact and paper keys, Obsidian serialization, aging, and a runnable job behind 120 blocked candidates.
- Crash recovery blocks a real Reader import provider after worker A has committed `running`, kills A, advances stale recovery, verifies a stale queued outbox event, and lets worker B complete at `attempts=2`; no permanent running row or duplicate terminal event remains. A separate child-process test proves PostgreSQL releases an advisory request slot after kill. Node recovery starts server A, enqueues through its API, blocks a real Reader import provider while the job is running, kills A, completes the worker job while A is offline, then starts B. B's real SSE stream receives the outbox completion exactly once across three poll intervals and `published_at` is persisted.

This baseline supports the Stage 6 default of one replica and the documented opt-in `docker compose up -d --scale worker=2`. The policy, key mutexes, and global request limits remain enabled at either replica count.
