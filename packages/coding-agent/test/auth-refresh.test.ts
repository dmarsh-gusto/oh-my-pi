/**
 * Tests for the auth-refresh runner used by the auto-retry path. We exercise
 * the runner via its injectable `spawn` option so the suite never shells out
 * to a real process.
 */
import { describe, expect, test } from "bun:test";
import {
	AuthRefreshRunner,
	type AuthRefreshSpawnFn,
	isAuthErrorMessage,
	selectAuthRefreshCommand,
} from "@oh-my-pi/pi-coding-agent/session/auth-refresh";

class FakeChild {
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number>;
	killed = false;
	#stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	#stderrController!: ReadableStreamDefaultController<Uint8Array>;
	#exitResolve!: (code: number) => void;
	#exited = false;

	constructor() {
		this.exited = new Promise<number>(resolve => {
			this.#exitResolve = resolve;
		});
		this.stdout = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#stdoutController = controller;
			},
		});
		this.stderr = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#stderrController = controller;
			},
		});
	}

	writeStdout(text: string): void {
		this.#stdoutController.enqueue(new TextEncoder().encode(text));
	}

	writeStderr(text: string): void {
		this.#stderrController.enqueue(new TextEncoder().encode(text));
	}

	exit(code: number): void {
		if (this.#exited) return;
		this.#exited = true;
		try {
			this.#stdoutController.close();
		} catch {}
		try {
			this.#stderrController.close();
		} catch {}
		this.#exitResolve(code);
	}

	kill(): void {
		this.killed = true;
		this.exit(143); // SIGTERM convention
	}
}

function spawnReturning(child: FakeChild, opts?: { onSignal?: (signal: AbortSignal) => void }): AuthRefreshSpawnFn {
	return (_cmd, options) => {
		if (options.signal) opts?.onSignal?.(options.signal);
		options.signal?.addEventListener("abort", () => child.kill());
		return child;
	};
}

describe("AuthRefreshRunner", () => {
	test("returns ok=true and reports duration when the command exits cleanly", async () => {
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });

		const refreshPromise = runner.refresh({
			provider: "amazon-bedrock",
			command: "noop",
			timeoutMs: 5_000,
		});
		// Let the runner attach its readers before we feed data.
		await Bun.sleep(0);
		child.exit(0);

		const outcome = await refreshPromise;
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	test("streams stdout and stderr lines through onOutput before resolving", async () => {
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });
		const lines: Array<{ stream: string; line: string }> = [];

		const refreshPromise = runner.refresh({
			provider: "amazon-bedrock",
			command: "noop",
			timeoutMs: 5_000,
			onOutput: (line, stream) => lines.push({ stream, line }),
		});
		await Bun.sleep(0);
		child.writeStdout("opening browser...\n");
		child.writeStderr("info: waiting for callback\n");
		child.writeStdout("Successfully logged in\n");
		child.exit(0);

		const outcome = await refreshPromise;
		expect(outcome.ok).toBe(true);
		expect(lines).toEqual([
			{ stream: "stdout", line: "opening browser..." },
			{ stream: "stderr", line: "info: waiting for callback" },
			{ stream: "stdout", line: "Successfully logged in" },
		]);
	});

	test("emits the trailing partial line when the command exits without a newline", async () => {
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });
		const lines: string[] = [];

		const refreshPromise = runner.refresh({
			provider: "amazon-bedrock",
			command: "noop",
			timeoutMs: 5_000,
			onOutput: line => lines.push(line),
		});
		await Bun.sleep(0);
		child.writeStdout("token-refresh-complete"); // no trailing newline
		child.exit(0);

		await refreshPromise;
		expect(lines).toEqual(["token-refresh-complete"]);
	});

	test("returns ok=false with exit code on non-zero exit", async () => {
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });

		const refreshPromise = runner.refresh({
			provider: "anthropic",
			command: "fail-it",
			timeoutMs: 5_000,
		});
		await Bun.sleep(0);
		child.writeStderr("error: device flow rejected\n");
		child.exit(7);

		const outcome = await refreshPromise;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.exitCode).toBe(7);
			expect(outcome.reason).toContain("exit");
			expect(outcome.reason).toContain("7");
		}
	});

	test("kills the child and returns a timeout reason when timeoutMs elapses", async () => {
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });

		const outcome = await runner.refresh({
			provider: "amazon-bedrock",
			command: "stalls-forever",
			timeoutMs: 25,
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toMatch(/timed out/i);
		}
		expect(child.killed).toBe(true);
	});

	test("propagates a parent abort signal to the child without launching", async () => {
		const ac = new AbortController();
		ac.abort(new Error("session shutdown"));
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });

		const outcome = await runner.refresh({
			provider: "anthropic",
			command: "noop",
			timeoutMs: 5_000,
			signal: ac.signal,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toMatch(/aborted/i);
		}
	});

	test("aborting mid-flight kills the child and surfaces the abort reason", async () => {
		const ac = new AbortController();
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });

		const refreshPromise = runner.refresh({
			provider: "anthropic",
			command: "noop",
			timeoutMs: 60_000,
			signal: ac.signal,
		});
		await Bun.sleep(0);
		ac.abort(new Error("user cancelled"));

		const outcome = await refreshPromise;
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toMatch(/user cancelled|aborted/i);
		}
		expect(child.killed).toBe(true);
	});

	test("single-flight: concurrent refreshes for the same command share one launch", async () => {
		let spawnCount = 0;
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({
			spawn: (_cmd, options) => {
				spawnCount += 1;
				options.signal?.addEventListener("abort", () => child.kill());
				return child;
			},
		});

		const p1 = runner.refresh({ provider: "p", command: "shared-cmd", timeoutMs: 5_000 });
		const p2 = runner.refresh({ provider: "p", command: "shared-cmd", timeoutMs: 5_000 });
		await Bun.sleep(0);
		child.exit(0);

		const [r1, r2] = await Promise.all([p1, p2]);
		expect(spawnCount).toBe(1);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
	});

	test("different commands launch independently and do not share single-flight slots", async () => {
		const launches: string[] = [];
		const childA = new FakeChild();
		const childB = new FakeChild();
		const runner = new AuthRefreshRunner({
			spawn: (cmd, options) => {
				launches.push(cmd.join(" "));
				const child = cmd.includes("cmd-a") ? childA : childB;
				options.signal?.addEventListener("abort", () => child.kill());
				return child;
			},
		});

		const pA = runner.refresh({ provider: "p", command: "cmd-a", timeoutMs: 5_000 });
		const pB = runner.refresh({ provider: "p", command: "cmd-b", timeoutMs: 5_000 });
		await Bun.sleep(0);
		childA.exit(0);
		childB.exit(0);
		await Promise.all([pA, pB]);

		expect(launches.length).toBe(2);
	});

	test("subsequent refresh after success starts a fresh shell-out", async () => {
		let spawnCount = 0;
		const runner = new AuthRefreshRunner({
			spawn: (_cmd, options) => {
				const child = new FakeChild();
				spawnCount += 1;
				options.signal?.addEventListener("abort", () => child.kill());
				queueMicrotask(() => child.exit(0));
				return child;
			},
		});

		await runner.refresh({ provider: "p", command: "same-cmd", timeoutMs: 1_000 });
		await runner.refresh({ provider: "p", command: "same-cmd", timeoutMs: 1_000 });

		expect(spawnCount).toBe(2);
	});

	test("returns ok=false when spawn itself throws", async () => {
		const runner = new AuthRefreshRunner({
			spawn: () => {
				throw new Error("ENOENT: sh not found");
			},
		});

		const outcome = await runner.refresh({
			provider: "anthropic",
			command: "noop",
			timeoutMs: 5_000,
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toContain("failed to launch");
			expect(outcome.reason).toContain("ENOENT");
		}
	});

	test("subscriber exceptions in onOutput do not break the pump", async () => {
		const child = new FakeChild();
		const runner = new AuthRefreshRunner({ spawn: spawnReturning(child) });
		const goodLines: string[] = [];

		const refreshPromise = runner.refresh({
			provider: "anthropic",
			command: "noop",
			timeoutMs: 5_000,
			onOutput: line => {
				if (line === "boom") throw new Error("subscriber blew up");
				goodLines.push(line);
			},
		});
		await Bun.sleep(0);
		child.writeStdout("first\nboom\nthird\n");
		child.exit(0);

		const outcome = await refreshPromise;
		expect(outcome.ok).toBe(true);
		expect(goodLines).toEqual(["first", "third"]);
	});
});

describe("isAuthErrorMessage", () => {
	test("matches OAuth refresh-failure shapes", () => {
		expect(isAuthErrorMessage('HTTP 400 invalid_grant {"error":"invalid_grant"}')).toBe(true);
		expect(isAuthErrorMessage("invalid_token: token has been revoked")).toBe(true);
		expect(isAuthErrorMessage("expired refresh token")).toBe(true);
	});

	test("matches AWS Bedrock SigV4 / SSO shapes", () => {
		expect(isAuthErrorMessage("ExpiredTokenException: The security token included in the request is expired")).toBe(
			true,
		);
		expect(isAuthErrorMessage("UnrecognizedClientException: The security token is invalid")).toBe(true);
		expect(isAuthErrorMessage("CredentialsProviderError: Could not load credentials from any providers")).toBe(true);
		expect(isAuthErrorMessage("sso session expired")).toBe(true);
	});

	test("matches HTTP 401/403 status text without a network blip", () => {
		expect(isAuthErrorMessage("HTTP 401 Unauthorized: invalid bearer")).toBe(true);
		expect(isAuthErrorMessage("upstream returned 403 Forbidden")).toBe(true);
	});

	test("does NOT match validation errors that share the 401/403 token vocabulary", () => {
		expect(isAuthErrorMessage("invalid_request: missing required parameter `model`")).toBe(false);
		expect(isAuthErrorMessage("model_not_found: gpt-9.9 is not available")).toBe(false);
		expect(isAuthErrorMessage("schema validation failed: extra field 'foo'")).toBe(false);
	});

	test("does NOT match 401/403 surfaced through a network blip", () => {
		expect(isAuthErrorMessage("fetch failed (401 timeout reading body)")).toBe(false);
		expect(isAuthErrorMessage("ECONNRESET: 403 connection reset by peer")).toBe(false);
	});

	test("returns false for empty / null-ish input", () => {
		expect(isAuthErrorMessage("")).toBe(false);
	});
});

describe("selectAuthRefreshCommand", () => {
	test("returns the provider-specific command when set", () => {
		expect(
			selectAuthRefreshCommand(
				{ "amazon-bedrock": "aws sso login --profile bedrock", default: "default-refresh" },
				"amazon-bedrock",
			),
		).toBe("aws sso login --profile bedrock");
	});

	test("falls back to `default` when the provider key is absent", () => {
		expect(selectAuthRefreshCommand({ default: "shared-refresh" }, "anthropic")).toBe("shared-refresh");
	});

	test("returns undefined when neither the provider nor `default` is configured", () => {
		expect(selectAuthRefreshCommand({}, "anthropic")).toBeUndefined();
		expect(selectAuthRefreshCommand(undefined, "anthropic")).toBeUndefined();
	});

	test("treats an empty / whitespace-only command string as not configured", () => {
		expect(selectAuthRefreshCommand({ anthropic: "   " }, "anthropic")).toBeUndefined();
		expect(selectAuthRefreshCommand({ default: "" }, "anthropic")).toBeUndefined();
	});

	test("returns undefined when no provider is supplied and no `default` is set", () => {
		expect(selectAuthRefreshCommand({ anthropic: "x" }, undefined)).toBeUndefined();
	});

	test("uses the default fallback when no provider is supplied", () => {
		expect(selectAuthRefreshCommand({ default: "fallback" }, undefined)).toBe("fallback");
	});
});
