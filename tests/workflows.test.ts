import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { findRepoRoot, loadCurriculum, loadSlop, loadThresholds } from "../harness/config.js";
import {
  BUILD_ATTEMPTS,
  guardViolations,
  hasUsageTelemetry,
  pathAllowed,
  scopedAllowedTools,
  snapshotDir,
  snapshotWorkspace,
  STAGES,
  stepRenderBuild,
  symlinksIn,
  usageFromResult,
} from "../harness/dry-run.js";
import { buildMonthlyShowcase, previousMonth, selectShowcase } from "../harness/monthly-showcase.js";
import { applyRetro, lintSnippet, probeCorpus, probeStaticRule, redosRisk, renderRetroPrompt } from "../harness/retro-apply.js";
import type { LedgerEntry } from "../harness/types.js";

const ROOT = findRepoRoot();
const GH = join(ROOT, ".github");
const tmp = mkdtempSync(join(tmpdir(), "workflows-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function ghFiles(dir = GH): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? ghFiles(join(dir, d.name)) : /\.ya?ml$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}
const FILES = ghFiles();
type Step = Record<string, unknown> & { uses?: string; run?: string; with?: Record<string, string>; if?: string; env?: Record<string, string>; name?: string; id?: string };
type Job = { permissions?: Record<string, string>; steps: Step[]; "timeout-minutes"?: number; if?: string };
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};
const wf = (name: string): Workflow => parse(readFileSync(join(GH, "workflows", name), "utf8")) as Workflow;
const action = parse(readFileSync(join(GH, "actions", "agent", "action.yml"), "utf8")) as { outputs: Record<string, { value: string }>; runs: { steps: Step[] } };
const actionStep = (id: string): Step => action.runs.steps.find((s) => s.id === id)!;
const stepIndex = (steps: Step[], name: RegExp): number => steps.findIndex((s) => name.test(String(s.name ?? "")));
const allSteps = (): Array<{ file: string; step: Step }> => [
  ...["nightly.yml", "weekly.yml", "monthly.yml", "ci.yml"].flatMap((f) => Object.values(wf(f).jobs).flatMap((j) => j.steps.map((step) => ({ file: f, step })))),
  ...action.runs.steps.map((step) => ({ file: "action.yml", step })),
];

describe(".github", () => {
  test("has the four workflows and the composite action, all valid YAML", () => {
    expect(FILES.map((f) => f.slice(GH.length + 1)).sort()).toEqual(
      ["actions/agent/action.yml", "workflows/ci.yml", "workflows/monthly.yml", "workflows/nightly.yml", "workflows/weekly.yml"],
    );
    for (const f of FILES) expect(() => parse(readFileSync(f, "utf8")), f).not.toThrow();
  });

  test("every uses: is local or pinned to a full commit SHA", () => {
    const uses = allSteps().map((s) => s.step.uses).filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(20);
    for (const u of uses) expect(u, u).toMatch(/^(\.\/|[\w.-]+\/[\w./-]+@[0-9a-f]{40}$)/);
  });

  test("no other model vendor or tier, no token echo, no eval", () => {
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/sonnet|gemini|openai|gpt-/i);
      expect(text, f).not.toMatch(/\beval\b/);
      for (const line of text.split("\n").filter((l) => /CLAUDE_CODE_OAUTH_TOKEN|claude_code_oauth_token/.test(l))) {
        expect(line, f).not.toMatch(/\b(echo|printf|cat|tee)\b/);
        expect(line.trim(), f).toMatch(/^(claude_code_oauth_token:|# |description: |TOKEN_SET: \$\{\{ inputs\.claude_code_oauth_token != '' \}\}$|\[\[ "\$TOKEN_SET")/);
      }
    }
  });

  test("no ${{ }} expression inside any run: script (untrusted values go through env)", () => {
    for (const { file, step } of allSteps()) if (step.run) expect(step.run, `${file}: ${String(step.name)}`).not.toContain("${{");
  });

  test("schedules and workflow_dispatch are active with their configured crons", () => {
    for (const [f, cron] of [["nightly.yml", "17 2 * * *"], ["weekly.yml", "30 3 * * 0"], ["monthly.yml", "0 4 1 * *"]] as const) {
      expect(Object.keys(wf(f).on).sort(), f).toEqual(["schedule", "workflow_dispatch"]);
      expect(wf(f).on.schedule, f).toEqual([{ cron }]);
    }
  });

  test("nightly: read-only by default, publish is the only job that can write, job timeouts as set in M6C", () => {
    const w = wf("nightly.yml");
    expect(w.permissions).toEqual({ contents: "read" });
    expect(Object.keys((w.on.workflow_dispatch as { inputs: object }).inputs).sort()).toEqual(["dry_run", "force_compo", "force_domain", "force_mood_preset"]);
    for (const [name, job] of Object.entries(w.jobs)) {
      if (name === "publish") expect(job.permissions).toEqual({ contents: "write", pages: "write", "id-token": "write" });
      else expect(job.permissions, name).toBeUndefined();
    }
    expect(Object.keys(w.jobs)).toEqual(["plan", "research", "feel", "brief", "build_and_judge", "publish"]);
    expect(w.jobs.publish!.if).toBe("always() && needs.plan.result == 'success'");
    // SPEC Section 5: 79 minutes worst-case, 45 for build_and_judge (DECISIONS.md, M6C). Pinned, so a change is deliberate.
    expect(Object.fromEntries(Object.entries(w.jobs).map(([k, j]) => [k, j["timeout-minutes"]]))).toEqual({
      plan: 2,
      research: 6,
      feel: 3,
      brief: 8,
      build_and_judge: 45,
      publish: 15,
    });
  });

  test("weekly: only the apply job writes; monthly and ci call no LLM", () => {
    const w = wf("weekly.yml");
    expect(w.permissions).toEqual({ contents: "read" });
    expect(w.jobs.retro!.permissions).toBeUndefined();
    expect(w.jobs.apply!.permissions).toEqual({ contents: "write" });
    expect(w.jobs.apply!.steps.some((s) => s.uses?.includes("agent") || s.uses?.includes("claude"))).toBe(false);
    for (const f of ["monthly.yml", "ci.yml"]) {
      const text = readFileSync(join(GH, "workflows", f), "utf8");
      expect(text, f).not.toMatch(/actions\/agent|claude-code-action|CLAUDE_CODE_OAUTH_TOKEN/);
    }
  });

  test("agent steps match the stage table in harness/dry-run.ts", () => {
    let count = 0;
    for (const { file, step } of allSteps()) {
      if (step.uses !== "./.github/actions/agent") continue;
      count++;
      const w = step.with!;
      const stage = STAGES[w.stage as keyof typeof STAGES];
      expect(stage, `${file}: ${w.stage}`).toBeDefined();
      let model: string = stage.model;
      let effort: string | null = stage.effort;
      if (w.stage === "build") ({ model, effort } = BUILD_ATTEMPTS[Number(w.attempt) - 1]!);
      expect([w.model, w.effort ?? null, Number(w.max_turns), w.tools], `${file}: ${String(step.name)}`).toEqual([model, effort, stage.maxTurns, stage.tools]);
      expect(w.claude_code_oauth_token).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
      expect(step["timeout-minutes"], String(step.name)).toBeGreaterThan(0);
    }
    expect(count).toBe(2 + 1 + 3 + 3 * 5 + 1); // research, appraise, brief, 3 x (build + 4 jury), retro
  });

  test("every agent step tolerates its timeout and is followed by a guard re-check on the same snapshot", () => {
    for (const f of ["nightly.yml", "weekly.yml"]) {
      for (const job of Object.values(wf(f).jobs)) {
        job.steps.forEach((step, i) => {
          if (step.uses !== "./.github/actions/agent") return;
          const w = step.with!;
          const guard = job.steps[i + 1]!;
          expect(step["continue-on-error"], `${f}: ${String(step.name)}`).toBe(true);
          expect(guard.if).toBe(`always() && steps.${String(step.id)}.outcome == 'failure'`);
          expect(guard.run).toBe('bash "$RUNNER_TEMP/agent-guard.sh" check "$GUARD_FILE" "$ALLOWED"');
          const env = guard.env as Record<string, string>;
          expect(env.GUARD_FILE).toBe(`\${{ runner.temp }}/guard-${w.stage}-${w.attempt ?? 1}.snap`);
          expect(env.ALLOWED).toBe(w.allowed_write_paths);
        });
      }
    }
    const check = actionStep("args").run!;
    expect(check).toContain('guard_file=$RUNNER_TEMP/guard-$STAGE-$ATTEMPT.snap');
  });

  test("actionlint passes with no findings", () => {
    const bin = ["/opt/homebrew/bin/actionlint", "/usr/local/bin/actionlint"].find((b) => existsSync(b)) ?? "actionlint";
    const r = spawnSync(bin, [], { cwd: ROOT, encoding: "utf8" });
    if (r.error) {
      console.warn("actionlint not installed; skipped (ci.yml runs it)");
      return;
    }
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("M6B hardening (6R and Codex consultation #3)", () => {
  const guardScript = (): string => {
    const run = action.runs.steps.find((s) => s.name === "Snapshot workspace")!.run!;
    const body = run.slice(run.indexOf("<<'GUARD_EOF'\n") + "<<'GUARD_EOF'\n".length, run.indexOf("\nGUARD_EOF"));
    const f = join(tmp, "agent-guard.sh");
    writeFileSync(f, `${body}\n`);
    return f;
  };
  const sh = (cwd: string, ...args: string[]) => spawnSync("bash", args, { cwd, encoding: "utf8" });

  test("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is on for nightly, weekly and the claude-code-action step", () => {
    expect(wf("nightly.yml").env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(wf("weekly.yml").env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(actionStep("claude").env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });

  test("the action exposes outcome and conclusion separately and logs usage only after a passing guard", () => {
    expect(action.outputs.outcome!.value).toBe("${{ steps.claude.outcome }}");
    expect(action.outputs.conclusion!.value).toBe("${{ steps.claude.outputs.conclusion }}");
    const logStep = action.runs.steps.find((s) => s.name === "Log usage")!;
    expect(logStep.if).toBe("always() && steps.guard.outcome == 'success'");
    expect(readFileSync(join(ROOT, "harness", "dry-run.ts"), "utf8")).toContain("if (!hasUsageTelemetry(raw))");
  });

  test("the workspace guard is pure Bash: no tsx or node before or in the guard, git hooks and fsmonitor off", () => {
    const steps = action.runs.steps;
    const guardAt = steps.findIndex((s) => s.id === "guard");
    for (const s of steps.slice(0, guardAt + 1)) if (s.run) expect(s.run, String(s.name)).not.toMatch(/\btsx\b|\bnode\b/);
    const script = readFileSync(guardScript(), "utf8");
    expect(script).toContain("git -c core.fsmonitor= -c core.hooksPath=/dev/null");
    expect(script).toContain("--untracked-files=all");
    expect(script).toContain("sha256sum");
    expect(script).toContain("for f in package.json package-lock.json harness config schemas .github .git/hooks; do");
    expect(script).toContain("git config --file .git/config --list");
    expect(steps.find((s) => s.id === "guard")!.run).toBe('bash "$RUNNER_TEMP/agent-guard.sh" check "$GUARD_FILE" "$ALLOWED"');
    for (const f of ["nightly.yml", "weekly.yml"]) expect(readFileSync(join(GH, "workflows", f), "utf8"), f).not.toContain("dry-run.ts guard");
  });

  test("the Bash guard passes allowed writes, catches outside, protected and symlinked changes, and marks a pass", () => {
    const script = guardScript();
    const repo = join(tmp, "bash-guard");
    mkdirSync(join(repo, "harness"), { recursive: true });
    mkdirSync(join(repo, "audit", "n", "piece"), { recursive: true });
    const git = (...a: string[]): void => void spawnSync("git", a, { cwd: repo });
    git("init", "-q");
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "harness", "x.ts"), "a");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const snap = join(tmp, "guard-build-1.snap");
    const ok = join(tmp, "guard-build-1.ok");
    const allowed = "audit/n/piece/index.html,audit/n/selfgate/";
    const check = () => sh(repo, script, "check", snap, allowed);
    expect(sh(repo, script, "snapshot", snap).status).toBe(0);
    writeFileSync(join(repo, "audit", "n", "piece", "index.html"), "<!doctype html>");
    mkdirSync(join(repo, "audit", "n", "selfgate"));
    writeFileSync(join(repo, "audit", "n", "selfgate", "gates.json"), "{}");
    expect(check().stdout).toContain("workspace guard: ok");
    expect(existsSync(ok)).toBe(true);

    sh(repo, script, "snapshot", snap);
    expect(existsSync(ok)).toBe(false);
    writeFileSync(join(repo, "audit", "n", "piece", "other.html"), "x");
    let r = check();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("audit/n/piece/other.html");
    expect(existsSync(ok)).toBe(false);
    rmSync(join(repo, "audit", "n", "piece", "other.html"));

    // What claude-code-action itself writes in agent mode passes; any other key does not.
    git("config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic x");
    git("remote", "add", "origin", "https://github.com/o/r.git");
    sh(repo, script, "snapshot", snap);
    git("config", "user.name", "claude[bot]");
    git("config", "user.email", "1+claude[bot]@users.noreply.github.com");
    git("config", "--unset-all", "http.https://github.com/.extraheader");
    git("remote", "set-url", "origin", "https://x-access-token:t@github.com/o/r.git");
    git("config", "credential.https://github.com.helper", "!/tmp/helper");
    expect(check().stdout).toContain("workspace guard: ok");

    sh(repo, script, "snapshot", snap);
    writeFileSync(join(repo, ".git", "config"), `${readFileSync(join(repo, ".git", "config"), "utf8")}[core]\n\tfsmonitor = evil\n`);
    r = check();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(".git/config");

    sh(repo, script, "snapshot", snap);
    symlinkSync("/etc/hosts", join(repo, "audit", "n", "selfgate", "leak.txt"));
    r = check();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("audit/n/selfgate/leak.txt (symlink)");
  });

  test("the action scopes Write and Edit to allowed_write_paths with Edit(//abs) rules and rejects Write(path) rules", () => {
    const run = actionStep("args").run!;
    const ws = join(tmp, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "prompt.md"), "hi");
    const args = (tools: string, allowed: string) => {
      const out = join(tmp, `gh-output-${Math.random().toString(36).slice(2)}`);
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-c", run], {
        cwd: ws,
        encoding: "utf8",
        env: { ...process.env, STAGE: "build", MODEL: "haiku", EFFORT: "", MAX_TURNS: "30", TOOLS: tools, ALLOWED: allowed, PROMPT_FILE: "prompt.md", ATTEMPT: "1", TOKEN_SET: "true", GITHUB_OUTPUT: out, RUNNER_TEMP: tmp },
      });
      return { status: r.status, out: r.stdout + readFileSync(out, "utf8") };
    };
    const real = spawnSync("pwd", ["-P"], { cwd: ws, encoding: "utf8" }).stdout.trim();
    const r = args("Read,Write,Edit,Bash(npm run gate:*)", "audit/n/piece/index.html,audit/n/selfgate/");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`--tools "Read,Write,Edit,Bash" --allowedTools "Read,Bash(npm run gate:*),Edit(/${real}/audit/n/piece/index.html),Edit(/${real}/audit/n/selfgate/**)"`);
    expect(args("WebSearch,WebFetch,Write", "audit/n/dossier.json").out).toContain(`--allowedTools "WebSearch,WebFetch,Edit(/${real}/audit/n/dossier.json)"`);
    expect(args("Read,Write(./x)", "audit/n/dossier.json").status).toBe(1);
    expect(args("Read,Write", "../escape.json").status).toBe(1);
    expect(args("Read,Write", "/etc/passwd").status).toBe(1);
    expect(scopedAllowedTools("Read,Write,Edit,Bash(npm run gate:*)", ["/n/piece/index.html", "/n/selfgate/"])).toBe(
      "Read,Bash(npm run gate:*),Edit(//n/piece/index.html),Edit(//n/selfgate/**)",
    );
    expect(scopedAllowedTools("WebSearch,WebFetch", ["/n/x.json"])).toBe("WebSearch,WebFetch");
    expect(() => scopedAllowedTools("Write", ["relative/x.json"])).toThrow(/absolute/);
  });

  test("every agent job rejects symlinks and writes its guard-passed marker before upload", () => {
    const w = wf("nightly.yml");
    for (const [job, marker] of [["research", "research"], ["feel", "feel"], ["brief", "brief"], ["build_and_judge", "build_and_judge"]] as const) {
      const steps = w.jobs[job]!.steps;
      const up = stepIndex(steps, /^Upload night/);
      const links = stepIndex(steps, /^Reject symlinks/);
      const mark = stepIndex(steps, /^Guard-passed marker/);
      expect(links, job).toBeGreaterThan(0);
      expect([links < mark, mark < up], job).toEqual([true, true]);
      expect(steps[links]!.run).toContain('find "$NIGHT" -type l -print -delete');
      expect(steps[mark]!.if, job).toBeUndefined();
      expect(steps[mark]!.run).toContain('[ -f "${snap%.snap}.ok" ]');
      expect(steps[mark]!.run).toContain(`"$NIGHT/guard-passed-${marker}"`);
    }
  });

  test("publish downloads only artifacts of jobs that succeeded and shelves on the first failed job", () => {
    const steps = wf("nightly.yml").jobs.publish!.steps;
    const dl = (n: string) => steps.find((s) => s.name === `Download night (${n})`)!;
    expect(dl("plan").if).toBeUndefined();
    expect(dl("research").if).toBe("needs.research.result == 'success'");
    expect(dl("feel").if).toBe("needs.research.result == 'success' && needs.feel.result == 'success'");
    expect(dl("brief").if).toBe("needs.research.result == 'success' && needs.feel.result == 'success' && needs.brief.result == 'success'");
    expect(dl("build").if).toBe(
      "needs.research.result == 'success' && needs.feel.result == 'success' && needs.brief.result == 'success' && needs.build_and_judge.result == 'success'",
    );
    for (const n of ["plan", "research", "feel", "brief", "build"]) expect(dl(n)["continue-on-error"], n).toBeUndefined();
    const jobs = steps.find((s) => s.id === "jobs")!;
    expect(jobs.run).toContain('[ ! -f "$NIGHT/guard-passed-$job" ]');
    expect(jobs.run).toContain("step halt");
    const pub = steps.find((s) => s.name === "Stage 9: publish")!;
    expect(pub.env?.STATE_OK).toBe("${{ steps.jobs.outputs.state_ok }}");
    expect(pub.run).toContain('if [ "$STATE_OK" = "true" ] && [ -f "$NIGHT/state/emotion.json" ]; then cp');
  });

  test("each build attempt starts with no candidate piece (workflow and dry-run.ts)", () => {
    const steps = wf("nightly.yml").jobs.build_and_judge!.steps;
    for (const n of [1, 2, 3]) {
      const render = steps.find((s) => s.id === `renderbuild${n}`)!;
      expect(render.run!.indexOf('rm -f "$NIGHT/piece/index.html"'), String(n)).toBeGreaterThanOrEqual(0);
      expect(render.run!.indexOf('rm -f "$NIGHT/piece/index.html"')).toBeLessThan(render.run!.indexOf("render-build"));
      const build = steps.find((s) => s.id === `build${n}`)!;
      expect(build.with!.allowed_write_paths).toBe("${{ env.NIGHT }}/piece/index.html,${{ env.NIGHT }}/selfgate/");
    }
    const night = join(tmp, "night-render-build");
    const src = join(ROOT, "audit", "five-moods");
    mkdirSync(join(night, "piece"), { recursive: true });
    for (const f of ["plan.json", "brief.json", "mood.json"]) copyFileSync(join(src, "curious-experimental", f), join(night, f));
    copyFileSync(join(src, "dossier.json"), join(night, "dossier.json"));
    writeFileSync(join(night, "piece", "index.html"), "<!doctype html><p>attempt 1</p>");
    const out = stepRenderBuild({ night, ledger: join(ROOT, "ledger", "ledger.jsonl") }, 2);
    expect(existsSync(join(night, "piece", "index.html"))).toBe(false);
    expect(existsSync(out.prompt_file!)).toBe(true);
  });

  test("attempts 2 and 3 start only when their worst case fits the build_and_judge timeout", () => {
    const job = wf("nightly.yml").jobs.build_and_judge! as Job & { env: Record<string, string> };
    expect(job.env.LAST_ATTEMPT_START_S).toBe("1560");
    expect(job.steps[0]!.run).toContain("JOB_START=$(date +%s)");
    const t = (id: string) => job.steps.find((s) => s.id === id)!["timeout-minutes"] as number;
    // worst case of one attempt (build + gates + 4 jury calls) + 1 minute upload + the start limit = the job timeout (SPEC Section 5)
    expect(Math.max(t("build1"), t("build2"), t("build3")) + t("gate1") + 4 * t("jury1s1") + 1 + 1560 / 60).toBe(45);
    for (const n of [1, 2]) expect(job.steps.find((s) => s.id === `decide${n}`)!.run).toContain("JOB_START > LAST_ATTEMPT_START_S");
  });

  test("nightly and monthly push to the branch before Pages deploys, with rebase retries", () => {
    for (const [f, job] of [["nightly.yml", "publish"], ["monthly.yml", "showcase"], ["weekly.yml", "apply"]] as const) {
      const steps = wf(f).jobs[job]!.steps;
      const push = stepIndex(steps, /^Commit/);
      expect(steps[push]!.run, f).toContain("for try in 1 2 3 4 5; do");
      expect(steps[push]!.run, f).toContain('git pull --rebase origin "$GITHUB_REF_NAME" && git push origin "HEAD:$GITHUB_REF_NAME"');
      if (f === "weekly.yml") continue;
      const deploy = stepIndex(steps, /^Deploy Pages$/);
      const configure = stepIndex(steps, /^Configure Pages$/);
      expect([push >= 0, push < configure, configure < deploy], f).toEqual([true, true, true]);
    }
  });

  test("weekly and monthly have their own concurrency groups; nightly keeps the SPEC group", () => {
    expect(wf("nightly.yml").concurrency).toEqual({ group: "nightly", "cancel-in-progress": false });
    expect(wf("weekly.yml").concurrency).toEqual({ group: "weekly", "cancel-in-progress": false });
    expect(wf("monthly.yml").concurrency).toEqual({ group: "monthly", "cancel-in-progress": false });
  });

  test("retro regexes with nested quantifiers or overlapping alternatives are rejected; current slop rules pass", () => {
    for (const p of ["([a-z]+)+", "(q+q+)+", "(a|aa)+", "(\\w+\\s?)+$", "(?:a*)*b", "(\\w|\\d)+x"]) expect(redosRisk(p), p).toMatch(/nested quantifier|overlapping alternatives/);
    for (const r of loadSlop(ROOT).static_rules) expect(redosRisk(r.pattern), r.id).toBeNull();
    for (const p of ["hsl\\(\\s*\\(?\\s*t\\s*\\*\\s*360", "(?:foo|bar)+", "[a-z]+\\(", "(ab)+c"]) expect(redosRisk(p), p).toBeNull();
    expect(probeStaticRule("([a-z]+)+$", [])).toMatch(/nested quantifier/);
    // Passes the static screen; the adversarial long runs make it time out in the child process.
    expect(probeStaticRule("(?:\\w\\w?)+@", [], 1500)).toMatch(/timed out/);
  }, 20_000);

  test("usage rows need real telemetry; the local guard snapshots the night folder and flags symlinks", () => {
    expect(hasUsageTelemetry([{ type: "result", usage: { input_tokens: 1 }, total_cost_usd: 0.01 }])).toBe(true);
    expect(hasUsageTelemetry({})).toBe(false);
    expect(hasUsageTelemetry([{ type: "system" }])).toBe(false);
    expect(hasUsageTelemetry({ type: "result", is_error: true })).toBe(false);
    const dir = join(tmp, "night-snap");
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a", "x.json"), "{}");
    const before = snapshotDir(dir);
    writeFileSync(join(dir, "a", "x.json"), "{\"y\":1}");
    writeFileSync(join(dir, "b.json"), "{}");
    symlinkSync("/etc/hosts", join(dir, "a", "l"));
    const after = snapshotDir(dir);
    expect(guardViolations(before, after, ["a/x.json"])).toEqual(["a/l", "b.json"]);
    expect(symlinksIn(after)).toEqual(["a/l"]);
  });
});

describe("workspace guard and usage", () => {
  test("pathAllowed matches exact files and folder prefixes only", () => {
    expect(pathAllowed("audit/d/dossier.json", ["audit/d/dossier.json"])).toBe(true);
    expect(pathAllowed("audit/d/dossier.json.bak", ["audit/d/dossier.json"])).toBe(false);
    expect(pathAllowed("audit/d/piece/index.html", ["audit/d/piece/"])).toBe(true);
    expect(pathAllowed("audit/d/piece2/x", ["audit/d/piece/"])).toBe(false);
    expect(pathAllowed("state/emotion.json", ["", " "])).toBe(false);
  });

  test("snapshot and check catch new, edited and deleted files outside the allow list", () => {
    const repo = join(tmp, "git");
    mkdirSync(repo);
    const git = (...a: string[]): void => void spawnSync("git", a, { cwd: repo });
    git("init", "-q");
    writeFileSync(join(repo, "tracked.txt"), "a");
    writeFileSync(join(repo, "gone.txt"), "a");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(repo, "dirty.txt"), "already dirty");
    const before = snapshotWorkspace(repo);
    mkdirSync(join(repo, "out"));
    writeFileSync(join(repo, "out", "ok.json"), "{}");
    expect(guardViolations(before, snapshotWorkspace(repo), ["out/"])).toEqual([]);
    writeFileSync(join(repo, "tracked.txt"), "b");
    writeFileSync(join(repo, "dirty.txt"), "dirty again");
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "new file.txt"), "x");
    expect(guardViolations(before, snapshotWorkspace(repo), ["out/"])).toEqual(["dirty.txt", "gone.txt", "new file.txt", "tracked.txt"]);
  });

  test("usage comes from the last result message of an execution file, or a CLI JSON result", () => {
    const result = {
      type: "result",
      usage: { input_tokens: 6, output_tokens: 417, cache_read_input_tokens: 112310, cache_creation_input_tokens: 56538 },
      total_cost_usd: 0.0128864,
      duration_ms: 9000,
      num_turns: 2,
    };
    const expected = { input_tokens: 6, output_tokens: 417, cache_read_tokens: 112310, cache_creation_tokens: 56538, cost_usd: 0.0128864, duration_ms: 9000, num_turns: 2 };
    expect(usageFromResult([{ type: "system" }, { type: "assistant", message: {} }, result])).toEqual(expected);
    expect(usageFromResult(result)).toEqual(expected);
    expect(usageFromResult([])).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, duration_ms: 0, num_turns: 0 });
  });
});

function ledgerRow(date: string, status: LedgerEntry["status"], score: number | null, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    date,
    status,
    compo: "64k-webgl",
    domain: "tides",
    topic: null,
    concept: `concept ${date}`,
    techniques: [],
    technique_family: null,
    palette: [],
    phashes: { t2: null, t8: null, t20: null },
    color_histogram: null,
    score,
    attempts: 1,
    mood_pad: null,
    dominant_emotion: null,
    ...extra,
  } as LedgerEntry;
}

describe("retro-apply", () => {
  const goodRetro = () => ({
    week_ending: "2026-11-22",
    nights_reviewed: 7,
    summary: "Four published, two B-sides, one shelved. The crew kept centring a single disc.",
    slop_additions: [
      { id: "centred-disc-opening", pattern_type: "visual", pattern: "A single bright disc centred on a dark ground at t=2 s.", rationale: "2026-11-17 and 2026-11-19." },
      { id: "hsl-rainbow-cycle", pattern_type: "static", pattern: "hsl\\(\\s*\\(?\\s*t\\s*\\*\\s*360", rationale: "Rainbow hue cycling on 3 nights." },
    ],
    curriculum_additions: [
      { id: "integer-hash-scatter", name: "Integer hash scatter", family: "point-process", how_to: "Hash the index.", snippet: "export const hash = (i) => (Math.imul(i, 2654435761) >>> 0) / 4294967296;" },
      { id: "spectral-bands", name: "Spectral bands", family: "optics-light", how_to: "Map wavelength to colour.", snippet: "#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(0.5); }" },
      { id: "ring-buffer-trails", name: "Ring buffer trails", family: "data-form", how_to: "Keep the last N positions.", snippet: "const buf = new Float32Array(256);\nlet head = 0;\nexport function push(x) { buf[head] = x; head = (head + 1) & 255; }" },
    ],
    threshold_recommendation: { previous: 72, median_30d: null, computed: 72, applied: 60 },
    usage_alerts: [],
  });
  const configCopy = (name: string): string => {
    const dir = join(tmp, name);
    cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
    return dir;
  };

  test("the snippet wrapper passes every existing curriculum snippet, and no current static rule hits the corpus", () => {
    const rules = loadSlop(ROOT).static_rules;
    for (const t of loadCurriculum(ROOT)) expect(lintSnippet(t.snippet, rules), t.id).toEqual([]);
    const corpus = probeCorpus(ROOT);
    expect(corpus.some((c) => c.name === "lib/min/webgl2.js")).toBe(true);
    for (const r of rules) expect(probeStaticRule(r.pattern, corpus), r.id).toBeNull();
  });

  test("a valid retro applies, keeps comments, recomputes the threshold and ignores the model's value", () => {
    const dir = configCopy("valid");
    const ledger = ["2026-11-10", "2026-11-12", "2026-11-14", "2026-11-16", "2026-11-18"].map((d) => ledgerRow(d, "published", 88));
    const r = applyRetro({ retro: goodRetro(), configRoot: dir, ledger, usagePath: join(tmp, "no-usage.jsonl") });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toEqual({
      slop_static: ["hsl-rainbow-cycle"],
      slop_visual: ["centred-disc-opening"],
      curriculum: ["integer-hash-scatter", "spectral-bands", "ring-buffer-trails"],
      publish_min: { from: 72, to: 85 },
    });
    expect(r.threshold.model_applied).toBe(60);
    const slop = loadSlop(dir);
    expect(slop.static_rules.at(-1)).toEqual({ id: "hsl-rainbow-cycle", pattern: "hsl\\(\\s*\\(?\\s*t\\s*\\*\\s*360", flags: "i", message: "Rainbow hue cycling on 3 nights." });
    expect(slop.visual_slop.at(-1)!.id).toBe("centred-disc-opening");
    expect(loadCurriculum(dir).length).toBe(loadCurriculum(ROOT).length + 3);
    expect(loadThresholds(dir).publish_min).toBe(85);
    expect(readFileSync(join(dir, "config", "slop.yml"), "utf8")).toContain("# Patterns are single-quoted");
  });

  test("bad regexes, regexes that hit lib/min, duplicate ids and lint-failing snippets are rejected; the rest applies", () => {
    const dir = configCopy("rejects");
    const retro = goodRetro();
    retro.slop_additions = [
      { id: "broken", pattern_type: "static", pattern: "foo(bar", rationale: "x" },
      { id: "hits-lib", pattern_type: "static", pattern: "getContext\\(", rationale: "x" },
      { id: "math-random-render", pattern_type: "static", pattern: "zzzq", rationale: "x" },
      { id: "slow", pattern_type: "static", pattern: "(\\w+\\s?)+\\$\\$\\$", rationale: "x" },
    ];
    retro.curriculum_additions[0]!.snippet = "const r = Math.random();";
    retro.curriculum_additions[1]!.snippet = "fetch('/x');";
    const r = applyRetro({ retro, configRoot: dir, ledger: [], usagePath: join(tmp, "no-usage.jsonl") });
    expect(r.ok).toBe(true);
    const why = Object.fromEntries(r.rejected.map((x) => [x.id, x.reason]));
    expect(why.broken).toMatch(/does not compile/);
    expect(why["hits-lib"]).toMatch(/matches lib\/min\//);
    expect(why["math-random-render"]).toMatch(/already used/);
    expect(why.slow).toMatch(/nested quantifier|timed out|matches/);
    expect(why["integer-hash-scatter"]).toMatch(/math-random-render/);
    expect(why["spectral-bands"]).toMatch(/security\/fetch|network/);
    expect(r.applied.curriculum).toEqual(["ring-buffer-trails"]);
    expect(r.applied.slop_static).toEqual([]);
    expect(loadSlop(dir).static_rules.length).toBe(loadSlop(ROOT).static_rules.length);
    expect(r.applied.publish_min).toBeNull();
  }, 30_000);

  test("the retro prompt renders with the recomputed ratchet and usage report", () => {
    const text = renderRetroPrompt({ weekEnding: "2026-11-22", outputPath: join(tmp, "retro.json"), ledger: [], usagePath: join(tmp, "no-usage.jsonl") });
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(text).toContain('{"current_publish_min":72,"median_30d":null,"publish_min":72}');
    expect(text).toContain(join(tmp, "retro.json"));
  });

  test("a schema-invalid retro changes nothing", () => {
    const dir = configCopy("invalid");
    const before = readFileSync(join(dir, "config", "curriculum.yml"), "utf8");
    const retro = { ...goodRetro(), curriculum_additions: [] };
    const r = applyRetro({ retro, configRoot: dir, ledger: [], usagePath: join(tmp, "no-usage.jsonl") });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "config", "curriculum.yml"), "utf8")).toBe(before);
  });
});

describe("monthly-showcase", () => {
  const ledger = [
    ledgerRow("2026-10-31", "published", 99),
    ledgerRow("2026-11-01", "published", 80),
    ledgerRow("2026-11-02", "shelved", 95),
    ledgerRow("2026-11-03", "b-side", 70),
    ledgerRow("2026-11-04", "published", 91),
    ledgerRow("2026-11-05", "published", 80),
    ledgerRow("2026-11-06", "published", 75),
    ledgerRow("2026-11-07", "published", 77),
    ledgerRow("2026-11-08", "published", 74),
    ledgerRow("2026-12-01", "published", 98),
  ];

  test("picks the month's top published scores, best first, shelved and B-sides excluded", () => {
    expect(selectShowcase(ledger, "2026-11").map((e) => e.date)).toEqual(["2026-11-04", "2026-11-01", "2026-11-05", "2026-11-07", "2026-11-06"]);
    expect(selectShowcase(ledger, "2026-11", 2).map((e) => e.score)).toEqual([91, 80]);
    expect(selectShowcase(ledger, "2026-09")).toEqual([]);
    expect(() => selectShowcase(ledger, "2026-13")).toThrow(/YYYY-MM/);
    expect(previousMonth(new Date("2026-12-01T04:00:00Z"))).toBe("2026-11");
    expect(previousMonth(new Date("2027-01-01T04:00:00Z"))).toBe("2026-12");
  });

  test("writes site/monthly/<month>/ with escaped titles from meta.json", () => {
    const site = join(tmp, "site");
    mkdirSync(join(site, "pieces", "2026-11-04"), { recursive: true });
    writeFileSync(join(site, "pieces", "2026-11-04", "meta.json"), JSON.stringify({ brief: { title: "Tides <b>&</b>" }, liner_note: "A note." }));
    writeFileSync(join(site, "pieces", "2026-11-04", "shot-08s.png"), "");
    const entries = buildMonthlyShowcase({ month: "2026-11", ledger, siteDir: site });
    expect(entries[0]).toMatchObject({ rank: 1, date: "2026-11-04", title: "Tides <b>&</b>", thumbnail: "../../pieces/2026-11-04/shot-08s.png" });
    expect(entries[1]!.thumbnail).toBeNull();
    const html = readFileSync(join(site, "monthly", "2026-11", "index.html"), "utf8");
    expect(html).toContain("Tides &lt;b&gt;&amp;&lt;/b&gt;");
    expect(html).not.toContain("2026-11-02");
    expect(JSON.parse(readFileSync(join(site, "monthly", "2026-11", "showcase.json"), "utf8")).entries).toHaveLength(5);
  });
});
