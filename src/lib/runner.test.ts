import { describe, it, expect } from "vitest";
import { detectSkillUsage, isThrottled, isTransientError, shouldRetryRun } from "./runner.js";

// ---------------------------------------------------------------------------
// detectSkillUsage
// ---------------------------------------------------------------------------
describe("detectSkillUsage", () => {
  it("detects skill(name) in response", () => {
    expect(detectSkillUsage(null, "called skill(m365-agent-developer)")).toBe(true);
  });

  it("detects skill(name) with different skill name", () => {
    expect(detectSkillUsage(null, "skill(my-custom-skill)")).toBe(true);
  });

  it("detects skill(name) embedded in longer text", () => {
    const response = "Some text before\nskill(test-skill)\nsome text after";
    expect(detectSkillUsage(null, response)).toBe(true);
  });

  it('detects "name": "skill" in session log', () => {
    const log = JSON.stringify({
      function: { name: "skill", arguments: '{"skill":"test"}' },
    });
    expect(detectSkillUsage(log, "")).toBe(true);
  });

  it('detects "name": "skill" with extra spacing', () => {
    const log = '"name":  "skill"';
    expect(detectSkillUsage(log, "")).toBe(true);
  });

  it("returns false when no skill used", () => {
    expect(detectSkillUsage(null, "just some regular output")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(detectSkillUsage("", "")).toBe(false);
  });

  it("returns false for null session log and empty response", () => {
    expect(detectSkillUsage(null, "")).toBe(false);
  });

  it("is case insensitive for skill() pattern", () => {
    expect(detectSkillUsage(null, "SKILL(test)")).toBe(true);
    expect(detectSkillUsage(null, "Skill(test)")).toBe(true);
  });

  it("detects skill in session log even with empty response", () => {
    expect(detectSkillUsage('"name": "skill"', "")).toBe(true);
  });

  it("detects skill in response even with null session log", () => {
    expect(detectSkillUsage(null, "skill(agent)")).toBe(true);
  });

  it("detects skill when present in both log and response", () => {
    expect(detectSkillUsage('"name": "skill"', "skill(agent)")).toBe(true);
  });

  it("returns false for partial matches that look like skill", () => {
    // skill() with empty parens — regex requires .+ so at least one char
    expect(detectSkillUsage(null, "skill()")).toBe(false);
  });

  it("returns false for 'skilled' without parentheses", () => {
    expect(detectSkillUsage(null, "the skilled worker")).toBe(false);
  });

  it("detects skill in multi-line session log", () => {
    const log = `line 1
line 2
"name": "skill"
line 4`;
    expect(detectSkillUsage(log, "")).toBe(true);
  });

  it("detects skill in multi-line response", () => {
    const response = `Starting task...
Using skill(m365-agent-developer) to scaffold
Done.`;
    expect(detectSkillUsage(null, response)).toBe(true);
  });

  it("returns false for 'name' field with different value", () => {
    expect(detectSkillUsage('"name": "bash"', "")).toBe(false);
  });

  it("returns false for skill mentioned without function call syntax", () => {
    expect(detectSkillUsage(null, "the skill is m365-agent-developer")).toBe(false);
  });

  it("detects skill with single-char name", () => {
    expect(detectSkillUsage(null, "skill(x)")).toBe(true);
  });

  it("detects skill with numeric name", () => {
    expect(detectSkillUsage(null, "skill(123)")).toBe(true);
  });

  it("handles very long session log", () => {
    const longLog = "x".repeat(100_000) + '"name": "skill"';
    expect(detectSkillUsage(longLog, "")).toBe(true);
  });

  it("handles very long response", () => {
    const longResponse = "x".repeat(100_000) + "skill(test)";
    expect(detectSkillUsage(null, longResponse)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isThrottled
// ---------------------------------------------------------------------------
describe("isThrottled", () => {
  it("detects 'rate limit' in response", () => {
    expect(isThrottled("Error: rate limit exceeded")).toBe(true);
  });

  it("detects 'rate-limit' with hyphen", () => {
    expect(isThrottled("rate-limit reached")).toBe(true);
  });

  it("detects 'Rate Limit' case insensitive", () => {
    expect(isThrottled("Rate Limit Exceeded")).toBe(true);
  });

  it("detects 'rateLimit' camelCase", () => {
    expect(isThrottled("rateLimit error")).toBe(true);
  });

  it("detects 'throttled'", () => {
    expect(isThrottled("Request was throttled")).toBe(true);
  });

  it("detects 'throttling'", () => {
    expect(isThrottled("throttling in effect")).toBe(true);
  });

  it("detects 'Throttle' case insensitive", () => {
    expect(isThrottled("Throttle limit reached")).toBe(true);
  });

  it("detects HTTP 429 status code", () => {
    expect(isThrottled("HTTP 429 Too Many Requests")).toBe(true);
  });

  it("detects standalone 429", () => {
    expect(isThrottled("Error: 429")).toBe(true);
  });

  it("does not match 429 inside larger numbers", () => {
    expect(isThrottled("port 4291 is in use")).toBe(false);
  });

  it("detects 'too many requests'", () => {
    expect(isThrottled("too many requests")).toBe(true);
  });

  it("detects 'Too Many Requests' case insensitive", () => {
    expect(isThrottled("Too Many Requests")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isThrottled("Successfully created the project")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isThrottled("")).toBe(false);
  });

  it("returns false for unrelated error messages", () => {
    expect(isThrottled("ENOENT: no such file or directory")).toBe(false);
  });

  it("returns false for unrelated numeric content", () => {
    expect(isThrottled("Created 42 files in 3 seconds")).toBe(false);
  });

  it("detects throttle in multi-line output", () => {
    const output = "Starting...\nError: rate limit exceeded\nDone.";
    expect(isThrottled(output)).toBe(true);
  });

  it("detects throttle in long output", () => {
    const output = "x".repeat(10_000) + " rate limit " + "y".repeat(10_000);
    expect(isThrottled(output)).toBe(true);
  });

  it("detects 'too many requests' embedded in JSON", () => {
    const output = '{"error": {"message": "Too Many Requests", "code": 429}}';
    expect(isThrottled(output)).toBe(true);
  });

  it("returns false for 'skill' or 'limit' alone", () => {
    expect(isThrottled("the skill has a limit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------
describe("isTransientError", () => {
  it("detects CAPiError", () => {
    expect(isTransientError("CAPiError: upstream failure")).toBe(true);
  });

  it("detects ECONNRESET", () => {
    expect(isTransientError("Error: ECONNRESET")).toBe(true);
  });

  it("detects ETIMEDOUT", () => {
    expect(isTransientError("ETIMEDOUT connecting to host")).toBe(true);
  });

  it("detects ECONNREFUSED", () => {
    expect(isTransientError("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
  });

  it("detects EPIPE", () => {
    expect(isTransientError("write EPIPE")).toBe(true);
  });

  it("detects 'socket hang up'", () => {
    expect(isTransientError("socket hang up")).toBe(true);
  });

  it("does NOT match 'internal server error' narrated by the agent", () => {
    const narrated =
      "⚠️ Provisioning hit a transient Microsoft 365 500 Internal Server Error. Retry later.";
    expect(isTransientError(narrated)).toBe(false);
  });

  it("does NOT match bare HTTP status codes narrated by the agent", () => {
    expect(isTransientError("server returned 502 Bad Gateway")).toBe(false);
    expect(isTransientError("503 service unavailable")).toBe(false);
    expect(isTransientError("504 gateway timeout")).toBe(false);
  });

  it("does NOT match 'service unavailable' narrated by the agent", () => {
    expect(isTransientError("The service is currently unavailable")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isTransientError("")).toBe(false);
  });

  it("returns false for a successful response", () => {
    expect(isTransientError("✅ Agent validated successfully")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldRetryRun
// ---------------------------------------------------------------------------
describe("shouldRetryRun", () => {
  it("does NOT retry on clean exit, even if agent narrates a backend error", () => {
    const narrated =
      "Validation passed. ⚠️ Provisioning hit a transient 500 Internal Server Error. Retry later.";
    expect(shouldRetryRun(narrated, 0)).toBe(false);
  });

  it("does NOT retry on clean exit with empty response", () => {
    // Clean exit implies the CLI finished intentionally; trust it.
    expect(shouldRetryRun("", 0)).toBe(false);
  });

  it("retries on non-zero exit with transient signature", () => {
    expect(shouldRetryRun("ECONNRESET while streaming", 1)).toBe(true);
  });

  it("retries on non-zero exit with empty/short response (CLI crash)", () => {
    expect(shouldRetryRun("", 1)).toBe(true);
    expect(shouldRetryRun("short", 1)).toBe(true);
  });

  it("does NOT retry on non-zero exit with a non-transient, substantive response", () => {
    // CLI exited with an error but produced a real response — likely a
    // skill-side failure the judge should evaluate, not an infra flake.
    const response = "a".repeat(200) + " skill failed with validation errors";
    expect(shouldRetryRun(response, 1)).toBe(false);
  });

  it("retries when exitCode is null (process never closed / crashed)", () => {
    expect(shouldRetryRun("", null)).toBe(true);
  });
});
