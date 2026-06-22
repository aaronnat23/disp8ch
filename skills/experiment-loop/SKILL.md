# Experiment Loop (Metric-Driven Optimization)

Autonomous benchmark-driven experiment loop: propose a change, measure the metric, keep what improves it, revert what doesn't, repeat. Git is the ledger — every kept improvement is a commit. Every discarded attempt is a clean revert.

## Setup

Before iterating, call `init_experiment` to configure the session:
- `metric_name`: the scalar to optimize (e.g. `test_duration_ms`, `accuracy_pct`, `bundle_size_kb`)
- `metric_direction`: `"minimize"` or `"maximize"`
- `objective`: plain-English goal (e.g. "Reduce test suite wall-clock time below 10s")
- `benchmark_command`: shell command that must print `METRIC <name>=<number>` to stdout
- `checks_command` (optional): correctness guard (e.g. `npm test` or `python -m pytest`) — a failed check blocks a keep even if the metric improved (Goodhart's Law prevention)

## Loop

1. **Propose**: read `autoresearch.ideas.md` for queued ideas; pick the most promising and describe the change
2. **Implement**: make the code change using `write_file` or `bash_exec`
3. **Measure**: call `run_experiment` with a description of what was tried
4. **Decide**: call `log_experiment` with:
   - `decision="keep"` if metric improved AND checks passed → git commit
   - `decision="discard"` if metric regressed or was flat → git revert
   - `decision="checks_failed"` if metric improved but correctness check failed → revert
   - `decision="crash"` if the benchmark itself crashed → revert
5. **Record ideas**: append promising-but-deferred ideas to `autoresearch.ideas.md`
6. **Repeat**

## Benchmark Contract

The benchmark command MUST print at least one `METRIC name=number` line to stdout:
```
METRIC test_duration_ms=4231
METRIC memory_mb=128
```
Secondary metrics are captured automatically. The primary metric is whatever `metric_name` was set to in `init_experiment`.

## Segment-Aware Baselines

Call `init_experiment` again mid-session to start a new baseline segment — useful when pivoting to a different optimization goal. Old results are preserved in `autoresearch.jsonl` with their original segment index.

## Auto-Resume

When context resets, re-read `autoresearch.md` (current state) and `autoresearch.ideas.md` (deferred ideas) to resume exactly where you left off. Never lose progress.

## Files

| File | Purpose |
|------|---------|
| `autoresearch.jsonl` | Append-only JSONL run log (one entry per experiment) |
| `autoresearch.md` | Living session doc: objective, metric, attempt history |
| `autoresearch.ideas.md` | Backlog of promising-but-deferred ideas |

## Integration with Research Pipeline

Combine with the Autonomous Researcher skill:
1. Use Autonomous Researcher to identify the problem, review literature, and form a hypothesis
2. Use Experiment Loop to validate the hypothesis empirically (implement → measure → keep/discard)
3. Use council to evaluate competing hypothesis directions before committing to a loop direction

## Example

```json
{ "tool": "init_experiment", "metric_name": "test_duration_ms", "metric_unit": "ms", "metric_direction": "minimize", "objective": "Cut test suite time below 8000ms", "benchmark_command": "npm test 2>&1 | tail -1 | awk '{print \"METRIC test_duration_ms=\" $NF}'" }
{ "tool": "run_experiment", "description": "Parallelize independent test suites with --runInBand=false" }
{ "tool": "log_experiment", "decision": "keep", "metric_value": 5400, "description": "Parallelize independent test suites" }
```
